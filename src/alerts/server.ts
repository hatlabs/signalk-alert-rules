import type { Delta, Path, ServerAPI } from '@signalk/server-api'
import { monotonic } from '../engine/clock.js'
import type { PathMeta, TimeoutSettings } from '../engine/evaluator.js'
import type { Zone } from '../engine/limits.js'
import { canonicalSourceRef } from '../engine/sourceRefs.js'
import type { AlertsReader, CoreAlert } from './emitter.js'
import { deltaPath } from './paths.js'
import type { RunnerDeps } from './runner.js'
import { isRecord } from '../util.js'

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
    meta: (path) => pathMeta(app.getSelfPath(`${path}.meta`)),
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
