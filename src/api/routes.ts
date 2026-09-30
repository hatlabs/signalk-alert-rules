import type { IRouter, NextFunction, Request, RequestHandler, Response } from 'express'
import type { Application, RuleEntry, SaveOutcome } from '../application.js'
import { USER_ORIGIN } from '../model/ruleset.js'
import type { ValidationError } from '../model/validate.js'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    (handler: (app: Application, req: Request, res: Response) => void): RequestHandler =>
    (req, res) => {
      const app = ctx.application()
      if (app === undefined) {
        res.status(503).json({ error: 'the plugin is not running', ...ctx.state() })
        return
      }
      try {
        handler(app, req, res)
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
      }
    }

  const saved = (res: Response, app: Application, outcome: SaveOutcome, created: boolean) => {
    if (outcome.ok) {
      res.status(created ? 201 : 200).json(app.rule(USER_ORIGIN, outcome.value.slug))
      return
    }
    editRefused(res, outcome)
  }

  router.get('/state', (_req, res) => {
    const app = ctx.application()
    res.json({
      running: app !== undefined,
      ...ctx.state(),
      ...(app === undefined ? {} : { evaluation: app.evaluation, issues: app.issues })
    })
  })

  router.get(
    '/rules',
    running((app, _req, res) => {
      res.json(app.rules())
    })
  )

  router.post(
    '/rules',
    requireJson,
    running((app, req, res) => {
      saved(res, app, app.createRule(req.body), true)
    })
  )

  router.get(
    '/rules/:origin/:slug',
    running((app, req, res) => {
      const entry: RuleEntry | undefined = app.rule(req.params.origin, req.params.slug)
      if (entry === undefined) notFound(res, 'such rule')
      else res.json(entry)
    })
  )

  router.put(
    '/rules/user/:slug',
    requireJson,
    running((app, req, res) => {
      saved(res, app, app.replaceRule(req.params.slug, req.body), false)
    })
  )

  router.post(
    '/rules/user/:slug/preview',
    requireJson,
    running((app, req, res) => {
      const outcome = app.previewRule(req.params.slug, req.body)
      if (outcome.ok) res.json(outcome.value)
      else editRefused(res, outcome)
    })
  )

  router.delete(
    '/rules/user/:slug',
    requireJson,
    running((app, req, res) => {
      if (app.deleteRule(req.params.slug, actorOf(req))) res.status(204).end()
      else notFound(res, 'such rule')
    })
  )

  router.post(
    '/rules/:origin/:slug/reset',
    requireJson,
    running((app, req, res) => {
      const { origin, slug } = req.params
      switch (app.resetAccumulator(origin, slug, actorOf(req))) {
        case 'reset':
          res.json(app.rule(origin, slug))
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
    running((app, _req, res) => {
      res.json(app.evaluation)
    })
  )

  router.put(
    '/evaluation',
    requireJson,
    running((app, req, res) => {
      const body: unknown = req.body
      if (!isRecord(body) || typeof body.enabled !== 'boolean') {
        invalid(res, [{ path: '/enabled', message: 'must be a boolean' }])
        return
      }
      app.setEvaluation(body.enabled, actorOf(req))
      res.json(app.evaluation)
    })
  )

  router.get(
    '/log',
    running((app, _req, res) => {
      res.json(app.log())
    })
  )
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
