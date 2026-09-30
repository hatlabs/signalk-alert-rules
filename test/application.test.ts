import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Value } from '@signalk/server-api'
import { Application, LOG_LIMIT } from '../src/application.js'
import type { RunnerDeps } from '../src/alerts/runner.js'
import { serverDeps } from '../src/alerts/server.js'
import { Store, type Checkpoints, type Controls } from '../src/store/store.js'
import { FakeAlertsCore } from './helpers/FakeAlertsCore.js'
import { MockServerAPI } from './helpers/MockServerAPI.js'

const PLUGIN = 'signalk-alert-rules'
const WALL = '2026-09-30T12:00:00.000Z'
const OIL = 'propulsion.main.oilPressure'
const COOLANT = 'propulsion.main.coolantTemperature'
const RPM = 'propulsion.main.revolutions'

const oil = {
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  priority: 'alarm',
  signal: { path: OIL },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'fixed', value: 100000 },
    duration: 5
  }
}
const coolant = {
  name: 'Coolant high',
  slug: 'coolant-high',
  message: 'Coolant temperature is high',
  priority: 'alarm',
  signal: { path: COOLANT },
  detector: {
    type: 'sustained',
    direction: 'above',
    limit: { kind: 'fixed', value: 368 },
    duration: 2
  }
}
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  priority: 'caution',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', limit: 1000 }
}

const integral = { ...hours, detector: { type: 'accumulator', measure: 'integral', limit: 1000 } }
/** Fails validation: an accumulator limit must be positive. */
const brokenHours = { ...hours, detector: { ...hours.detector, limit: -5 } }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-app-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stored(rule: Record<string, unknown> & { slug: string }): void {
  fs.mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
}

function setup(store = new Store(dir), core = new FakeAlertsCore(), meta?: RunnerDeps['meta']) {
  const server = new MockServerAPI(true, dir, core)
  let now = 0
  const serverSide = serverDeps(server.asServerAPI(), PLUGIN)
  const deps = {
    ...serverSide,
    meta: meta ?? serverSide.meta,
    clock: () => now,
    wallClock: () => new Date(WALL)
  }
  const application = new Application(deps, store)
  application.start()
  const alerts = () => server.core.list().map((a) => [a.path, a.condition] as [string, boolean])
  return {
    server,
    application,
    alerts,
    at: (t: number, path?: string, value?: Value) => {
      now = t
      if (path === undefined) application.tick()
      else server.subscriptionmanager.publish(path, 'src', value ?? null)
    }
  }
}

describe('application', () => {
  it('creating a rule persists it and starts evaluation without restarting others', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(3)

    const result = application.createRule(coolant)
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'rules', 'coolant-high.json'), 'utf8'))).toEqual(
      coolant
    )
    expect(application.userRules().map((r) => r.slug)).toEqual(['oil-pressure-low', 'coolant-high'])

    // The oil rule's timer kept running across the save: it raises 5 s after
    // its value, not 5 s after the save.
    at(4)
    expect(alerts()).toEqual([])
    at(5)
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])

    at(5, COOLANT, 380)
    at(7)
    expect(alerts()).toContainEqual(['rules.user.coolant-high', true])
  })

  it('an edit persists and applies to the running rule', () => {
    stored(oil)
    const { application, at, server } = setup()
    at(0, OIL, 0)
    at(5)
    expect(application.replaceRule(oil.slug, { ...oil, message: 'Check the oil' }).ok).toBe(true)
    at(25)
    expect(server.core.getByPath('rules.user.oil-pressure-low')?.message).toBe('Check the oil')
    expect(new Store(dir).load().rules[0]?.value).toMatchObject({ message: 'Check the oil' })
  })

  it('rejects an invalid rule with field-path errors and persists nothing', () => {
    const { application } = setup()
    const result = application.createRule({ ...oil, priority: 'loud' })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    if (!result.ok && result.reason === 'invalid') {
      expect(result.errors.map((e) => e.path)).toContain('/priority')
    }
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(false)
    expect(application.userRules()).toEqual([])
  })

  it('does not apply a rule the store failed to persist', () => {
    const failing = new Store(dir, {
      ...fs,
      writeSync: () => {
        throw new Error('EROFS: read-only file system')
      }
    })
    const { application, at, alerts } = setup(failing)
    expect(() => application.createRule(oil)).toThrow(/EROFS/)
    expect(application.userRules()).toEqual([])
    at(0, OIL, 0)
    at(10)
    expect(alerts()).toEqual([])
  })

  it('deleting a rule removes its file and clears its alert, leaving the others', () => {
    stored(oil)
    stored(coolant)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(0, COOLANT, 380)
    at(5)
    expect(alerts()).toHaveLength(2)

    expect(application.deleteRule('oil-pressure-low', 'admin')).toBe(true)
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(false)
    expect(new Map(alerts())).toEqual(
      new Map([
        ['rules.user.oil-pressure-low', false],
        ['rules.user.coolant-high', true]
      ])
    )
    expect(application.deleteRule('oil-pressure-low', 'admin')).toBe(false)
  })

  it('skips and reports an invalid stored rule while the others run, and can delete it', () => {
    stored(oil)
    stored({ ...coolant, priority: 'loud' })
    writeFileSync(join(dir, 'rules', 'renamed.json'), JSON.stringify(coolant))
    const { application, at, alerts } = setup()
    expect(application.issues).toHaveLength(2)
    expect(application.issues.join('\n')).toMatch(/coolant-high.*\/priority/)
    expect(application.issues.join('\n')).toMatch(/renamed.*coolant-high/)
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])

    expect(application.deleteRule('coolant-high', 'admin')).toBe(true)
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
  })

  it('reports a rule file it cannot read, runs the others and does not let a create overwrite it', () => {
    stored(oil)
    stored(coolant)
    const failing = new Store(dir, {
      ...fs,
      readFileSync: ((path: string, options: BufferEncoding) => {
        if (path.endsWith('coolant-high.json')) {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
        }
        return fs.readFileSync(path, options)
      }) as typeof fs.readFileSync
    })
    const { application } = setup(failing)
    expect(application.issues).toEqual([expect.stringMatching(/coolant-high\.json.*EIO/)])
    expect(application.userRules().map((r) => r.slug)).toEqual(['oil-pressure-low'])
    expect(application.createRule(coolant)).toEqual({ ok: false, reason: 'exists' })
    expect(JSON.parse(readFileSync(join(dir, 'rules', 'coolant-high.json'), 'utf8'))).toEqual(
      coolant
    )
  })

  it('reports a corrupt store file and runs the rules it could read', () => {
    stored(oil)
    writeFileSync(join(dir, 'accumulators.json'), '{')
    const { application } = setup()
    expect(application.issues).toEqual([expect.stringMatching(/accumulators\.json/)])
    expect(application.userRules().map((r) => r.slug)).toEqual(['oil-pressure-low'])
  })

  it("checkpoints running totals and keeps a skipped rule's until it is deleted", () => {
    stored(hours)
    stored({ ...hours, slug: 'genset-hours', priority: 'loud' })
    new Store(dir).saveCheckpoints({
      'user.engine-hours': { '': 100 },
      'user.genset-hours': { '': 50 }
    })
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({
      'user.engine-hours': { '': 120 },
      'user.genset-hours': { '': 50 }
    })

    application.deleteRule('genset-hours', 'admin')
    application.deleteRule('engine-hours', 'admin')
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({})
  })

  it('a checkpoint writes only totals that changed since the last successful one', () => {
    stored(hours)
    const store = new Store(dir)
    const save = vi.spyOn(store, 'saveCheckpoints')
    const { application, at } = setup(store)
    at(0, RPM, 30)
    at(10)
    application.checkpoint()
    application.checkpoint()
    expect(save).toHaveBeenCalledTimes(1)

    at(20)
    save.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    expect(() => {
      application.checkpoint()
    }).toThrow(/ENOSPC/)
    // The failed write is retried although the totals have not changed since.
    application.checkpoint()
    expect(save).toHaveBeenCalledTimes(3)
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 20 } })
  })

  it('stopping checkpoints and clears no alert', () => {
    stored(oil)
    stored(hours)
    const { application, at, alerts, server } = setup()
    at(0, OIL, 0)
    at(0, RPM, 30)
    at(5)
    const sent = server.core.writes
    application.stop()
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])
    expect(server.core.writes).toBe(sent)
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 5 } })
  })

  it('exposes the stored evaluation switch', () => {
    new Store(dir).saveEvaluation({ enabled: false, actor: 'admin', at: '2026-09-30T12:00:00Z' })
    expect(setup().application.evaluation).toEqual({
      enabled: false,
      actor: 'admin',
      at: '2026-09-30T12:00:00Z'
    })
  })
})

