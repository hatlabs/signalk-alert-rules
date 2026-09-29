import type { Plugin, ServerAPI } from '@signalk/server-api'

const PLUGIN_ID = 'signalk-alert-rules'

// The published server-api types predate the core alerts API, so its presence is
// detected at runtime rather than through the ServerAPI type.
function hasAlertsApi(app: ServerAPI): boolean {
  return (app as { alerts?: unknown }).alerts !== undefined
}

export default function createPlugin(app: ServerAPI): Plugin {
  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Alert Rules',
    description: 'Raises alerts through the Signal K alerts API from rules over Signal K data',
    schema: () => ({ type: 'object', properties: {} }),

    start() {
      if (!hasAlertsApi(app)) {
        app.setPluginError('This server has no alerts API; rules cannot be evaluated')
        return
      }
      app.setPluginStatus('Running')
    },

    stop() {
      // Stopping must never clear alerts: it also happens on every configuration
      // save, and clearing would re-alert the operator each time.
    }
  }
  return plugin
}
