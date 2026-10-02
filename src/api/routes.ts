import type { AccessScopedRouter, PluginRouter, RouteAccessLevel } from '@signalk/server-api'
import type { IRouter, NextFunction, Request, RequestHandler, Response } from 'express'
import {
  alertPathOverlap,
  type Application,
  type ControlOutcome,
  type ListedRule,
  type SaveOutcome
} from '../application.js'
import type { ValidationError } from '../model/validate.js'
import { errorMessage, isRecord } from '../util.js'

/** The actor recorded for a request that carries no authenticated user. */
export const UNAUTHENTICATED = 'unauthenticated'

/** Facts about the plugin that hold whether or not it is running. */
export interface PluginState {
  /** Why the plugin is not running, when it failed to start. */
  error?: string
  /** Whether the server enforces security; null when it cannot be told. */
  securityEnabled: boolean | null
}

export interface ApiContext {
  /** The running application; undefined while the plugin is stopped or failed to start. */
  application: () => Application | undefined
  state: () => PluginState
}

/** What the caller may do: `admin` everything, `readwrite` also disable and enable rules, `readonly` read. */
export type Permissions = 'admin' | RouteAccessLevel

// The server authenticates a request before it reaches a plugin route and
// puts the user on it (signalk-server src/tokensecurity.ts: SKRequest,
// `skPrincipal` set where a token is verified). With security disabled
// there is no principal.
interface AuthenticatedRequest {
  skPrincipal?: { identifier?: unknown; permissions?: unknown }
}

function principalOf(req: Request): AuthenticatedRequest['skPrincipal'] {
  return (req as Request & AuthenticatedRequest).skPrincipal
}

function actorOf(req: Request): string {
  const identifier = principalOf(req)?.identifier
  return typeof identifier === 'string' ? identifier : UNAUTHENTICATED
}

// With security disabled every route is open to every caller. A level the
// server does not define is shown as the least, so the webapp offers no
// control the server might refuse.
function permissionsOf(req: Request): Permissions {
  const principal = principalOf(req)
  if (principal === undefined) return 'admin'
  const { permissions } = principal
  return permissions === 'admin' || permissions === 'readwrite' ? permissions : 'readonly'
}

/**
 * Refuses a mutating request that does not declare a JSON body. A browser
 * sends a cross-site form post without asking, but must ask before sending
 * `application/json`, so this keeps another site from acting through an
 * admin's session. The header is read directly because express's `req.is`
 * ignores it on a request without a body, such as a delete.
 */
function requireJson(req: Request, res: Response, next: NextFunction): void {
  const type = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'application/json') {
    next()
    return
  }
  res.status(415).json({ error: 'the request must have Content-Type: application/json' })
}

function invalid(res: Response, errors: ValidationError[]): void {
  res.status(400).json({ error: 'invalid request body', errors })
}

function notFound(res: Response, what: string): void {
  res.status(404).json({ error: `no ${what}` })
}

/**
 * Registers SKAR's REST API on the plugin router. Handlers are thin: the
 * behaviour lives in `Application`. Reads are opened to read-only users and
 * rule controls to read/write users through the router's `access()`; the
 * rest is registered directly, which the server keeps admin-only while
 * security is enabled (signalk-server src/tokensecurity.ts,
 * `pluginAuthenticationMiddleware`). A server older than 2.31 has no
 * `access()`, and there every route is registered directly. The router
 * outlives the plugin, so every route but `/state` answers 503 while the
 * plugin is not running.
 *
 * @returns whether lower levels were opened, false on a server without `access()`.
 */