describe('application operator actions', () => {
  const OIL_ALERT = 'rules.user.oil-pressure-low'
  // Not caution: core drops a cleared caution alert, which the tests read back.
  const shortHours = { ...hours, priority: 'warning', detector: { ...hours.detector, limit: 10 } }

  it('evaluation off clears every alert SKAR owns, stops evaluating and records the actor', () => {
    stored(oil)
    const core = new FakeAlertsCore()
    const { application, at } = setup(undefined, core)
    at(0, OIL, 0)
    at(5)
    // An owned alert the emitter does not hold, such as one whose rule's
    // clear was lost, and another source's alert under the same prefix.
    core.ingest(PLUGIN, 'rules.user.lost', { priority: 'alarm', message: 'x', latching: false })
    core.raiseFrom('other-plugin', 'rules.user.foreign')

    application.setEvaluation(false, 'admin')

    const active = core.list().filter((a) => a.condition)
    expect(active.map((a) => a.path)).toEqual(['rules.user.foreign'])
    expect(application.evaluation).toEqual({ enabled: false, actor: 'admin', at: WALL })
    expect(new Store(dir).load().evaluation).toEqual(application.evaluation)
    expect(application.log()).toEqual([
      { at: WALL, actor: 'admin', action: 'evaluation', enabled: false }
    ])

    const writes = core.writes
    at(6, OIL, 0)
    at(100)
    expect(core.writes).toBe(writes)
    expect(application.rules()[0]?.status).toEqual({
      badge: 'disabled',
      reason: 'evaluation is off',
      subLabels: [],
      issues: [],
      errors: [],
      instances: []
    })
  })

  it("while evaluation is off an accumulator rule's status shows its retained total", () => {
    stored(hours)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.setEvaluation(false, 'admin')
    expect(application.rule('user', 'engine-hours')?.status).toMatchObject({
      badge: 'disabled',
      reason: 'evaluation is off',
      instances: [
        {
          badge: 'disabled',
          reason: 'evaluation is off',
          subLabels: [],
          progress: { kind: 'total', total: 20, limit: 1000 }
        }
      ]
    })
  })

  it('evaluation off stops evaluating and keeps the totals when its alerts cannot be cleared', () => {
    stored(oil)
    stored(hours)
    const core = new FakeAlertsCore()
    const { application, at } = setup(undefined, core)
    at(0, OIL, 0)
    at(0, RPM, 30)
    at(10)
    vi.spyOn(core, 'list').mockImplementation(() => {
      throw new Error('alerts unavailable')
    })

    expect(() => {
      application.setEvaluation(false, 'admin')
    }).toThrow('alerts unavailable')
    expect(application.evaluation.enabled).toBe(false)
    expect(new Store(dir).load().evaluation.enabled).toBe(false)
    expect(application.log()).toEqual([
      { at: WALL, actor: 'admin', action: 'evaluation', enabled: false }
    ])

    const writes = core.writes
    at(11, OIL, 0)
    at(11, RPM, 30)
    at(100)
    expect(core.writes).toBe(writes)
    expect(application.rules().map((r) => r.status)).toMatchObject([
      { badge: 'disabled', reason: 'evaluation is off' },
      { badge: 'disabled', reason: 'evaluation is off' }
    ])
    application.checkpoint()
    const totals: Partial<Checkpoints> = new Store(dir).load().accumulators
    expect(totals['user.engine-hours']?.['']).toBe(10)
  })

  it('a stored evaluation off is honoured at start: nothing is evaluated or cleared', () => {
    stored(oil)
    new Store(dir).saveEvaluation({ enabled: false, actor: 'admin', at: WALL })
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, OIL_ALERT, { priority: 'alarm', message: 'x', latching: false })
    const writes = core.writes
    const { at } = setup(undefined, core)
    at(0, OIL, 0)
    at(100)
    expect(core.writes).toBe(writes)
    expect(core.list().map((a) => [a.path, a.condition])).toEqual([[OIL_ALERT, true]])
  })

  it('evaluation on starts every rule fresh, clearing rather than adopting an alert core holds', () => {
    stored(oil)
    new Store(dir).saveEvaluation({ enabled: false })
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, OIL_ALERT, { priority: 'alarm', message: 'x', latching: false })
    const { application, at } = setup(undefined, core)

    at(10, OIL, 0)
    application.setEvaluation(true, 'admin')
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(false)
    at(14)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(false)
    at(15)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
    expect(application.log().map((e) => e.action)).toEqual(['evaluation'])
  })

  it('setting the evaluation switch to its current value changes and records nothing', () => {
    const { application } = setup()
    application.setEvaluation(true, 'admin')
    expect(application.evaluation).toEqual({ enabled: true })
    expect(application.log()).toEqual([])
  })

  it('accumulator totals are kept while evaluation is off, and edits while off keep them', () => {
    stored(hours)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.setEvaluation(false, 'admin')
    at(50)
    expect(
      application.replaceRule(hours.slug, { ...hours, message: 'Service the engine' }).ok
    ).toBe(true)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 20 } })

    // Turned on at 50 s, the rule starts from the cached value: still running.
    application.setEvaluation(true, 'admin')
    at(70)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 40 } })
  })

  it('a measure change while evaluation is off drops the total from the store at once', () => {
    stored(hours)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.setEvaluation(false, 'admin')
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 20 } })
    expect(application.replaceRule(hours.slug, integral).ok).toBe(true)
    expect(new Store(dir).load().accumulators).toEqual({})
  })

  it("an accumulator reset clears the rule's alert, zeroes its stored total and records the actor", () => {
    stored(shortHours)
    new Store(dir).saveCheckpoints({ 'user.engine-hours': { '': 8 } })
    const { application, at, alerts } = setup()
    at(0, RPM, 30)
    at(2)
    expect(alerts()).toEqual([['rules.user.engine-hours', true]])

    expect(application.resetAccumulator('user', 'engine-hours', 'skipper')).toBe('reset')
    expect(alerts()).toEqual([['rules.user.engine-hours', false]])
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 0 } })
    expect(application.log()).toEqual([
      { at: WALL, actor: 'skipper', action: 'reset', rule: 'user.engine-hours' }
    ])

    // It keeps accumulating from zero and raises again at the limit.
    at(11)
    expect(alerts()).toEqual([['rules.user.engine-hours', false]])
    at(12)
    expect(alerts()).toEqual([['rules.user.engine-hours', true]])
  })

  it('an accumulator reset while evaluation is off zeroes the retained total', () => {
    stored(hours)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.setEvaluation(false, 'admin')
    expect(application.resetAccumulator('user', 'engine-hours', 'admin')).toBe('reset')
    expect(new Store(dir).load().accumulators).toEqual({})
  })

  it('refuses to reset a rule that is not an accumulator or does not exist', () => {
    stored(oil)
    const { application } = setup()
    expect(application.resetAccumulator('user', 'oil-pressure-low', 'admin')).toBe('notAccumulator')
    expect(application.resetAccumulator('user', 'missing', 'admin')).toBe('notFound')
    expect(application.resetAccumulator('some-ruleset', 'oil-pressure-low', 'admin')).toBe(
      'notFound'
    )
    expect(application.log()).toEqual([])
  })

  it('deleting a rule records the actor', () => {
    stored(oil)
    const { application } = setup()
    application.deleteRule('oil-pressure-low', 'admin')
    expect(application.log()).toEqual([
      { at: WALL, actor: 'admin', action: 'delete', rule: 'user.oil-pressure-low' }
    ])
    expect(new Store(dir).load().log).toEqual([...application.log()].reverse())
  })

  it('logs a delete that dropped a total although the checkpoint after it failed', () => {
    stored(hours)
    const store = new Store(dir)
    const { application, at } = setup(store)
    at(0, RPM, 30)
    at(10)
    vi.spyOn(store, 'saveCheckpoints').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    expect(() => application.deleteRule(hours.slug, 'admin')).toThrow(/ENOSPC/)
    const entry = { at: WALL, actor: 'admin', action: 'delete', rule: 'user.engine-hours' }
    expect(application.log()).toEqual([entry])
    expect(new Store(dir).load().log).toEqual([entry])
  })

  it('logs a reset although the checkpoint after it failed', () => {
    stored(hours)
    const store = new Store(dir)
    const { application, at } = setup(store)
    at(0, RPM, 30)
    at(10)
    vi.spyOn(store, 'saveCheckpoints').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    expect(() => application.resetAccumulator('user', hours.slug, 'admin')).toThrow(/ENOSPC/)
    const entry = { at: WALL, actor: 'admin', action: 'reset', rule: 'user.engine-hours' }
    expect(application.log()).toEqual([entry])
    expect(new Store(dir).load().log).toEqual([entry])
  })

  it('keeps the most recent log entries, newest first', () => {
    // Hundreds of flushed writes would take seconds.
    const { application } = setup(new Store(dir, { ...fs, fsyncSync: () => undefined }))
    for (let i = 0; i < LOG_LIMIT + 5; i++) application.setEvaluation(i % 2 === 1, 'admin')
    const log = application.log()
    expect(log).toHaveLength(LOG_LIMIT)
    // The last action, the 205th, turned evaluation off.
    expect(log[0]).toMatchObject({ enabled: false })
    expect(new Store(dir).load().log).toHaveLength(LOG_LIMIT)
  })

  it('previews an edit that clears the active alert, and one re-evaluated in place', () => {
    stored(oil)
    const { application, at } = setup()
    at(0, OIL, 0)
    at(5)

    const retyped = { ...oil, detector: { type: 'match', op: 'equals', value: 0 } }
    const clearing = application.previewRule('oil-pressure-low', retyped)
    expect(clearing).toMatchObject({
      ok: true,
      value: { restarts: true, activeAlerts: 1, clearsActiveAlert: true }
    })
    if (clearing.ok) expect(clearing.value.changes).toContain('detector.type')

    const limit = { ...oil, detector: { ...oil.detector, limit: { kind: 'fixed', value: 90000 } } }
    expect(application.previewRule('oil-pressure-low', limit)).toEqual({
      ok: true,
      value: {
        restarts: false,
        changes: [],
        activeAlerts: 1,
        clearsActiveAlert: false,
        discardsTotal: false
      }
    })
    // A preview changes nothing.
    expect(application.userRules()[0]).toMatchObject({ detector: { type: 'sustained' } })
  })

  it('a structural edit of a rule without an active alert restarts it and clears nothing', () => {
    stored(oil)
    const { application } = setup()
    const reversed = { ...oil, detector: { ...oil.detector, direction: 'above' } }
    expect(application.previewRule('oil-pressure-low', reversed)).toEqual({
      ok: true,
      value: {
        restarts: true,
        changes: ['detector.direction'],
        activeAlerts: 0,
        clearsActiveAlert: false,
        discardsTotal: false
      }
    })
  })

  it('previews any edit of a rule that failed to start as a restart clearing its adopted alert', () => {
    const battery = {
      name: 'House battery low',
      slug: 'house-battery-low',
      message: 'House battery voltage is low',
      signal: { path: 'electrical.batteries.house.voltage' },
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'zone', level: 'warn' } }
    }
    stored(battery)
    const core = new FakeAlertsCore()
    const alert = 'rules.user.house-battery-low'
    core.ingest(PLUGIN, alert, { priority: 'warning', message: 'x', latching: false })
    const { application } = setup(undefined, core, () => {
      throw new Error('meta unreadable')
    })
    expect(application.rule('user', battery.slug)?.status.badge).toBe('errored')

    const reworded = { ...battery, message: 'Check the battery' }
    expect(application.previewRule(battery.slug, reworded)).toEqual({
      ok: true,
      value: {
        restarts: true,
        changes: [],
        activeAlerts: 1,
        clearsActiveAlert: true,
        discardsTotal: false
      }
    })
    expect(application.replaceRule(battery.slug, reworded).ok).toBe(true)
    expect(core.getByPath(alert)?.condition).toBe(false)
  })

  it('create refuses an existing slug; replace and preview need an existing rule with the same slug', () => {
    stored(oil)
    const { application } = setup()
    expect(application.createRule(oil)).toEqual({ ok: false, reason: 'exists' })
    expect(application.createRule({ ...oil, priority: 'loud' })).toMatchObject({
      ok: false,
      reason: 'invalid'
    })
    expect(application.replaceRule('coolant-high', coolant)).toEqual({
      ok: false,
      reason: 'notFound'
    })
    expect(application.replaceRule('oil-pressure-low', coolant)).toEqual({
      ok: false,
      reason: 'slugMismatch'
    })
    expect(application.previewRule('coolant-high', coolant)).toEqual({
      ok: false,
      reason: 'notFound'
    })
    expect(application.createRule(coolant)).toMatchObject({ ok: true })
    expect(application.replaceRule('coolant-high', { ...coolant, message: 'Hot' })).toMatchObject({
      ok: true
    })
  })

  it('lists every rule with its origin, slug and status', () => {
    stored(oil)
    const { application, at } = setup()
    at(0, OIL, 0)
    at(5)
    const [entry] = application.rules()
    expect(entry).toMatchObject({ origin: 'user', slug: 'oil-pressure-low', rule: oil })
    expect(entry.status.badge).toBe('alertActive')
    expect(application.rule('user', 'oil-pressure-low')?.status.badge).toBe('alertActive')
    expect(application.rule('user', 'missing')).toBeUndefined()
    expect(application.rule('ruleset', 'oil-pressure-low')).toBeUndefined()
  })
})

