import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/store/store.js'
import { FakeAlertsCore } from './helpers/FakeAlertsCore.js'
import { MockServerAPI } from './helpers/MockServerAPI.js'
import createPlugin from '../src/index.js'

const RPM = 'propulsion.main.revolutions'
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  priority: 'caution',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', limit: 180 }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-plugin-'))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function storeRule(rule: Record<string, unknown> & { slug: string }): void {
  mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
}

describe('plugin', () => {
  it('identifies itself as signalk-alert-rules', () => {
    const plugin = createPlugin(new MockServerAPI(true, dir).asServerAPI())
    expect(plugin.id).toBe('signalk-alert-rules')
  })

  it('starts and stops on a server with the alerts API', async () => {
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())

    plugin.start({}, () => undefined)
    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toBe('Running')

    await plugin.stop()
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

  it('evaluates stored rules every second and leaves their alerts when stopped', async () => {
    storeRule(hours)
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)
    app.subscriptionmanager.publish(RPM, 'src', 30)

    vi.advanceTimersByTime(179_000)
    expect(app.core.list()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(app.core.getByPath('rules.user.engine-hours')?.condition).toBe(true)

    await plugin.stop()
    expect(app.core.getByPath('rules.user.engine-hours')?.condition).toBe(true)
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
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 60 } })

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
    expect(core.getByPath('rules.user.engine-hours')?.condition).toBe(true)

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
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 10 } })

    vi.advanceTimersByTime(300_000)
    expect(app.core.list()).toEqual([])
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 10 } })
  })

  it('runs and reports what it could not load', async () => {
    storeRule(hours)
    storeRule({ ...hours, slug: 'genset-hours', priority: 'loud' })
    writeFileSync(join(dir, 'evaluation.json'), '{')
    const app = new MockServerAPI(true, dir)
    const plugin = createPlugin(app.asServerAPI())
    plugin.start({}, () => undefined)

    expect(app.pluginError).toBeUndefined()
    expect(app.pluginStatus).toMatch(/^Running; /)
    expect(app.pluginStatus).toMatch(/genset-hours/)
    expect(app.pluginStatus).toMatch(/evaluation\.json/)
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
    expect(app.core.getByPath('rules.user.engine-hours')?.condition).toBe(true)

    await plugin.stop()
  })
})
