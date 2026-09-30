import type { Plugin, PluginRouter, ServerAPI } from '@signalk/server-api'
import { Application, CHECKPOINT_MS, TICK_MS } from './application.js'
import { registerRoutes } from './api/routes.js'
import { serverDeps } from './alerts/server.js'
import { Store } from './store/store.js'

const PLUGIN_ID = 'signalk-alert-rules'

// The published server-api types predate the core alerts API, so its presence is
// detected at runtime rather than through the ServerAPI type.
function hasAlertsApi(app: ServerAPI): boolean {
  return (app as { alerts?: unknown }).alerts !== undefined
}

// Not a public plugin API: the plugin's app is a shallow copy of the server's
// (signalk-server src/interfaces/plugins.ts, `_.assign({}, app, ...)` in
// doRegisterPlugin), so the server's security strategy is reachable. With
// security disabled it is the dummy strategy, whose isDummy() is true
// (src/security.ts, startSecurity; src/dummysecurity.ts); the server tests
// it the same way.
interface ServerWithSecurity {
  securityStrategy?: { isDummy?: () => boolean }
}

function securityEnabled(app: ServerAPI): boolean | null {
  const isDummy = (app as ServerAPI & ServerWithSecurity).securityStrategy?.isDummy
  return typeof isDummy === 'function' ? !isDummy() : null
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default function createPlugin(app: ServerAPI): Plugin {
  let application: Application | undefined
  let startError: string | undefined
  let timers: NodeJS.Timeout[] = []

  const fail = (text: string) => {
    startError = text
    app.setPluginError(text)
  }

  const checkpoint = (running: Application) => {
    try {
      running.checkpoint()
    } catch (err) {
      const text = `Could not save accumulator totals: ${message(err)}`
      app.error(text)
      app.setPluginError(text)
    }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Alert Rules',
    description: 'Raises alerts through the Signal K alerts API from rules over Signal K data',
    schema: () => ({ type: 'object', properties: {} }),

    start() {
      startError = undefined
      if (!hasAlertsApi(app)) {
        fail('This server has no alerts API; rules cannot be evaluated')
        return
      }
      let running: Application
      try {
        running = new Application(serverDeps(app, PLUGIN_ID), new Store(app.getDataDirPath()))
      } catch (err) {
        fail(`Cannot read the data directory: ${message(err)}`)
        return
      }
      running.start()
      application = running
      timers = [
        setInterval(() => {
          // An exception escaping a timer would take the whole server down.
          try {
            running.tick()
          } catch (err) {
            app.error(`Evaluation failed: ${message(err)}`)
          }
        }, TICK_MS),
        setInterval(() => {
          checkpoint(running)
        }, CHECKPOINT_MS)
      ]
      for (const issue of running.issues) app.error(issue)
      app.setPluginStatus(
        running.issues.length === 0 ? 'Running' : `Running; ${running.issues.join('; ')}`
      )
    },

    stop() {
      // Stopping must never clear alerts: it also happens on every configuration
      // save, and clearing would re-alert the operator each time.
      for (const timer of timers) clearInterval(timer)
      timers = []
      const running = application
      application = undefined
      if (running === undefined) return
      try {
        running.stop()
      } catch (err) {
        app.error(`Could not save accumulator totals: ${message(err)}`)
      }
    },

    registerWithRouter(router: PluginRouter) {
      registerRoutes(router, {
        application: () => application,
        state: () => ({
          ...(startError === undefined ? {} : { error: startError }),
          securityEnabled: securityEnabled(app)
        })
      })
    }
  }
  return plugin
}