describe('application accumulator totals across edits', () => {
  const ID = 'user.engine-hours'
  const total = () => {
    const totals: Partial<Checkpoints> = new Store(dir).load().accumulators
    return totals[ID]?.['']
  }

  it('replacing a stored rule that failed validation with the same measure keeps its total', () => {
    stored(brokenHours)
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    const { application, at } = setup()
    expect(application.issues.join('\n')).toMatch(/engine-hours is not valid/)
    expect(application.previewRule(hours.slug, hours)).toMatchObject({
      ok: true,
      value: { discardsTotal: false }
    })

    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(total()).toBe(120)
  })

  it('replacing a stored rule whose file names another slug with the same measure keeps its total', () => {
    fs.mkdirSync(join(dir, 'rules'), { recursive: true })
    writeFileSync(
      join(dir, 'rules', 'engine-hours.json'),
      JSON.stringify({ ...hours, slug: 'other-hours' })
    )
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    const { application, at } = setup()
    expect(application.issues.join('\n')).toMatch(/engine-hours has the slug other-hours/)

    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(total()).toBe(120)
  })

  it('with evaluation off, the replaced rule keeps the total until evaluation is on', () => {
    stored(brokenHours)
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    new Store(dir).saveEvaluation({ enabled: false })
    const { application, at } = setup()

    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    application.checkpoint()
    expect(total()).toBe(100)
    application.setEvaluation(true, 'admin')
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(total()).toBe(120)
  })

  it('turning evaluation on when the runner cannot start keeps it off and keeps the totals', () => {
    stored(hours)
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    new Store(dir).saveEvaluation({ enabled: false })
    const core = new FakeAlertsCore()
    const { application } = setup(new Store(dir), core)
    const before = readFileSync(join(dir, 'evaluation.json'), 'utf8')
    vi.spyOn(core, 'list').mockImplementation(() => {
      throw new Error('alerts unavailable')
    })

    expect(() => {
      application.setEvaluation(true, 'admin')
    }).toThrow('alerts unavailable')
    expect(application.evaluation.enabled).toBe(false)
    expect(readFileSync(join(dir, 'evaluation.json'), 'utf8')).toBe(before)
    expect(application.rules()[0]?.status).toMatchObject({
      badge: 'disabled',
      reason: 'evaluation is off'
    })
    new Store(dir).saveCheckpoints({})
    application.checkpoint()
    expect(total()).toBe(100)
  })

  it('turning evaluation on when the switch cannot be saved stops the started runner', () => {
    stored(hours)
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    new Store(dir).saveEvaluation({ enabled: false })
    const store = new Store(dir)
    const { application, at } = setup(store)
    vi.spyOn(store, 'saveEvaluation').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })

    expect(() => {
      application.setEvaluation(true, 'admin')
    }).toThrow('ENOSPC')
    expect(application.evaluation.enabled).toBe(false)
    expect(application.rules()[0]?.status).toMatchObject({
      badge: 'disabled',
      reason: 'evaluation is off'
    })
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(total()).toBe(100)
  })

  it('replacing a stored rule that failed validation with another measure drops its total at once', () => {
    stored(brokenHours)
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    const { application } = setup()
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      ok: true,
      value: { discardsTotal: true }
    })
    expect(application.replaceRule(hours.slug, integral).ok).toBe(true)
    expect(total()).toBe(0)
  })

  it('replacing a stored rule that is not an accumulator drops the total whatever its measure', () => {
    stored({ ...hours, detector: { type: 'sustained', measure: 'time', limit: 1000 } })
    new Store(dir).saveCheckpoints({ [ID]: { '': 100 } })
    const { application } = setup()
    expect(application.issues.join('\n')).toMatch(/engine-hours is not valid/)
    expect(application.previewRule(hours.slug, hours)).toMatchObject({
      value: { discardsTotal: true }
    })
    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    expect(total()).toBe(0)
  })

  it('a measure change survives a crash right after it: the new rule does not inherit the total', () => {
    stored(hours)
    const first = setup()
    first.at(0, RPM, 30)
    first.at(10)
    first.application.checkpoint()
    expect(first.application.replaceRule(hours.slug, integral).ok).toBe(true)

    // No stop: the process died before the next checkpoint.
    const second = setup()
    second.application.checkpoint()
    expect(total()).toBe(0)
  })

  it('a delete and re-create survives a crash right after it: the new rule starts from zero', () => {
    stored(hours)
    const first = setup()
    first.at(0, RPM, 30)
    first.at(10)
    first.application.checkpoint()
    first.application.deleteRule(hours.slug, 'admin')
    expect(first.application.createRule(hours).ok).toBe(true)

    const second = setup()
    second.at(0, RPM, 30)
    second.at(5)
    second.application.checkpoint()
    expect(total()).toBe(5)
  })

  it('the preview does not count a zero total, running or retained, as discarded', () => {
    stored(hours)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(10)
    application.resetAccumulator('user', hours.slug, 'admin')
    at(10, RPM, 30)
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      value: { discardsTotal: false }
    })
    application.setEvaluation(false, 'admin')
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      value: { discardsTotal: false }
    })
  })

  it('the preview says whether an edit discards a running or retained total', () => {
    stored(hours)
    stored(oil)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(10)
    const reworded = { ...hours, message: 'Service the engine' }
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      value: { discardsTotal: true }
    })
    expect(application.previewRule(hours.slug, reworded)).toMatchObject({
      value: { discardsTotal: false }
    })
    expect(application.previewRule(oil.slug, { ...oil, message: 'x' })).toMatchObject({
      value: { discardsTotal: false }
    })

    application.setEvaluation(false, 'admin')
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      value: { discardsTotal: true }
    })
    expect(application.previewRule(hours.slug, reworded)).toMatchObject({
      value: { discardsTotal: false }
    })
  })
})

