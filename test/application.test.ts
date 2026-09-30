import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Value } from '@signalk/server-api'
import { Application, LOG_LIMIT } from '../src/application.js'
import { serverDeps } from '../src/alerts/server.js'
import { Store } from '../src/store/store.js'
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

function setup(store = new Store(dir), core = new FakeAlertsCore()) {
  const server = new MockServerAPI(true, dir, core)
  let now = 0
  const deps = {
    ...serverDeps(server.asServerAPI(), PLUGIN),
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
    expect(application.rules()[0]?.status).toBeNull()
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
      value: { restarts: false, changes: [], activeAlerts: 1, clearsActiveAlert: false }
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
        clearsActiveAlert: false
      }
    })
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
    expect(entry.status?.badge).toBe('alertActive')
    expect(application.rule('user', 'oil-pressure-low')?.status?.badge).toBe('alertActive')
    expect(application.rule('user', 'missing')).toBeUndefined()
    expect(application.rule('ruleset', 'oil-pressure-low')).toBeUndefined()
  })
})
