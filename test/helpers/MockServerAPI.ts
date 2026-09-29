import type { ServerAPI } from '@signalk/server-api'

/** Records the plugin status calls and alerts API calls a test asserts on. */
export class MockServerAPI {
  pluginStatus: string | undefined
  pluginError: string | undefined
  readonly alertsCalls: string[] = []
  readonly alerts?: Record<string, (...args: unknown[]) => undefined>

  /** Without `withAlerts`, the mock stands in for a server that has no alerts API. */
  constructor(withAlerts: boolean) {
    if (withAlerts) {
      const calls = this.alertsCalls
      this.alerts = new Proxy(
        {},
        {
          get: (_target, name) => () => {
            calls.push(String(name))
            return undefined
          }
        }
      )
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

  error(): void {
    // Tests do not assert on error output.
  }

  asServerAPI(): ServerAPI {
    return this as unknown as ServerAPI
  }
}
