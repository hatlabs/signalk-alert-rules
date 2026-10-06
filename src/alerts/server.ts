import type { Delta, Path, ServerAPI } from '@signalk/server-api'
import { monotonic } from '../engine/clock.js'
import type { PathMeta, TimeoutSettings } from '../engine/evaluator.js'
import type { Zone } from '../engine/limits.js'
import { canonicalSourceRef } from '../engine/sourceRefs.js'
import type { AlertsReader, CoreAlert } from './emitter.js'
import { deltaPath } from './paths.js'
import type { RunnerDeps } from './runner.js'
import { splitPointerPath } from '../model/pointerPath.js'
import { isRecord, own } from '../util.js'

// The published server-api types predate the core alerts API; these are the
// parts of it SKAR reads.
interface ServerWithAlerts {
  alerts: AlertsReader
}

interface ServerSettings {
  config?: { settings?: { enforceDataTimeouts?: boolean; useDefaultTimeouts?: boolean } }
}

function isBound(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'number'
}

function isZone(value: unknown): value is Zone {
  return (
    isRecord(value) &&
    typeof value.state === 'string' &&
    isBound(value.lower) &&
    isBound(value.upper)
  )
}

/** The meta fields the evaluator reads, keeping only well-formed values. */
function pathMeta(value: unknown): PathMeta | undefined {
  if (!isRecord(value)) return undefined
  const { zones, units, timeout, updateContract } = value
  return {
    zones: Array.isArray(zones) ? zones.filter(isZone) : undefined,
    units: typeof units === 'string' ? units : undefined,
    timeout: typeof timeout === 'number' || typeof timeout === 'string' ? timeout : undefined,
    updateContract: typeof updateContract === 'string' ? updateContract : undefined
  }
}

/** The units a path's meta gives the field its `properties` describe at the tokens. */
function propertyUnits(meta: unknown, tokens: readonly string[]): string | undefined {
  let node = meta
  for (const token of tokens) {
    node = isRecord(node) && isRecord(node.properties) ? own(node.properties, token) : undefined
  }
  return isRecord(node) && typeof node.units === 'string' ? node.units : undefined
}

/**
 * A field's meta: the base path's timing, since the field arrives in the base
 * path's deltas, and no zones, which are a path's and never a field's. The
 * metadata lookup has no entry for a field, so its units come from the base
 * path's `properties`, the data tree's first as for a whole path.
 */
function fieldMeta(
  app: ServerAPI,
  basePath: string,
  tokens: readonly string[]
): PathMeta | undefined {
  const tree: unknown = app.getSelfPath(`${basePath}.meta`)
  const base = pathMeta(tree)
  const units =
    propertyUnits(tree, tokens) ??
    propertyUnits(app.getMetadata(`vessels.self.${basePath}`), tokens)
  if (base === undefined && units === undefined) return undefined
  return { zones: undefined, units, timeout: base?.timeout, updateContract: base?.updateContract }
}

/**
 * The server's data-timeout settings. They are not a public plugin API: the
 * plugin's app is a shallow copy of the server's, so `config.settings` is
 * reachable. Undefined when they are not.
 */
function timeoutSettings(app: ServerAPI): TimeoutSettings | undefined {
  const settings = (app as ServerAPI & ServerSettings).config?.settings
  if (settings === undefined) return undefined
  return {
    enforce: settings.enforceDataTimeouts === true,
    useDefaults: settings.useDefaultTimeouts !== false
  }
}

/** The runner's view of the server, from the plugin's app. */
export function serverDeps(app: ServerAPI, pluginId: string): RunnerDeps {
  const alerts = (app as ServerAPI & ServerWithAlerts).alerts
  return {
    pluginId,
    subscriptions: app.subscriptionmanager,
    meta: (path) => {
      const split = splitPointerPath(path)
      if (split.valid && split.tokens.length > 0) {
        return fieldMeta(app, split.basePath, split.tokens)
      }
      const meta = pathMeta(app.getSelfPath(`${path}.meta`))
      if (meta?.units !== undefined) return meta
      // The data tree's meta holds what was set for the path, not the units
      // the specification gives it; the metadata lookup, keyed by the full
      // path, has those.
      const units = app.getMetadata(`vessels.self.${path}`)?.units
      if (typeof units !== 'string') return meta
      return { ...meta, units }
    },
    timeoutSettings: () => timeoutSettings(app),
    // `getPath('sources')` is the server's live tree; '/sources' would rebuild a copy per call.
    canonicalSource: (ref) => canonicalSourceRef(app.getPath('sources'), ref),
    clock: monotonic,
    wallClock: () => new Date(),
    alerts: {
      list: (): CoreAlert[] => alerts.list()
    },
    send: (path, value) => {
      const delta: Partial<Delta> = {
        updates: [{ values: [{ path: deltaPath(path) as Path, value }] }]
      }
      app.handleMessage(pluginId, delta)
    }
  }
}
