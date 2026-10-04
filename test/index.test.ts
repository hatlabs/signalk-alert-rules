import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Plugin, PluginRouter } from '@signalk/server-api'
import { Application } from '../src/application.js'
import { Store } from '../src/store/store.js'
import { FakeAlertsCore } from './helpers/FakeAlertsCore.js'
import { MockServerAPI } from './helpers/MockServerAPI.js'
import createPlugin from '../src/index.js'

const RPM = 'propulsion.main.revolutions'
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', steps: [{ limit: 180, priority: 'caution' }] }
}

/** Accumulates while running, and resets when the engine stops. */
const resettable = {
  ...hours,
  detector: {
    ...hours.detector,
    while: { op: 'above', value: 0 },
    resetOn: { op: 'changesTo', value: 0 }
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-plugin-'))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function storeRule(rule: Record<string, unknown> & { slug: string }): void {
  mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
}

/**
 * Registers the plugin's routes on a stub router and returns what `GET /state` answers.
 * Without `access`, the router is an older server's, which has no `access()`.
 */
function stateOf(plugin: Plugin, { access = true } = {}): () => unknown {
  const handlers = new Map<string, (req: unknown, res: unknown) => void>()
  const register = (path: string, ...chain: ((req: unknown, res: unknown) => void)[]) => {
    const handler = chain.at(-1)
    if (handler !== undefined) handlers.set(path, handler)
  }
  const methods = { get: register, post: register, put: register, delete: register }
  const router = access ? { ...methods, access: () => methods } : methods
  plugin.registerWithRouter?.(router as unknown as PluginRouter)
  return () => {
    let body: unknown
    handlers.get('/state')?.(
      {},
      {
        json: (b: unknown) => {
          body = b
        }
      }
    )
    return body
  }
}

describe('plugin', () => {
  it('identifies itself as signalk-alert-rules', () => {
    const plugin = createPlugin(new MockServerAPI(true, dir).asServerAPI())
    expect(plugin.id).toBe('signalk-alert-rules')
  })

  it('has no configuration and points to the webapp where rules are managed', () => {
    const plugin = createPlugin(new MockServerAPI(true, dir).asServerAPI())
    expect(plugin.schema).toBeTypeOf('function')
    const schema = (plugin.schema as () => object)()
    expect(schema).toMatchObject({ type: 'object', properties: {} })
    expect(schema).toHaveProperty('description', expect.stringMatching(/Alert Rules webapp/))
  })

  it('starts and stops on a server with the alerts API', async () => {
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())

    plugin.start({}, () => undefined)
    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toBe('Running')

    await plugin.stop()
  })

  it('names the server requirement in its status when the router has no access levels', async () => {
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    // The server starts a plugin before it hands it the router
    // (signalk-server src/interfaces/plugins.ts, registerPlugin).
    plugin.start({}, () => undefined)
    expect(app.pluginStatus).toBe('Running')
    const state = stateOf(plugin, { access: false })
    expect(app.pluginStatus).toMatch(/^Running; .*Signal K server 2\.31/)
    expect(state()).toMatchObject({ running: true, permissions: 'admin' })

    await plugin.stop()
    plugin.start({}, () => undefined)
    expect(app.pluginStatus).toMatch(/Signal K server 2\.31/)
    await plugin.stop()
  })

  it('names no server requirement with security disabled, where every route is open', async () => {
    const app = new MockServerAPI(true, dir)
    Object.assign(app, { securityStrategy: { isDummy: () => true } })
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    stateOf(plugin, { access: false })
    expect(app.pluginStatus).toBe('Running')
    await plugin.stop()
  })

  it('reports Running alone when the router has access levels', async () => {
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    stateOf(plugin)
    expect(app.pluginStatus).toBe('Running')
    await plugin.stop()
  })

  it('leaves the status of a plugin that did not start to its error', () => {
    const app = new MockServerAPI(false, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    stateOf(plugin, { access: false })
    expect(app.pluginError).toMatch(/no alerts API/)
    expect(app.pluginStatus).toBeUndefined()
  })

  it('makes no alerts API calls when stopped', async () => {
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    const callsBeforeStop = app.alertsCalls.length

    await plugin.stop()

    expect(app.alertsCalls.slice(callsBeforeStop)).toEqual([])
  })

  it('reports an error and does not run on a server without the alerts API', async () => {
    const app = new MockServerAPI(false, dir)
    const plugin = createPlugin(app.asServerAPI())

    plugin.start({}, () => undefined)
    expect(app.pluginError).toMatch(/no alerts API/)
    expect(app.pluginStatus).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])

    await plugin.stop()
  })

  it('reports no start error once a plugin whose start failed is stopped', async () => {
    const app = new MockServerAPI(false, dir)
    const plugin = createPlugin(app.asServerAPI())
    const state = stateOf(plugin)

    plugin.start({}, () => undefined)
    expect((state() as { error?: string }).error).toMatch(/no alerts API/)
    await plugin.stop()

    expect(state()).toEqual({ running: false, securityEnabled: null, permissions: 'admin' })
  })

  it('evaluates stored rules every second and leaves their alerts when stopped', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)

    vi.advanceTimersByTime(179_000)
    expect(app.core.list()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(app.core.getByPath('propulsion.main.revolutionsAccumulated')?.condition).toBe(true)

    await plugin.stop()
    expect(app.core.getByPath('propulsion.main.revolutionsAccumulated')?.condition).toBe(true)
  })

  it('checkpoints accumulator totals every 60 s while running', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)

    vi.advanceTimersByTime(59_000)
    expect(new Store(dir).load().accumulators).toEqual({})
    vi.advanceTimersByTime(1_000)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 60 } }
    })

    await plugin.stop()
  })

  it('writes a resetOn reset within a tick, without waiting for the checkpoint', async () => {
    storeRule(resettable)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(60_000)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 60 } }
    })

    vi.advanceTimersByTime(10_000)
    app.subscriptionmanager.publish(RPM, 'src', 0)
    vi.advanceTimersByTime(1_000)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 0 } }
    })

    await plugin.stop()
  })

  it('writes a reset when the plugin stops right after it, before the next tick', async () => {
    storeRule(resettable)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(500)
    app.subscriptionmanager.publish(RPM, 'src', 0)
    await plugin.stop()
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 0 } }
    })
  })

  it('reports a failed reset write once, and clears it when the checkpoint succeeds', async () => {
    storeRule(resettable)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(30_000)
    // A directory where the file belongs makes the rename fail.
    mkdirSync(join(dir, 'accumulators.json', 'blocker'), { recursive: true })
    app.subscriptionmanager.publish(RPM, 'src', 0)

    vi.advanceTimersByTime(1_000)
    expect(app.pluginError).toMatch(/accumulator totals/)
    // The periodic checkpoint fails as well, and is not logged again.
    vi.advanceTimersByTime(29_000)
    expect(app.errors.filter((e) => e.includes('accumulator totals'))).toHaveLength(1)

    rmSync(join(dir, 'accumulators.json'), { recursive: true })
    vi.spyOn(Application.prototype, 'checkpointResets').mockImplementation(() => false)
    vi.advanceTimersByTime(59_000)
    expect(app.pluginError).toMatch(/accumulator totals/)
    vi.advanceTimersByTime(1_000)
    expect(app.pluginError).toBeUndefined()

    await plugin.stop()
  })

  it('clears a failed checkpoint when a reset write succeeds', async () => {
    storeRule(resettable)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    mkdirSync(join(dir, 'accumulators.json', 'blocker'), { recursive: true })
    vi.advanceTimersByTime(60_000)
    expect(app.pluginError).toMatch(/accumulator totals/)

    rmSync(join(dir, 'accumulators.json'), { recursive: true })
    app.subscriptionmanager.publish(RPM, 'src', 0)
    vi.advanceTimersByTime(1_000)
    expect(app.pluginError).toBeUndefined()
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 0 } }
    })

    await plugin.stop()
  })

  it('accumulator state persisted by a checkpoint survives a plugin restart', async () => {
    storeRule(hours)
    const core = new FakeAlertsCore()
    const first = new MockServerAPI(true, dir, core)
    const plugin = createPlugin(first.asServerAPI())
    plugin.start({}, () => undefined)
    first.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(120_000)
    await plugin.stop()

    const second = new MockServerAPI(true, dir, core)
    const restarted = createPlugin(second.asServerAPI())
    restarted.start({}, () => undefined)
    second.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(59_000)
    expect(core.list()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(core.getByPath('propulsion.main.revolutionsAccumulated')?.condition).toBe(true)

    await restarted.stop()
  })

  it('stops ticking and checkpointing once stopped', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(10_000)
    await plugin.stop()
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 10 } }
    })

    vi.advanceTimersByTime(300_000)
    expect(app.core.list()).toEqual([])
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 10 } }
    })
  })

  it('runs and reports what it could not load', async () => {
    storeRule(hours)
    storeRule({
      ...hours,
      slug: 'genset-hours',
      detector: { ...hours.detector, steps: [{ limit: 180, priority: 'loud' }] }
    })
    writeFileSync(join(dir, 'accumulators.json'), '{')
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)

    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toMatch(/^Running; /)
    expect(app.pluginStatus).toMatch(/genset-hours/)
    expect(app.pluginStatus).toMatch(/accumulators\.json/)
    expect(app.errors).toHaveLength(2)

    await plugin.stop()
  })

  it('reports an error and does not run when the data directory cannot be read', async () => {
    const file = join(dir, 'not-a-directory')
    writeFileSync(file, '')
    const app = new MockServerAPI(true, file)
    const plugin = createPlugin(app.asServerAPI())

    plugin.start({}, () => undefined)
    expect(app.pluginError).toMatch(/data directory/)
    expect(app.alertsCalls).toEqual([])

    await plugin.stop()
  })

  it('reports an error and does not run when the alerts API cannot list alerts', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    Object.defineProperty(app, 'alerts', {
      value: {
        list: () => {
          throw new Error('alerts unavailable')
        }
      }
    })
    const plugin = createPlugin(app.asServerAPI())
    const state = stateOf(plugin)

    expect(() => {
      plugin.start({}, () => undefined)
    }).not.toThrow()
    expect(app.pluginError).toMatch(/alerts unavailable/)
    expect(app.pluginStatus).toBeUndefined()
    expect(state()).toMatchObject({ running: false })
    expect((state() as { error?: string }).error).toMatch(/alerts unavailable/)
    expect(vi.getTimerCount()).toBe(0)

    await plugin.stop()
  })

  it('the same instance runs normally when started again after a failed start', async () => {
    storeRule(hours)
    const file = join(dir, 'not-a-directory')
    writeFileSync(file, '')
    const app = new MockServerAPI(true, file)
    const plugin = createPlugin(app.asServerAPI())
    const state = stateOf(plugin)
    plugin.start({}, () => undefined)
    expect(app.pluginError).toMatch(/data directory/)
    expect(state()).toMatchObject({ running: false })
    expect((state() as { error?: string }).error).toMatch(/data directory/)
    await plugin.stop()

    app.dataDir = dir
    plugin.start({}, () => undefined)
    expect(app.pluginError).toBeUndefined()
    expect(state()).toEqual({
      running: true,
      securityEnabled: null,
      permissions: 'admin',
      issues: []
    })
    app.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(60_000)
    // One tick a second: a second set of timers would count twice as fast.
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 60 } }
    })

    await plugin.stop()
  })

  it('stops with a failing final checkpoint, reporting it and ticking no more', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    vi.advanceTimersByTime(10_000)
    // A directory where the file belongs makes the rename fail.
    mkdirSync(join(dir, 'accumulators.json', 'blocker'), { recursive: true })

    await expect(Promise.resolve(plugin.stop())).resolves.toBeUndefined()
    expect(app.errors).toEqual([expect.stringMatching(/accumulator totals/)])
    const writes = app.core.writes
    vi.advanceTimersByTime(300_000)
    expect(app.core.writes).toBe(writes)
    expect(app.core.list()).toEqual([])
  })

  it('reports a failed checkpoint without stopping evaluation', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)
    // A directory where the file belongs makes the rename fail.
    mkdirSync(join(dir, 'accumulators.json', 'blocker'), { recursive: true })

    vi.advanceTimersByTime(60_000)
    expect(app.pluginError).toMatch(/accumulator totals/)
    vi.advanceTimersByTime(120_000)
    expect(app.core.getByPath('propulsion.main.revolutionsAccumulated')?.condition).toBe(true)

    await plugin.stop()
  })

  it('keeps reporting a failing checkpoint when a failing tick recovers', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    const running = app.pluginStatus
    app.subscriptionmanager.publish(RPM, 'src', 30)
    const tick = vi.spyOn(Application.prototype, 'tick').mockImplementation(() => {
      throw new Error('tick failed')
    })
    // A directory where the file belongs makes the rename fail.
    mkdirSync(join(dir, 'accumulators.json', 'blocker'), { recursive: true })

    vi.advanceTimersByTime(60_000)
    expect(app.pluginError).toMatch(/accumulator totals/)

    tick.mockRestore()
    vi.advanceTimersByTime(1_000)
    expect(app.pluginError).toMatch(/accumulator totals/)

    rmSync(join(dir, 'accumulators.json'), { recursive: true })
    vi.advanceTimersByTime(60_000)
    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toBe(running)

    await plugin.stop()
  })

  it('drops a start issue from the status once the write it names succeeds', async () => {
    storeRule(hours)
    const stale = { measure: 'integral', totals: { '': 50 } }
    new Store(dir).saveCheckpoints({ 'engine-hours': stale })
    const save = vi.spyOn(Store.prototype, 'saveCheckpoints').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    try {
      const app = new MockServerAPI(true, dir)
      const plugin = createPlugin(app.asServerAPI())
      const state = stateOf(plugin)
      plugin.start({}, () => undefined)
      expect(app.pluginStatus).toMatch(/^Running; the accumulator totals could not be saved/)

      vi.advanceTimersByTime(60_000)
      expect(app.pluginError).toBeUndefined()
      expect(app.pluginStatus).toBe('Running')
      expect(state()).toMatchObject({ issues: [] })

      await plugin.stop()
    } finally {
      save.mockRestore()
    }
  })

  it('logs a failing checkpoint once and restores the status when the disk recovers', async () => {
    storeRule(hours)
    storeRule({
      ...hours,
      slug: 'genset-hours',
      detector: { ...hours.detector, steps: [{ limit: 180, priority: 'loud' }] }
    })
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    const running = app.pluginStatus
    const loadErrors = app.errors.length
    app.subscriptionmanager.publish(RPM, 'src', 30)
    mkdirSync(join(dir, 'accumulators.json', 'blocker'), { recursive: true })

    vi.advanceTimersByTime(180_000)
    expect(app.pluginError).toMatch(/accumulator totals/)
    expect(app.errors.slice(loadErrors)).toEqual([expect.stringMatching(/accumulator totals/)])

    rmSync(join(dir, 'accumulators.json'), { recursive: true })
    vi.advanceTimersByTime(60_000)
    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toBe(running)
    expect(app.pluginStatus).toMatch(/^Running; .*genset-hours/)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 240 } }
    })

    await plugin.stop()
  })
})
