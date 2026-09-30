import type { ServerAPI } from '@signalk/server-api'
import type { AlertValue } from '../../src/alerts/emitter.js'
import { FakeAlertsCore } from './FakeAlertsCore.js'
import { FakeSubscriptionManager } from './FakeSubscriptionManager.js'

interface PluginDelta {
  updates: { values: { path: string; value: AlertValue | null }[] }[]
}

const ALERTS = 'alerts.'

/**
 * Records the plugin status calls and alerts API calls a test asserts on, and
 * routes the plugin's alert deltas into a fake core.
 */
export class MockServerAPI {
  pluginStatus: string | undefined
  pluginError: string | undefined
  readonly errors: string[] = []
  readonly alertsCalls: string[] = []
  readonly alerts?: Record<string, () => unknown>
  readonly core: FakeAlertsCore
  readonly subscriptionmanager = new FakeSubscriptionManager()

  /** Without `withAlerts`, the mock stands in for a server that has no alerts API. */
  constructor(
    withAlerts: boolean,
    /** Settable, to restart the same plugin instance on another directory. */
    public dataDir?: string,
    core = new FakeAlertsCore()
  ) {
    this.core = core
    if (withAlerts) {
      const calls = this.alertsCalls
      this.alerts = new Proxy(
        {},
        {
          get: (_target, name) => () => {
            calls.push(String(name))
            return name === 'list' ? core.list() : undefined
          }
        }
      )
    }
  }

  getDataDirPath(): string {
    if (this.dataDir === undefined) throw new Error('the test gave the mock no data directory')
    return this.dataDir
  }

  getSelfPath(): undefined {
    return undefined
  }

  handleMessage(id: string, delta: PluginDelta): void {
    for (const update of delta.updates) {
      for (const { path, value } of update.values) {
        if (path.startsWith(ALERTS)) this.core.ingest(id, path.slice(ALERTS.length), value)
      }
    }
  }

  setPluginStatus(msg: string): void {
    this.pluginStatus = msg
    this.pluginError = undefined
  }

  setPluginError(msg: string): void {
    this.pluginError = msg
  }

  debug(): void {
    // Tests do not assert on debug output.
  }

  error(msg: string): void {
    this.errors.push(msg)
  }

  asServerAPI(): ServerAPI {
    return this as unknown as ServerAPI
  }
}
