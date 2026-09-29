import { describe, it, expect } from 'vitest'
import { MockServerAPI } from './helpers/MockServerAPI.js'
import createPlugin from '../src/index.js'

describe('plugin', () => {
  it('identifies itself as signalk-alert-rules', () => {
    const plugin = createPlugin(new MockServerAPI(true).asServerAPI())
    expect(plugin.id).toBe('signalk-alert-rules')
  })

  it('starts and stops on a server with the alerts API', async () => {
    const app = new MockServerAPI(true)
    const plugin = createPlugin(app.asServerAPI())

    plugin.start({}, () => undefined)
    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toBe('Running')

    await plugin.stop()
  })

  it('makes no alerts API calls when stopped', async () => {
    const app = new MockServerAPI(true)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    const callsBeforeStop = app.alertsCalls.length

    await plugin.stop()

    expect(app.alertsCalls.slice(callsBeforeStop)).toEqual([])
  })

  it('reports an error and does not run on a server without the alerts API', async () => {
    const app = new MockServerAPI(false)
    const plugin = createPlugin(app.asServerAPI())

    plugin.start({}, () => undefined)
    expect(app.pluginError).toMatch(/no alerts API/)
    expect(app.pluginStatus).toBeUndefined()

    await plugin.stop()
  })
})