export function registerRoutes(
  router: IRouter & Partial<Pick<PluginRouter, 'access'>>,
  ctx: ApiContext
): boolean {
  const { access } = router
  const opensLevels = typeof access === 'function'
  const at = (level: RouteAccessLevel): AccessScopedRouter =>
    opensLevels ? access.call(router, level) : router
  const readonly = at('readonly')
  const readwrite = at('readwrite')

  const running =
    (handler: (skar: Application, req: Request, res: Response) => void): RequestHandler =>
    (req, res) => {
      const skar = ctx.application()
      if (skar === undefined) {
        res.status(503).json({ error: 'the plugin is not running', ...ctx.state() })
        return
      }
      try {
        handler(skar, req, res)
      } catch (err) {
        res.status(500).json({ error: errorMessage(err) })
      }
    }

  const respondSaved = (
    res: Response,
    skar: Application,
    outcome: SaveOutcome,
    created: boolean
  ) => {
    if (outcome.ok) {
      res.status(created ? 201 : 200).json(skar.rule(outcome.value.slug))
      return
    }
    editRefused(res, outcome)
  }

  readonly.get('/state', (req, res) => {
    const skar = ctx.application()
    res.json({
      running: skar !== undefined,
      ...ctx.state(),
      permissions: permissionsOf(req),
      ...(skar === undefined ? {} : { issues: skar.issues })
    })
  })

  readonly.get(
    '/rules',
    running((skar, _req, res) => {
      res.json(skar.rules())
    })
  )

  router.post(
    '/rules',
    requireJson,
    running((skar, req, res) => {
      respondSaved(res, skar, skar.createRule(req.body), true)
    })
  )

  readonly.get(
    '/rules/:slug',
    running((skar, req, res) => {
      const entry: ListedRule | undefined = skar.rule(req.params.slug)
      if (entry === undefined) notFound(res, 'such rule')
      else res.json(entry)
    })
  )

  router.put(
    '/rules/:slug',
    requireJson,
    running((skar, req, res) => {
      respondSaved(res, skar, skar.replaceRule(req.params.slug, req.body), false)
    })
  )

  router.post(
    '/rules/:slug/preview',
    requireJson,
    running((skar, req, res) => {
      const outcome = skar.previewRule(req.params.slug, req.body)
      if (outcome.ok) res.json(outcome.value)
      else editRefused(res, outcome)
    })
  )

  router.delete(
    '/rules/:slug',
    requireJson,
    running((skar, req, res) => {
      if (skar.deleteRule(req.params.slug, actorOf(req))) res.status(204).end()
      else notFound(res, 'such rule')
    })
  )

  router.post(
    '/rules/:slug/reset',
    requireJson,
    running((skar, req, res) => {
      const { slug } = req.params
      switch (skar.resetAccumulator(slug, actorOf(req))) {
        case 'reset':
          res.json(skar.rule(slug))
          break
        case 'notFound':
          notFound(res, 'such rule')
          break
        case 'notAccumulator':
          res.status(400).json({ error: 'only an accumulator rule can be reset' })
      }
    })
  )

  readonly.get(
    '/log',
    running((skar, _req, res) => {
      res.json(skar.log())
    })
  )

  const controlled = (res: Response, skar: Application, outcome: ControlOutcome, slug: string) => {
    if (outcome === 'ok') res.json(skar.rule(slug))
    else notFound(res, 'such rule')
  }

  readwrite.post(
    '/rules/:slug/disable',
    requireJson,
    running((skar, req, res) => {
      const request = disableRequest(req.body)
      if (!request.ok) {
        invalid(res, request.errors)
        return
      }
      const { slug } = req.params
      controlled(res, skar, skar.disableRule(slug, request.note, actorOf(req)), slug)
    })
  )

  readwrite.post(
    '/rules/:slug/enable',
    requireJson,
    running((skar, req, res) => {
      const { slug } = req.params
      controlled(res, skar, skar.enableRule(slug, actorOf(req)), slug)
    })
  )

  readonly.get(
    '/templates',
    running((skar, _req, res) => {
      res.json(skar.templates())
    })
  )

  router.post(
    '/templates/dismiss',
    requireJson,
    running((skar, _req, res) => {
      res.json(skar.dismissTemplates())
    })
  )
  return opensLevels
}

const MAX_NOTE_LENGTH = 500
const DISABLE_FIELDS: readonly string[] = ['note']
const notAnObject: ValidationError[] = [{ path: '', message: 'must be an object' }]

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

const NOTE_ERROR: ValidationError = {
  path: '/note',
  message: `must be a string of at most ${String(MAX_NOTE_LENGTH)} characters`
}

function isNote(note: unknown): note is string {
  return typeof note === 'string' && note.length <= MAX_NOTE_LENGTH
}

/** A disable request's body, which may be left out. */
function disableRequest(
  body: unknown
): { ok: true; note?: string } | { ok: false; errors: ValidationError[] } {
  if (body === undefined) return { ok: true }
  if (!isRecord(body)) return { ok: false, errors: notAnObject }
  const errors = Object.keys(body)
    .filter((key) => !DISABLE_FIELDS.includes(key))
    .map((key) => ({ path: `/${escapePointer(key)}`, message: 'is not a known field' }))
  const { note } = body
  if (note !== undefined && !isNote(note)) errors.push(NOTE_ERROR)
  if (errors.length > 0) return { ok: false, errors }
  return typeof note === 'string' ? { ok: true, note } : { ok: true }
}

function editRefused(res: Response, outcome: Exclude<SaveOutcome, { ok: true }>): void {
  switch (outcome.reason) {
    case 'invalid':
      invalid(res, outcome.errors)
      break
    case 'exists':
      res.status(409).json({ error: 'a rule with this slug exists' })
      break
    case 'notFound':
      notFound(res, 'such rule')
      break
    case 'alertPathTaken':
      res.status(409).json({
        error: 'another rule has this alert path',
        errors: [alertPathOverlap(outcome.holder)]
      })
      break
    case 'slugMismatch':
      res.status(400).json({
        error: "the rule's slug must equal the one in the path",
        errors: [{ path: '/slug', message: 'must equal the slug in the path' }]
      })
  }
}
