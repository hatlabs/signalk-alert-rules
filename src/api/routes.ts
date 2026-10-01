import type { IRouter, NextFunction, Request, RequestHandler, Response } from 'express'
import type { Application, ControlOutcome, RuleEntry, SaveOutcome } from '../application.js'
import { USER_ORIGIN } from '../model/ruleset.js'
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

// The server authenticates a request before it reaches a plugin route and
// puts the user on it (signalk-server src/tokensecurity.ts: SKRequest,
// `skPrincipal` set where a token is verified). With security disabled
// there is no principal.
interface AuthenticatedRequest {
  skPrincipal?: { identifier?: unknown }
}

function actorOf(req: Request): string {
  const principal = (req as Request & AuthenticatedRequest).skPrincipal
  return typeof principal?.identifier === 'string' ? principal.identifier : UNAUTHENTICATED
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
 * behaviour lives in `Application`. Routes are registered directly on the
 * router, which the server keeps admin-only while security is enabled
 * (signalk-server src/tokensecurity.ts, `pluginAuthenticationMiddleware`:
 * a plugin route without an `access()` level goes through the admin
 * check). The router outlives the plugin, so every route but `/state`
 * answers 503 while the plugin is not running.
 */
export function registerRoutes(router: IRouter, ctx: ApiContext): void {
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
      res.status(created ? 201 : 200).json(skar.rule(USER_ORIGIN, outcome.value.slug))
      return
    }
    editRefused(res, outcome)
  }

  router.get('/state', (_req, res) => {
    const skar = ctx.application()
    res.json({
      running: skar !== undefined,
      ...ctx.state(),
      ...(skar === undefined ? {} : { issues: skar.issues })
    })
  })

  router.get(
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

  router.get(
    '/rules/:origin/:slug',
    running((skar, req, res) => {
      const entry: RuleEntry | undefined = skar.rule(req.params.origin, req.params.slug)
      if (entry === undefined) notFound(res, 'such rule')
      else res.json(entry)
    })
  )

  router.put(
    '/rules/user/:slug',
    requireJson,
    running((skar, req, res) => {
      respondSaved(res, skar, skar.replaceRule(req.params.slug, req.body), false)
    })
  )

  router.post(
    '/rules/user/:slug/preview',
    requireJson,
    running((skar, req, res) => {
      const outcome = skar.previewRule(req.params.slug, req.body)
      if (outcome.ok) res.json(outcome.value)
      else editRefused(res, outcome)
    })
  )

  router.delete(
    '/rules/user/:slug',
    requireJson,
    running((skar, req, res) => {
      if (skar.deleteRule(req.params.slug, actorOf(req))) res.status(204).end()
      else notFound(res, 'such rule')
    })
  )

  router.post(
    '/rules/:origin/:slug/reset',
    requireJson,
    running((skar, req, res) => {
      const { origin, slug } = req.params
      switch (skar.resetAccumulator(origin, slug, actorOf(req))) {
        case 'reset':
          res.json(skar.rule(origin, slug))
          break
        case 'notFound':
          notFound(res, 'such rule')
          break
        case 'notAccumulator':
          res.status(400).json({ error: 'only an accumulator rule can be reset' })
      }
    })
  )

  router.get(
    '/log',
    running((skar, _req, res) => {
      res.json(skar.log())
    })
  )

  const controlled = (
    res: Response,
    skar: Application,
    outcome: ControlOutcome,
    origin: string,
    slug: string
  ) => {
    if (outcome === 'ok') res.json(skar.rule(origin, slug))
    else notFound(res, 'such rule')
  }

  router.post(
    '/rules/:origin/:slug/disable',
    requireJson,
    running((skar, req, res) => {
      const request = disableRequest(req.body)
      if (!request.ok) {
        invalid(res, request.errors)
        return
      }
      const { origin, slug } = req.params
      const outcome = skar.disableRule(origin, slug, request.note, actorOf(req))
      controlled(res, skar, outcome, origin, slug)
    })
  )

  router.post(
    '/rules/:origin/:slug/enable',
    requireJson,
    running((skar, req, res) => {
      const { origin, slug } = req.params
      controlled(res, skar, skar.enableRule(origin, slug, actorOf(req)), origin, slug)
    })
  )

  router.get(
    '/rulesets',
    running((skar, _req, res) => {
      res.json(skar.rulesets())
    })
  )

  router.post(
    '/rulesets/rescan',
    requireJson,
    running((skar, req, res) => {
      res.json(skar.rescan(actorOf(req)))
    })
  )

  const rulesetControlled = (
    res: Response,
    skar: Application,
    outcome: ControlOutcome,
    slug: string
  ) => {
    if (outcome === 'ok') res.json(skar.ruleset(slug))
    else notFound(res, 'such ruleset')
  }

  router.put(
    '/rulesets/:slug/enabled',
    requireJson,
    running((skar, req, res) => {
      const body: unknown = req.body
      if (!isRecord(body) || typeof body.enabled !== 'boolean') {
        invalid(res, [{ path: '/enabled', message: 'must be a boolean' }])
        return
      }
      const { slug } = req.params
      rulesetControlled(res, skar, skar.setRulesetEnabled(slug, body.enabled, actorOf(req)), slug)
    })
  )

  router.put(
    '/rulesets/:slug/parameters',
    requireJson,
    running((skar, req, res) => {
      const { slug } = req.params
      const outcome = skar.setRulesetParameters(slug, req.body, actorOf(req))
      if (outcome.ok) res.json(skar.ruleset(slug))
      else if (outcome.reason === 'invalid') invalid(res, outcome.errors)
      else notFound(res, 'such ruleset')
    })
  )

  router.delete(
    '/rulesets/:slug/notices',
    requireJson,
    running((skar, req, res) => {
      if (skar.dismissNotices(req.params.slug, actorOf(req)) === 'ok') res.status(204).end()
      else notFound(res, 'such ruleset')
    })
  )
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
    case 'slugMismatch':
      res.status(400).json({
        error: "the rule's slug must equal the one in the path",
        errors: [{ path: '/slug', message: 'must equal the slug in the path' }]
      })
  }
}
