import type { IRouter, NextFunction, Request, RequestHandler, Response } from 'express'
import type {
  Application,
  ControlOutcome,
  RuleEntry,
  SaveOutcome,
  SuppressionRequest
} from '../application.js'
import { MAX_DURATION_S } from '../model/rule.js'
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
      ...(skar === undefined ? {} : { evaluation: skar.evaluation, issues: skar.issues })
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
    '/evaluation',
    running((skar, _req, res) => {
      res.json(skar.evaluation)
    })
  )

  router.put(
    '/evaluation',
    requireJson,
    running((skar, req, res) => {
      const body: unknown = req.body
      if (!isRecord(body) || typeof body.enabled !== 'boolean') {
        invalid(res, [{ path: '/enabled', message: 'must be a boolean' }])
        return
      }
      skar.setEvaluation(body.enabled, actorOf(req))
      res.json(skar.evaluation)
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

  router.put(
    '/rules/:origin/:slug/enabled',
    requireJson,
    running((skar, req, res) => {
      const body: unknown = req.body
      if (!isRecord(body) || typeof body.enabled !== 'boolean') {
        invalid(res, [{ path: '/enabled', message: 'must be a boolean' }])
        return
      }
      const { origin, slug } = req.params
      controlled(res, skar, skar.setEnabled(origin, slug, body.enabled, actorOf(req)), origin, slug)
    })
  )

  router.put(
    '/rules/:origin/:slug/note',
    requireJson,
    running((skar, req, res) => {
      const body: unknown = req.body
      const note = isRecord(body) ? body.note : undefined
      if (!isNote(note)) {
        invalid(res, [NOTE_ERROR])
        return
      }
      const { origin, slug } = req.params
      controlled(res, skar, skar.setNote(origin, slug, note, actorOf(req)), origin, slug)
    })
  )

  router.get(
    '/suppressions',
    running((skar, _req, res) => {
      res.json(skar.suppressions())
    })
  )

  router.put(
    '/suppressions/rules/:origin/:slug',
    requireJson,
    running((skar, req, res) => {
      const request = suppressionRequest(req.body)
      if (!request.ok) {
        invalid(res, request.errors)
        return
      }
      const { origin, slug } = req.params
      const outcome = skar.suppressRule(origin, slug, request.value, actorOf(req))
      controlled(res, skar, outcome, origin, slug)
    })
  )

  router.delete(
    '/suppressions/rules/:origin/:slug',
    requireJson,
    running((skar, req, res) => {
      const { origin, slug } = req.params
      if (skar.endRuleSuppression(origin, slug, actorOf(req)) === 'ok') res.status(204).end()
      else notFound(res, 'such rule')
    })
  )

  router.put(
    '/suppressions/inputs/:path',
    requireJson,
    running((skar, req, res) => {
      const { path } = req.params
      const request = suppressionRequest(req.body)
      const errors = [...pathErrors(path), ...(request.ok ? [] : request.errors)]
      if (!request.ok || errors.length > 0) {
        invalid(res, errors)
        return
      }
      res.json(skar.suppressInput(path, request.value, actorOf(req)))
    })
  )

  router.delete(
    '/suppressions/inputs/:path',
    requireJson,
    running((skar, req, res) => {
      // Ending one that has already ended, as by its auto-end, is not an error.
      skar.endInputSuppression(req.params.path, actorOf(req))
      res.status(204).end()
    })
  )

  router.get(
    '/suppressions/inputs/:path/preview',
    running((skar, req, res) => {
      const { path } = req.params
      const errors = pathErrors(path)
      if (errors.length > 0) invalid(res, errors)
      else res.json(skar.previewInputSuppression(path))
    })
  )
}

const MAX_NOTE_LENGTH = 500
const MAX_PATH_LENGTH = 255
// Dot-separated segments without a wildcard: an input suppression names one exact path.
const CONCRETE_PATH = /^[^.\s*]+(\.[^.\s*]+)*$/
const SUPPRESSION_FIELDS: readonly string[] = ['note', 'autoEndAfter']
const notAnObject: ValidationError[] = [{ path: '', message: 'must be an object' }]

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

function pathErrors(path: string): ValidationError[] {
  return path.length <= MAX_PATH_LENGTH && CONCRETE_PATH.test(path)
    ? []
    : [
        {
          path: '/path',
          message: `must be a path of dot-separated segments without a wildcard, at most ${String(MAX_PATH_LENGTH)} characters`
        }
      ]
}

const NOTE_ERROR: ValidationError = {
  path: '/note',
  message: `must be a string of at most ${String(MAX_NOTE_LENGTH)} characters`
}

function isNote(note: unknown): note is string {
  return typeof note === 'string' && note.length <= MAX_NOTE_LENGTH
}

function suppressionRequest(
  body: unknown
): { ok: true; value: SuppressionRequest } | { ok: false; errors: ValidationError[] } {
  if (!isRecord(body)) return { ok: false, errors: notAnObject }
  const errors = Object.keys(body)
    .filter((key) => !SUPPRESSION_FIELDS.includes(key))
    .map((key) => ({ path: `/${escapePointer(key)}`, message: 'is not a known field' }))
  const { note, autoEndAfter } = body
  if (note !== undefined && !isNote(note)) errors.push(NOTE_ERROR)
  const autoEndValid =
    autoEndAfter === undefined ||
    (typeof autoEndAfter === 'number' && autoEndAfter > 0 && autoEndAfter <= MAX_DURATION_S)
  if (!autoEndValid) {
    errors.push({
      path: '/autoEndAfter',
      message: `must be a number of seconds above 0 and at most ${String(MAX_DURATION_S)}`
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      ...(typeof note === 'string' ? { note } : {}),
      ...(typeof autoEndAfter === 'number' ? { autoEndAfter } : {})
    }
  }
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