describe('rule controls', () => {
  const OIL_ALERT = 'rules.user.oil-pressure-low'
  const AUX_RPM = 'propulsion.aux.revolutions'
  const rpmHigh = {
    name: 'RPM high',
    slug: 'rpm-high',
    message: 'Engine revolutions are high',
    priority: 'warning',
    signal: { path: RPM },
    detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 60 } }
  }
  const rpmMismatch = {
    ...rpmHigh,
    name: 'RPM mismatch',
    slug: 'rpm-mismatch',
    signal: { combinator: 'absDifference', inputs: [{ path: RPM }, { path: AUX_RPM }] },
    detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 3 } }
  }
  const gatedCoolant = {
    ...coolant,
    detector: { ...coolant.detector, duration: 0 },
    gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
  }

  describe('enable', () => {
    it('disabling clears the alert, stops evaluating and reports the disabled badge', () => {
      stored(oil)
      const { application, at, alerts } = setup()
      at(0, OIL, 0)
      at(5)
      expect(alerts()).toEqual([[OIL_ALERT, true]])

      expect(application.setEnabled('user', 'oil-pressure-low', false, 'skipper')).toBe('ok')
      expect(alerts()).toEqual([[OIL_ALERT, false]])
      at(6, OIL, 0)
      at(100)
      expect(alerts()).toEqual([[OIL_ALERT, false]])
      expect(application.rule('user', 'oil-pressure-low')).toMatchObject({
        enabled: false,
        status: { badge: 'disabled', reason: 'disabled', instances: [] }
      })
      expect(application.log()).toEqual([
        { at: WALL, actor: 'skipper', action: 'disable', rule: 'user.oil-pressure-low' }
      ])
    })

    it('enabling starts the rule as a new one, keeping its accumulator total', () => {
      stored(hours)
      const { application, at } = setup()
      at(0, RPM, 30)
      at(20)
      application.setEnabled('user', 'engine-hours', false, 'admin')
      at(50)
      expect(application.rule('user', 'engine-hours')?.status.instances[0]?.progress).toEqual({
        kind: 'total',
        total: 20,
        limit: 1000
      })
      application.checkpoint()
      expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 20 } })

      expect(application.setEnabled('user', 'engine-hours', true, 'admin')).toBe('ok')
      at(60)
      expect(application.rule('user', 'engine-hours')?.status).toMatchObject({
        badge: 'idle',
        instances: [{ progress: { kind: 'total', total: 30 } }]
      })
      expect(application.log().map((e) => e.action)).toEqual(['enable', 'disable'])
    })

    it('stays disabled across a restart, and an edit while disabled does not start it', () => {
      stored(oil)
      const first = setup()
      first.application.setEnabled('user', 'oil-pressure-low', false, 'admin')
      expect(first.application.replaceRule(oil.slug, { ...oil, message: 'Check oil' }).ok).toBe(
        true
      )
      first.at(0, OIL, 0)
      first.at(10)
      expect(first.alerts()).toEqual([])
      first.application.stop()

      const second = setup(new Store(dir), first.server.core)
      second.at(20, OIL, 0)
      second.at(30)
      expect(second.alerts()).toEqual([])
      expect(second.application.rule('user', 'oil-pressure-low')?.enabled).toBe(false)
    })

    it('setting the current value changes and records nothing; an unknown rule is not found', () => {
      stored(oil)
      const { application } = setup()
      expect(application.setEnabled('user', 'oil-pressure-low', true, 'admin')).toBe('ok')
      expect(application.setEnabled('user', 'missing', false, 'admin')).toBe('notFound')
      expect(application.setEnabled('some-ruleset', 'oil-pressure-low', false, 'admin')).toBe(
        'notFound'
      )
      expect(application.log()).toEqual([])
      expect(existsSync(join(dir, 'controls.json'))).toBe(false)
    })

    it('deleting a rule deletes its controls, so a new rule with its slug starts enabled', () => {
      stored(oil)
      const { application, at, alerts } = setup()
      application.setEnabled('user', 'oil-pressure-low', false, 'admin')
      application.setNote('user', 'oil-pressure-low', 'sender replaced', 'admin')
      application.deleteRule('oil-pressure-low', 'admin')
      expect(new Store(dir).load().controls).toEqual({ rules: {}, inputs: {} })
      expect(application.createRule(oil).ok).toBe(true)
      at(0, OIL, 0)
      at(5)
      expect(alerts()).toEqual([[OIL_ALERT, true]])
    })
  })

  describe('note', () => {
    it('sets and removes a rule note, persisted and recorded', () => {
      stored(oil)
      const { application } = setup()
      expect(application.setNote('user', 'oil-pressure-low', 'sender replaced', 'admin')).toBe('ok')
      expect(application.rule('user', 'oil-pressure-low')?.note).toBe('sender replaced')
      expect(new Store(dir).load().controls.rules).toEqual({
        'user.oil-pressure-low': { enabled: true, note: 'sender replaced' }
      })
      application.setNote('user', 'oil-pressure-low', '', 'admin')
      expect(application.rule('user', 'oil-pressure-low')?.note).toBeUndefined()
      expect(new Store(dir).load().controls.rules).toEqual({})
      expect(application.log().map((e) => e.action)).toEqual(['note', 'note'])
      expect(application.setNote('user', 'missing', 'x', 'admin')).toBe('notFound')
    })
  })

  describe('rule suppression', () => {
    it('clears an active alert and prevents a re-raise while the condition holds', () => {
      stored(oil)
      const { application, at, alerts } = setup()
      at(0, OIL, 0)
      at(5)
      expect(
        application.suppressRule('user', 'oil-pressure-low', { note: 'bad sender' }, 'admin')
      ).toBe('ok')
      expect(alerts()).toEqual([[OIL_ALERT, false]])
      at(6, OIL, 0)
      at(100)
      expect(alerts()).toEqual([[OIL_ALERT, false]])
      expect(application.rule('user', 'oil-pressure-low')).toMatchObject({
        suppression: { since: WALL, actor: 'admin', note: 'bad sender' },
        status: { badge: 'suppressed', suppression: { scope: 'rule' } }
      })
    })

    it('ending it raises an alert whose condition still holds as a new alert', () => {
      stored(oil)
      const { application, at, alerts, server } = setup()
      application.suppressRule('user', 'oil-pressure-low', {}, 'admin')
      at(0, OIL, 0)
      at(10)
      expect(alerts()).toEqual([])
      expect(application.endRuleSuppression('user', 'oil-pressure-low', 'admin')).toBe('ok')
      expect(alerts()).toEqual([[OIL_ALERT, true]])
      expect(server.core.alertings).toBe(1)
      expect(application.rule('user', 'oil-pressure-low')?.suppression).toBeUndefined()
      expect(application.log().map((e) => e.action)).toEqual(['unsuppress', 'suppress'])
    })

    it('refuses to end a suppression that does not exist', () => {
      stored(oil)
      const { application } = setup()
      expect(application.endRuleSuppression('user', 'oil-pressure-low', 'admin')).toBe(
        'notSuppressed'
      )
      expect(application.endRuleSuppression('user', 'missing', 'admin')).toBe('notFound')
      expect(application.suppressRule('user', 'missing', {}, 'admin')).toBe('notFound')
      expect(application.log()).toEqual([])
    })

    it('survives a restart', () => {
      stored(oil)
      const first = setup()
      first.at(0, OIL, 0)
      first.at(5)
      first.application.suppressRule('user', 'oil-pressure-low', { autoEndAfter: 60 }, 'admin')
      first.application.stop()

      const second = setup(new Store(dir), first.server.core)
      second.at(10, OIL, 0)
      second.at(100)
      expect(second.alerts()).toEqual([[OIL_ALERT, false]])
      expect(second.application.suppressions()).toEqual([
        {
          scope: 'rule',
          rule: 'user.oil-pressure-low',
          since: WALL,
          actor: 'admin',
          autoEndAfter: 60
        }
      ])
    })

    it('an auto-end suppression on a fault that never clears stays and waits for clear', () => {
      stored(oil)
      const { application, at, alerts } = setup()
      at(0, OIL, 0)
      at(5)
      application.suppressRule('user', 'oil-pressure-low', { autoEndAfter: 60 }, 'admin')
      for (let t = 6; t <= 600; t += 1) at(t)
      expect(alerts()).toEqual([[OIL_ALERT, false]])
      expect(application.rule('user', 'oil-pressure-low')?.status).toMatchObject({
        badge: 'suppressed',
        suppression: { scope: 'rule', autoEndAfter: 60 },
        subLabels: ['waitingForClear']
      })
      expect(application.suppressions()).toHaveLength(1)
    })

    it('a clear shorter than the auto-end time does not end it; a long enough one does', () => {
      stored(oil)
      const { application, at, alerts } = setup()
      at(0, OIL, 0)
      at(5)
      application.suppressRule('user', 'oil-pressure-low', { autoEndAfter: 60 }, 'admin')
      at(10, OIL, 200000)
      for (let t = 11; t <= 50; t += 1) at(t)
      // The fault returns for long enough to hold again, then clears.
      at(50, OIL, 0)
      for (let t = 51; t <= 55; t += 1) at(t)
      at(56, OIL, 200000)
      for (let t = 57; t <= 115; t += 1) at(t)
      expect(application.suppressions()).toHaveLength(1)
      at(116)
      expect(application.suppressions()).toEqual([])
      expect(application.log()[0]).toEqual({
        at: WALL,
        actor: 'auto-end',
        action: 'unsuppress',
        rule: 'user.oil-pressure-low'
      })
      // Nothing to raise: the condition is clear.
      expect(alerts()).toEqual([[OIL_ALERT, false]])
    })

    it('time out of use because a gate does not hold does not count toward its auto-end', () => {
      stored(gatedCoolant)
      const { application, at } = setup()
      at(0, RPM, 70)
      at(0, COOLANT, 380)
      application.suppressRule('user', 'coolant-high', { autoEndAfter: 60 }, 'admin')
      // The engine stops overnight with the fault still there.
      at(1, RPM, 0)
      for (let t = 2; t <= 600; t += 1) at(t)
      expect(application.suppressions()).toHaveLength(1)
      // Running again with the fault fixed, it counts from then.
      at(600, COOLANT, 300)
      at(600, RPM, 70)
      at(659)
      expect(application.suppressions()).toHaveLength(1)
      at(660)
      expect(application.suppressions()).toEqual([])
    })

    it('an auto-end that cannot be saved stays, is retried, and does not hold back the others', () => {
      /** Refuses the write that would end the oil rule's suppression while `full`. */
      class FullForOil extends Store {
        full = true
        override saveControls(controls: Controls): void {
          // A rule back at its default controls has no entry.
          const ending = !Object.hasOwn(controls.rules, 'user.oil-pressure-low')
          if (this.full && ending) throw new Error('no space left on device')
          super.saveControls(controls)
        }
      }
      stored(oil)
      stored(coolant)
      const store = new FullForOil(dir)
      const { application, at } = setup(store)
      at(0, OIL, 200000)
      at(0, COOLANT, 300)
      application.suppressRule('user', 'oil-pressure-low', { autoEndAfter: 10 }, 'admin')
      application.suppressRule('user', 'coolant-high', { autoEndAfter: 10 }, 'admin')

      expect(() => {
        at(10)
      }).toThrow(/user\.oil-pressure-low.*no space left on device/)
      expect(application.suppressions()).toMatchObject([
        { scope: 'rule', rule: 'user.oil-pressure-low' }
      ])
      expect(() => {
        at(11)
      }).toThrow(/no space left/)

      store.full = false
      at(12)
      expect(application.suppressions()).toEqual([])
    })

    it('a clear before the suppression started does not count, even across a pause', () => {
      stored(gatedCoolant)
      const { application, at } = setup()
      at(0, RPM, 70)
      at(0, COOLANT, 300)
      at(100)
      application.suppressRule('user', 'coolant-high', { autoEndAfter: 60 }, 'admin')
      at(100, RPM, 0)
      at(1000, RPM, 70)
      at(1010)
      expect(application.suppressions()).toHaveLength(1)
      at(1059)
      expect(application.suppressions()).toHaveLength(1)
      at(1060)
      expect(application.suppressions()).toEqual([])
    })

    it('a clear before the suppression started does not count toward its auto-end', () => {
      stored(oil)
      const { application, at } = setup()
      at(0, OIL, 200000)
      at(100)
      application.suppressRule('user', 'oil-pressure-low', { autoEndAfter: 60 }, 'admin')
      at(101)
      expect(application.suppressions()).toHaveLength(1)
      at(160)
      expect(application.suppressions()).toEqual([])
    })
  })

  describe('input suppression', () => {
    function running() {
      stored(rpmHigh)
      stored(rpmMismatch)
      stored(gatedCoolant)
      const s = setup()
      s.at(0, RPM, 70)
      s.at(0, AUX_RPM, 20)
      s.at(0, COOLANT, 380)
      expect(s.alerts()).toEqual([
        ['rules.user.rpm-high', true],
        ['rules.user.rpm-mismatch', true],
        ['rules.user.coolant-high', true]
      ])
      return s
    }

    it('suppresses the direct and the combinator rule, and freezes the gated rule', () => {
      const { application, at, alerts } = running()
      application.suppressInput(RPM, { note: 'tach sender' }, 'admin')
      expect(alerts()).toEqual([
        ['rules.user.rpm-high', false],
        ['rules.user.rpm-mismatch', false],
        ['rules.user.coolant-high', true]
      ])
      at(1, RPM, 0)
      at(2)
      expect(alerts()).toEqual([
        ['rules.user.rpm-high', false],
        ['rules.user.rpm-mismatch', false],
        ['rules.user.coolant-high', true]
      ])
      expect(application.rule('user', 'rpm-high')?.status).toMatchObject({
        badge: 'suppressed',
        suppression: { scope: 'input', path: RPM }
      })
      expect(application.suppressions()).toEqual([
        { scope: 'input', path: RPM, since: WALL, actor: 'admin', note: 'tach sender' }
      ])
      expect(application.log()[0]).toEqual({
        at: WALL,
        actor: 'admin',
        action: 'suppress',
        path: RPM
      })
    })

    it('the preview lists the suppressed rules and the gated rule at its current gate state', () => {
      const { application } = running()
      expect(application.previewInputSuppression(RPM)).toEqual({
        path: RPM,
        suppresses: [{ rule: 'user.rpm-high' }, { rule: 'user.rpm-mismatch' }],
        freezes: [{ rule: 'user.coolant-high', gate: 0, states: [{ holds: true }] }]
      })
      expect(application.suppressions()).toEqual([])
    })

    it('the preview names the wildcard instance a path suppresses', () => {
      stored({ ...oil, signal: { path: 'propulsion.*.oilPressure' } })
      const { application } = setup()
      expect(application.previewInputSuppression('propulsion.port.oilPressure')).toEqual({
        path: 'propulsion.port.oilPressure',
        suppresses: [{ rule: 'user.oil-pressure-low', instance: 'port' }],
        freezes: []
      })
    })

    it('ending it lets the rules raise again; ending one that does not exist is refused', () => {
      const { application, alerts } = running()
      application.suppressInput(RPM, {}, 'admin')
      expect(application.endInputSuppression(RPM, 'admin')).toBe(true)
      expect(alerts()).toEqual([
        ['rules.user.rpm-high', true],
        ['rules.user.rpm-mismatch', true],
        ['rules.user.coolant-high', true]
      ])
      expect(application.endInputSuppression(RPM, 'admin')).toBe(false)
      expect(application.log().map((e) => e.action)).toEqual(['unsuppress', 'suppress'])
    })

    it('auto-ends once every rule instance it suppresses directly has stayed clear', () => {
      const { application, at } = running()
      application.suppressInput(RPM, { autoEndAfter: 30 }, 'admin')
      // The mismatch clears at 10 s; both clear from 20 s.
      at(10, AUX_RPM, 68)
      at(20, RPM, 59)
      at(20, AUX_RPM, 60)
      at(49)
      expect(application.suppressions()).toHaveLength(1)
      at(50)
      expect(application.suppressions()).toEqual([])
      expect(application.log()[0]).toMatchObject({ actor: 'auto-end', path: RPM })
    })

    it('a clear before it started does not count toward its auto-end', () => {
      stored(rpmHigh)
      const { application, at } = setup()
      at(0, RPM, 50)
      at(100)
      application.suppressInput(RPM, { autoEndAfter: 60 }, 'admin')
      at(101)
      at(159)
      expect(application.suppressions()).toHaveLength(1)
      at(160)
      expect(application.suppressions()).toEqual([])
    })

    it('survives a restart', () => {
      const first = running()
      first.application.suppressInput(RPM, {}, 'admin')
      first.application.stop()
      const second = setup(new Store(dir), first.server.core)
      second.at(10, RPM, 70)
      second.at(20)
      expect(second.alerts()).toContainEqual(['rules.user.rpm-high', false])
      expect(second.application.suppressions()).toMatchObject([{ scope: 'input', path: RPM }])
    })

    /**
     * Suppresses the tach path while the engine runs, then lets the coolant
     * alert clear, so a later raise needs the frozen gate to hold.
     */
    function frozenRunning() {
      const s = running()
      s.application.suppressInput(RPM, {}, 'admin')
      s.at(1, COOLANT, 300)
      expect(s.alerts()).toContainEqual(['rules.user.coolant-high', false])
      return s
    }

    /** The engine seems to stop, but the gate is frozen holding: coolant 390 alerts. */
    function expectFrozenHolding(s: ReturnType<typeof setup>, t: number) {
      s.at(t, RPM, 0)
      s.at(t, COOLANT, 390)
      expect(s.alerts()).toContainEqual(['rules.user.coolant-high', true])
    }

    it('stores the gate states it freezes with the suppression', () => {
      frozenRunning()
      expect(new Store(dir).load().controls.inputs[RPM]).toMatchObject({
        frozen: { 'user.coolant-high': { '0': { '': true } } }
      })
    })

    it('a gate keeps its frozen state across a plugin restart', () => {
      const first = frozenRunning()
      first.application.stop()
      const second = setup(new Store(dir), first.server.core)
      expectFrozenHolding(second, 10)
    })

    it('a gate keeps its frozen state across evaluation off and on', () => {
      const s = frozenRunning()
      s.application.setEvaluation(false, 'admin')
      s.application.setEvaluation(true, 'admin')
      expectFrozenHolding(s, 10)
    })

    it('a gate keeps its frozen state across disable and enable', () => {
      const s = frozenRunning()
      s.application.setEnabled('user', 'coolant-high', false, 'admin')
      s.application.setEnabled('user', 'coolant-high', true, 'admin')
      expectFrozenHolding(s, 10)
    })

    it('a gate keeps its frozen state across a structural edit', () => {
      const s = frozenRunning()
      const edited = { ...gatedCoolant, gates: [{ ...gatedCoolant.gates[0], hysteresis: 1 }] }
      expect(s.application.previewRule('coolant-high', edited)).toMatchObject({
        ok: true,
        value: { restarts: true }
      })
      expect(s.application.replaceRule('coolant-high', edited).ok).toBe(true)
      expectFrozenHolding(s, 10)
    })

    it('a gate with no stored state takes one reading and then freezes', () => {
      stored(gatedCoolant)
      const s = setup()
      s.application.setEvaluation(false, 'admin')
      s.application.suppressInput(RPM, {}, 'admin')
      s.application.setEvaluation(true, 'admin')
      s.at(1, RPM, 70)
      expectFrozenHolding(s, 2)
    })

    it('drops the stored gate states when the suppression ends', () => {
      const s = frozenRunning()
      s.application.endInputSuppression(RPM, 'admin')
      expect(new Store(dir).load().controls.inputs).toEqual({})
      s.at(5, RPM, 0)
      s.at(5, COOLANT, 390)
      expect(s.alerts()).toContainEqual(['rules.user.coolant-high', false])
    })

    it('the suppression as listed does not carry the stored gate states', () => {
      const s = running()
      expect(s.application.suppressInput(RPM, {}, 'admin')).not.toHaveProperty('frozen')
      expect(s.application.suppressions()[0]).not.toHaveProperty('frozen')
    })
  })
})
