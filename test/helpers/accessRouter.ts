import type {
  AccessScopedRouter,
  PluginRouter,
  RouteAccessLevel,
  RoutePermission
} from '@signalk/server-api'
import type { RequestHandler, Router } from 'express'
import type { Permissions } from '../../src/api/routes.js'

/**
 * Gives an express router the server's `access()` (signalk-server
 * src/interfaces/plugins.ts, `asPluginRouter`), recording each route opened
 * through it as the server records it. Routes registered directly stay
 * unrecorded, as the server leaves them admin-only.
 */
export function withAccess(router: Router): { router: PluginRouter; opened: RoutePermission[] } {
  const opened: RoutePermission[] = []
  const access = (permission: RouteAccessLevel): AccessScopedRouter => {
    const register =
      (method: RoutePermission['method']) =>
      (path: string, ...handlers: RequestHandler[]): AccessScopedRouter => {
        opened.push({ method, path, permission })
        router[method.toLowerCase() as Lowercase<RoutePermission['method']>](path, ...handlers)
        return registrar
      }
    const registrar: AccessScopedRouter = {
      get: register('GET'),
      post: register('POST'),
      put: register('PUT'),
      patch: register('PATCH'),
      delete: register('DELETE')
    }
    return registrar
  }
  return { router: Object.assign(router, { access }), opened }
}

function matches(route: RoutePermission, method: string, path: string): boolean {
  const pattern = route.path.replace(/:[^/]+/g, '[^/]+')
  return route.method === method && new RegExp(`^${pattern}$`).test(path)
}

/**
 * Whether the server admits a principal to a plugin route, as its plugin
 * gate decides (signalk-server src/tokensecurity.ts,
 * `pluginAuthenticationMiddleware`): a route opened read-only admits any
 * authenticated user, one opened read/write admits read/write users and
 * admins, and any other route admits admins only. `path` is relative to the
 * plugin's mount point.
 */
export function admits(
  opened: readonly RoutePermission[],
  permissions: Permissions,
  method: string,
  path: string
): boolean {
  const route = opened.find((r) => matches(r, method, path.replace(/\/$/, '')))
  if (route?.permission === 'readonly') return true
  if (route?.permission === 'readwrite')
    return permissions === 'admin' || permissions === 'readwrite'
  return permissions === 'admin'
}
