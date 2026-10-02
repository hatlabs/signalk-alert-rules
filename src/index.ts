import { dirname, join } from 'node:path'
import type { Plugin, PluginRouter, ServerAPI } from '@signalk/server-api'
import { Application, CHECKPOINT_MS, TICK_MS } from './application.js'
import { registerRoutes } from './api/routes.js'
import { serverDeps } from './alerts/server.js'
import { Store } from './store/store.js'
import {
  BUILTIN_TEMPLATES,
  discoverTemplateSets,
  type DiscoveryDirs
} from './templates/discovery.js'
import { errorMessage } from './util.js'

const PLUGIN_ID = 'signalk-alert-rules'

/** The drop-in directory for template set files, in the plugin's data directory. */
const TEMPLATES_DIR = 'templates'

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

// Server 2.31 added `access()` to the plugin router.
const NO_ROUTE_LEVELS =
  'only admins can use Alert Rules: opening it to read-only and read/write users needs Signal K server 2.31 or later'

function securityEnabled(app: ServerAPI): boolean | null {
  const isDummy = (app as ServerAPI & ServerWithSecurity).securityStrategy?.isDummy
  return typeof isDummy === 'function' ? !isDummy() : null
}

export default function createPlugin(app: ServerAPI): Plugin {
  let application: Application | undefined
  let startError: string | undefined
  let timers: NodeJS.Timeout[] = []
  let routeNote: string | undefined
  // The server hands the plugin its router after starting it, so a note
  // about the router reaches a status that start has already set.
  let refreshStatus: (() => void) | undefined

  const fail = (text: string) => {
    startError = text
    app.setPluginError(text)
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Alert Rules',
    description: 'Raises alerts through the Signal K alerts API from rules over Signal K data',
    schema: () => ({
      type: 'object',
      description: 'Alert rules are managed in the Alert Rules webapp under Webapps.',
      properties: {}
    }),

    start() {
      startError = undefined
      if (!hasAlertsApi(app)) {
        fail('This server has no alerts API; rules cannot be evaluated')
        return
      }
      let running: Application
      try {
        const dataDir = app.getDataDirPath()
        // ServerAPI does not expose the server's config path. The data
        // directory is <configPath>/plugin-config-data/<pluginId>, and the
        // server installs plugins, template set packages among them, with
        // npm in <configPath> (signalk-server src/modules.ts).
        const dirs: DiscoveryDirs = {
          builtin: BUILTIN_TEMPLATES,
          configDir: dirname(dirname(dataDir)),
          dropIn: join(dataDir, TEMPLATES_DIR)
        }
        running = new Application(serverDeps(app, PLUGIN_ID), new Store(dataDir), () =>
          discoverTemplateSets(dirs)
        )
      } catch (err) {
        fail(`Cannot read the data directory: ${errorMessage(err)}`)
        return
      }
      try {
        running.start()
      } catch (err) {
        // Escaping start would leave /state with no error and the plugin
        // looking as if it were still starting.
        fail(`Cannot start evaluating rules: ${errorMessage(err)}`)
        return
      }
      application = running
      // A disk that stays full fails every write, each tick or checkpoint:
      // report the failure once, and the recovery. The reporters share one
      // plugin status, so one recovering must not hide the other's failure.
      // The status is rebuilt from what still stands, since a start issue
      // about a write goes once that write succeeds.
      // An exception escaping a timer would take the whole server down.
      const failures = new Map<symbol, string>()
      let shown: string | undefined
      const report = () => {
        const failure = [...failures.values()].at(-1)
        const notes = [...running.statusNotes(), ...(routeNote === undefined ? [] : [routeNote])]
        const text = failure ?? (notes.length === 0 ? 'Running' : `Running; ${notes.join('; ')}`)
        if (text === shown) return
        shown = text
        if (failure === undefined) app.setPluginStatus(text)
        else app.setPluginError(text)
      }
      const reportingOnce = (describe: (err: unknown) => string, run: () => void) => {
        const key = Symbol()
        return () => {
          try {
            run()
            failures.delete(key)
          } catch (err) {
            if (!failures.has(key)) {
              const text = describe(err)
              failures.set(key, text)
              app.error(text)
            }
          }
          report()
        }
      }
      timers = [
        setInterval(
          reportingOnce(
            (err) => `Evaluation failed: ${errorMessage(err)}`,
            () => {
              running.tick()
            }
          ),
          TICK_MS
        ),
        setInterval(
          reportingOnce(
            (err) => `Could not save accumulator totals: ${errorMessage(err)}`,
            () => {
              running.checkpoint()
            }
          ),
          CHECKPOINT_MS
        )
      ]
      for (const note of running.statusNotes()) app.error(note)
      refreshStatus = report
      report()
    },

    stop() {
      // Stopping must never clear alerts: it also happens on every configuration
      // save, and clearing would re-alert the operator each time.
      // Disabling stops the plugin too, and a disabled plugin has not failed.
      startError = undefined
      refreshStatus = undefined
      for (const timer of timers) clearInterval(timer)
      timers = []
      const running = application
      application = undefined
      if (running === undefined) return
      try {
        running.stop()
      } catch (err) {
        app.error(`Could not save accumulator totals: ${errorMessage(err)}`)
      }
    },

    registerWithRouter(router: PluginRouter) {
      const opensLevels = registerRoutes(router, {
        application: () => application,
        state: () => ({
          ...(startError === undefined ? {} : { error: startError }),
          securityEnabled: securityEnabled(app)
        })
      })
      // With security disabled every route is open to everyone anyway.
      routeNote = opensLevels || securityEnabled(app) === false ? undefined : NO_ROUTE_LEVELS
      // Shows the note now rather than at the next tick's report.
      refreshStatus?.()
    }
  }
  return plugin
}
