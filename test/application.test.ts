import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Value } from '@signalk/server-api'
import { Application, LOG_LIMIT } from '../src/application.js'
import type { RunnerDeps } from '../src/alerts/runner.js'
import { serverDeps } from '../src/alerts/server.js'
import { Store, type Checkpoints } from '../src/store/store.js'
import { instantiate } from '../src/templates/instantiate.js'
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
    expect(application.allRules().map((r) => r.slug)).toEqual(['oil-pressure-low', 'coolant-high'])

    // The oil rule's timer kept running across the save: it raises 5 s after
    // its value, not 5 s after the save.
    at(4)
    expect(alerts()).toEqual([])
    at(5)
    expect(alerts()).toEqual([['rules.oil-pressure-low', true]])

    at(5, COOLANT, 380)
    at(7)
    expect(alerts()).toContainEqual(['rules.coolant-high', true])
  })

  it('an edit persists and applies to the running rule', () => {
    stored(oil)
    const { application, at, server } = setup()
    at(0, OIL, 0)
    at(5)
    expect(application.replaceRule(oil.slug, { ...oil, message: 'Check the oil' }).ok).toBe(true)
    at(25)
    expect(server.core.getByPath('rules.oil-pressure-low')?.message).toBe('Check the oil')
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
    expect(application.allRules()).toEqual([])
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
    expect(application.allRules()).toEqual([])
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
        ['rules.oil-pressure-low', false],
        ['rules.coolant-high', true]
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
    expect(alerts()).toEqual([['rules.oil-pressure-low', true]])

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
    expect(application.allRules().map((r) => r.slug)).toEqual(['oil-pressure-low'])
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
    expect(application.allRules().map((r) => r.slug)).toEqual(['oil-pressure-low'])
  })

  it("checkpoints running totals and keeps a skipped rule's until it is deleted", () => {
    stored(hours)
    stored({ ...hours, slug: 'genset-hours', priority: 'loud' })
    new Store(dir).saveCheckpoints({
      'engine-hours': { measure: 'time', totals: { '': 100 } },
      'genset-hours': { measure: 'time', totals: { '': 50 } }
    })
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 120 } },
      'genset-hours': { measure: 'time', totals: { '': 50 } }
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
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 20 } }
    })
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
    expect(alerts()).toEqual([['rules.oil-pressure-low', true]])
    expect(server.core.writes).toBe(sent)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 5 } }
    })
  })
})

describe('application operator actions', () => {
  const OIL_ALERT = 'rules.oil-pressure-low'
  // Not caution: core drops a cleared caution alert, which the tests read back.
  const shortHours = { ...hours, priority: 'warning', detector: { ...hours.detector, limit: 10 } }

  it('ignores a stored evaluation switch set to off: start evaluates', () => {
    stored(oil)
    writeFileSync(join(dir, 'evaluation.json'), JSON.stringify({ enabled: false }))
    const { at, alerts } = setup()
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([[OIL_ALERT, true]])
  })

  it('start adopts the active alerts SKAR has in core rather than clearing them', () => {
    stored(oil)
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, OIL_ALERT, { priority: 'alarm', message: oil.message, latching: false })
    // A clear and re-raise would keep the condition but lose the acknowledgement.
    core.acknowledge(OIL_ALERT)
    const { at, alerts } = setup(undefined, core)
    expect(core.getByPath(OIL_ALERT)).toMatchObject({ condition: true, state: 'acknowledged' })
    at(0, OIL, 0)
    at(4)
    expect(alerts()).toEqual([[OIL_ALERT, true]])
    expect(core.getByPath(OIL_ALERT)).toMatchObject({ condition: true, state: 'acknowledged' })
  })

  it('a rule is not evaluated before start, and says so', () => {
    stored(oil)
    const server = new MockServerAPI(true, dir, new FakeAlertsCore())
    const application = new Application(serverDeps(server.asServerAPI(), PLUGIN), new Store(dir))
    expect(application.rule(oil.slug)?.status).toMatchObject({
      badge: 'inactive',
      reason: 'not started'
    })
  })

  it('accumulator totals keep counting while a rule is disabled, and edits while disabled keep them', () => {
    stored(hours)
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.disableRule(hours.slug, undefined, 'admin')
    at(50)
    expect(
      application.replaceRule(hours.slug, { ...hours, message: 'Service the engine' }).ok
    ).toBe(true)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 50 } }
    })

    application.enableRule(hours.slug, 'admin')
    at(70)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 70 } }
    })
  })

  it("an accumulator reset clears the rule's alert, zeroes its stored total and records the actor", () => {
    stored(shortHours)
    new Store(dir).saveCheckpoints({ 'engine-hours': { measure: 'time', totals: { '': 8 } } })
    const { application, at, alerts } = setup()
    at(0, RPM, 30)
    at(2)
    expect(alerts()).toEqual([['rules.engine-hours', true]])

    expect(application.resetAccumulator('engine-hours', 'skipper')).toBe('reset')
    expect(alerts()).toEqual([['rules.engine-hours', false]])
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 0 } }
    })
    expect(application.log()).toEqual([
      { at: WALL, actor: 'skipper', action: 'reset', rule: 'engine-hours' }
    ])

    // It keeps accumulating from zero and raises again at the limit.
    at(11)
    expect(alerts()).toEqual([['rules.engine-hours', false]])
    at(12)
    expect(alerts()).toEqual([['rules.engine-hours', true]])
  })

  it('refuses to reset a rule that is not an accumulator or does not exist', () => {
    stored(oil)
    const { application } = setup()
    expect(application.resetAccumulator('oil-pressure-low', 'admin')).toBe('notAccumulator')
    expect(application.resetAccumulator('missing', 'admin')).toBe('notFound')
    expect(application.log()).toEqual([])
  })

  it('deleting a rule records the actor', () => {
    stored(oil)
    const { application } = setup()
    application.deleteRule('oil-pressure-low', 'admin')
    expect(application.log()).toEqual([
      { at: WALL, actor: 'admin', action: 'delete', rule: 'oil-pressure-low' }
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
    const entry = { at: WALL, actor: 'admin', action: 'delete', rule: 'engine-hours' }
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
    expect(() => application.resetAccumulator(hours.slug, 'admin')).toThrow(/ENOSPC/)
    const entry = { at: WALL, actor: 'admin', action: 'reset', rule: 'engine-hours' }
    expect(application.log()).toEqual([entry])
    expect(new Store(dir).load().log).toEqual([entry])
  })

  it('keeps the most recent log entries, newest first', () => {
    // Hundreds of flushed writes would take seconds.
    stored(oil)
    const { application } = setup(new Store(dir, { ...fs, fsyncSync: () => undefined }))
    for (let i = 0; i < LOG_LIMIT + 5; i++) {
      if (i % 2 === 0) application.disableRule(oil.slug, undefined, 'admin')
      else application.enableRule(oil.slug, 'admin')
    }
    const log = application.log()
    expect(log).toHaveLength(LOG_LIMIT)
    // The last action, the 205th, disabled the rule.
    expect(log[0]).toMatchObject({ action: 'disable' })
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
    expect(application.allRules()[0]).toMatchObject({ detector: { type: 'sustained' } })
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
    const alert = 'rules.house-battery-low'
    core.ingest(PLUGIN, alert, { priority: 'warning', message: 'x', latching: false })
    const { application } = setup(undefined, core, () => {
      throw new Error('meta unreadable')
    })
    expect(application.rule(battery.slug)?.status.badge).toBe('errored')

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

  it('lists every rule with its slug and status', () => {
    stored(oil)
    const { application, at } = setup()
    at(0, OIL, 0)
    at(5)
    const [entry] = application.rules()
    expect(entry).toMatchObject({ slug: 'oil-pressure-low', rule: oil })
    expect(entry.status.badge).toBe('alertActive')
    expect(application.rule('oil-pressure-low')?.status.badge).toBe('alertActive')
    expect(application.rule('missing')).toBeUndefined()
  })
})

describe('application accumulator totals across edits', () => {
  const ID = 'engine-hours'
  const total = () => {
    const totals: Partial<Checkpoints> = new Store(dir).load().accumulators
    return totals[ID]?.totals['']
  }

  it('replacing a stored rule that failed validation with the same measure keeps its total', () => {
    stored(brokenHours)
    new Store(dir).saveCheckpoints({ [ID]: { measure: 'time', totals: { '': 100 } } })
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
    new Store(dir).saveCheckpoints({ [ID]: { measure: 'time', totals: { '': 100 } } })
    const { application, at } = setup()
    expect(application.issues.join('\n')).toMatch(/engine-hours has the slug other-hours/)

    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(total()).toBe(120)
  })

  it('replacing a stored rule that failed validation with another measure drops its total at once', () => {
    stored(brokenHours)
    new Store(dir).saveCheckpoints({ [ID]: { measure: 'time', totals: { '': 100 } } })
    const { application } = setup()
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      ok: true,
      value: { discardsTotal: true }
    })
    expect(application.replaceRule(hours.slug, integral).ok).toBe(true)
    expect(total()).toBe(0)
  })

  it('a restart after an edit whose dropped total could not be saved does not restore it', () => {
    stored(hours)
    const store = new Store(dir)
    const first = setup(store)
    first.at(0, RPM, 30)
    first.at(20)
    first.application.checkpoint()
    expect(total()).toBe(20)
    vi.spyOn(store, 'saveCheckpoints').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    expect(() => first.application.replaceRule(hours.slug, integral)).toThrow(/ENOSPC/)
    expect(() => {
      first.application.stop()
    }).toThrow(/ENOSPC/)

    const { application } = setup()

    expect(application.rule(hours.slug)?.status.instances).toMatchObject([
      { progress: { total: 0 } }
    ])
    application.checkpoint()
    expect(total() ?? 0).toBe(0)
  })

  it('a stored rule that is not an accumulator loses its total at start, whatever its measure', () => {
    stored({ ...hours, detector: { type: 'sustained', measure: 'time', limit: 1000 } })
    new Store(dir).saveCheckpoints({ [ID]: { measure: 'time', totals: { '': 100 } } })
    const { application } = setup()
    expect(application.issues.join('\n')).toMatch(/engine-hours is not valid/)
    expect(total()).toBeUndefined()

    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    application.checkpoint()
    expect(total() ?? 0).toBe(0)
  })

  it('a stored total of another measure than its rule file is dropped at start', () => {
    stored(hours)
    new Store(dir).saveCheckpoints({ [ID]: { measure: 'integral', totals: { '': 100 } } })

    setup()

    expect(total()).toBeUndefined()
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
    application.resetAccumulator(hours.slug, 'admin')
    at(10, RPM, 30)
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      value: { discardsTotal: false }
    })
    application.disableRule(hours.slug, undefined, 'admin')
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

    application.disableRule(hours.slug, undefined, 'admin')
    expect(application.previewRule(hours.slug, integral)).toMatchObject({
      value: { discardsTotal: true }
    })
    expect(application.previewRule(hours.slug, reworded)).toMatchObject({
      value: { discardsTotal: false }
    })
  })
})

describe('disable and enable', () => {
  const OIL_ALERT = 'rules.oil-pressure-low'
  const ID = 'oil-pressure-low'
  const disabledAt = (note?: string) => ({
    since: WALL,
    actor: 'skipper',
    ...(note === undefined ? {} : { note })
  })

  it('disabling clears the alert at once and records who, when and the note', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([[OIL_ALERT, true]])

    expect(application.disableRule(oil.slug, 'paddlewheel fouled', 'skipper')).toBe('ok')
    expect(alerts()).toEqual([[OIL_ALERT, false]])
    expect(application.rule(oil.slug)).toMatchObject({
      disabled: disabledAt('paddlewheel fouled'),
      status: { badge: 'disabled' }
    })
    expect(new Store(dir).load().controls.rules).toEqual({
      [ID]: { disabled: disabledAt('paddlewheel fouled') }
    })
    expect(application.log()).toEqual([
      { at: WALL, actor: 'skipper', action: 'disable', rule: ID, note: 'paddlewheel fouled' }
    ])
  })

  it('a disabled rule keeps evaluating, raises nothing and reports its condition present', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    application.disableRule(oil.slug, undefined, 'skipper')
    at(0, OIL, 0)
    at(100)
    expect(alerts()).toEqual([])
    expect(application.rule(oil.slug)?.status.instances[0]).toMatchObject({
      badge: 'disabled',
      conditionPresent: true
    })
    at(110, OIL, 200000)
    at(170)
    expect(application.rule(oil.slug)?.status.instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 60
    })
  })

  it('enabling while the condition holds raises a new alert at once, and records it', () => {
    stored(oil)
    const { application, at, alerts, server } = setup()
    at(0, OIL, 0)
    at(5)
    application.disableRule(oil.slug, undefined, 'skipper')
    at(10)
    expect(application.enableRule(oil.slug, 'skipper')).toBe('ok')
    expect(alerts()).toEqual([[OIL_ALERT, true]])
    expect(server.core.alertings).toBe(2)
    expect(application.rule(oil.slug)?.disabled).toBeUndefined()
    expect(new Store(dir).load().controls.rules).toEqual({})
    expect(application.log().map((e) => e.action)).toEqual(['enable', 'disable'])
  })

  it('enabling while the condition is clear raises nothing', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    application.disableRule(oil.slug, undefined, 'skipper')
    at(0, OIL, 200000)
    at(10)
    application.enableRule(oil.slug, 'skipper')
    at(20)
    expect(alerts()).toEqual([])
  })

  it('disabling a disabled rule replaces its record; enabling an enabled one does nothing', () => {
    stored(oil)
    const { application } = setup()
    expect(application.enableRule(oil.slug, 'skipper')).toBe('ok')
    expect(application.log()).toEqual([])
    expect(existsSync(join(dir, 'controls.json'))).toBe(false)
    application.disableRule(oil.slug, 'fouled', 'skipper')
    application.disableRule(oil.slug, undefined, 'skipper')
    expect(application.rule(oil.slug)?.disabled).toEqual(disabledAt())
    expect(application.log()).toHaveLength(2)
  })

  it('an empty note is no note', () => {
    stored(oil)
    const { application } = setup()
    application.disableRule(oil.slug, '', 'skipper')
    expect(application.rule(oil.slug)?.disabled).toEqual(disabledAt())
    expect(application.log()[0]).not.toHaveProperty('note')
  })

  it('an unknown rule is not found and nothing is recorded', () => {
    stored(oil)
    const { application } = setup()
    expect(application.disableRule('missing', undefined, 'skipper')).toBe('notFound')
    expect(application.enableRule('missing', 'skipper')).toBe('notFound')
    expect(application.log()).toEqual([])
    expect(existsSync(join(dir, 'controls.json'))).toBe(false)
  })

  it('the disabled state and note survive a restart, and the alert is not raised at start', () => {
    stored(oil)
    const first = setup()
    first.at(0, OIL, 0)
    first.at(5)
    first.application.disableRule(oil.slug, 'paddlewheel fouled', 'skipper')
    first.application.stop()

    const second = setup(new Store(dir), first.server.core)
    second.at(10, OIL, 0)
    second.at(100)
    expect(second.alerts()).toEqual([[OIL_ALERT, false]])
    expect(first.server.core.alertings).toBe(1)
    expect(second.application.rule(oil.slug)).toMatchObject({
      disabled: disabledAt('paddlewheel fouled'),
      status: { badge: 'disabled', instances: [{ conditionPresent: true }] }
    })
  })

  it('editing a disabled rule keeps it disabled, with its note', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    application.disableRule(oil.slug, 'paddlewheel fouled', 'skipper')
    const structural = { ...oil, detector: { ...oil.detector, direction: 'above' } }
    expect(application.replaceRule(oil.slug, structural).ok).toBe(true)
    at(0, OIL, 200000)
    at(10)
    expect(alerts()).toEqual([])
    expect(application.rule(oil.slug)).toMatchObject({
      disabled: disabledAt('paddlewheel fouled'),
      status: { badge: 'disabled', instances: [{ conditionPresent: true }] }
    })
  })

  it('deleting a rule deletes its disabled record, so a new rule with its slug starts enabled', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    application.disableRule(oil.slug, undefined, 'skipper')
    application.deleteRule(oil.slug, 'skipper')
    expect(new Store(dir).load().controls).toEqual({ rules: {} })
    expect(application.createRule(oil).ok).toBe(true)
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([[OIL_ALERT, true]])
  })
})

describe('pinned sources', () => {
  const CAN_NAME = 'c0ffee0123456789'
  const CANONICAL = `can0.${CAN_NAME}`
  const pinned = (source: string) => ({ ...coolant, signal: { path: COOLANT, source } })
  const storedSignal = (): unknown =>
    (JSON.parse(readFileSync(join(dir, 'rules', 'coolant-high.json'), 'utf8')) as typeof coolant)
      .signal

  function withDevice(server: MockServerAPI): void {
    server.sources.can0 = {
      label: 'can0',
      type: 'NMEA2000',
      '10': { n2k: { src: '10', canName: CAN_NAME, pgns: {} } }
    }
  }

  it('an address form pick of a device with a CAN name is stored in CAN name form and raises', () => {
    const s = setup()
    withDevice(s.server)
    expect(s.application.createRule(pinned('can0.10')).ok).toBe(true)
    expect(storedSignal()).toEqual({ path: COOLANT, source: CANONICAL })

    s.at(0)
    s.server.subscriptionmanager.publish(COOLANT, 'can0.10', 390)
    s.at(3)
    expect(s.alerts()).toEqual([['rules.coolant-high', true]])
  })

  it('an edit is stored in CAN name form too', () => {
    stored(coolant)
    const s = setup()
    withDevice(s.server)
    expect(s.application.replaceRule(coolant.slug, pinned('can0.10')).ok).toBe(true)
    expect(storedSignal()).toEqual({ path: COOLANT, source: CANONICAL })
  })

  it('a rule made from a template with an address form source pick is stored in CAN name form', () => {
    const s = setup()
    withDevice(s.server)
    const { slug: _slug, ...rule } = coolant
    const made = instantiate(
      { id: 'builtin', version: '1' },
      { id: coolant.slug, open: ['source'], rule },
      { source: 'can0.10' }
    )
    if (!made.ok) throw new Error('instantiation failed')
    expect(s.application.createRule(made.value).ok).toBe(true)
    expect(storedSignal()).toEqual({ path: COOLANT, source: CANONICAL })
    expect(s.application.rule(coolant.slug)?.rule.template?.pick).toEqual({ source: CANONICAL })
  })

  it('a source without a CAN name is stored as it is', () => {
    const s = setup()
    withDevice(s.server)
    expect(s.application.createRule(pinned('nmea0183.GP')).ok).toBe(true)
    expect(storedSignal()).toEqual({ path: COOLANT, source: 'nmea0183.GP' })
  })

  it('a pinned device that never appears leaves the input never seen', () => {
    const s = setup()
    withDevice(s.server)
    s.server.sources.can0 = {
      ...(s.server.sources.can0 as object),
      '11': { n2k: { src: '11', canName: 'beef000000000001', pgns: {} } }
    }
    expect(s.application.createRule(pinned(CANONICAL)).ok).toBe(true)
    s.at(0)
    s.server.subscriptionmanager.publish(COOLANT, 'can0.11', 390)
    s.at(3)
    expect(s.alerts()).toEqual([])
    expect(s.application.rule(coolant.slug)?.status.badge).toBe('neverSeen')
  })

  it('an edit of a rule stored in address form is not structural for the change of form alone', () => {
    stored(pinned('can0.10'))
    const s = setup()
    withDevice(s.server)
    s.at(0)
    s.server.subscriptionmanager.publish(COOLANT, 'can0.10', 390)
    s.at(3)
    expect(s.alerts()).toEqual([['rules.coolant-high', true]])

    const edited = { ...pinned('can0.10'), message: 'Coolant is hot' }
    expect(s.application.previewRule(coolant.slug, edited)).toEqual({
      ok: true,
      value: {
        restarts: false,
        changes: [],
        activeAlerts: 1,
        clearsActiveAlert: false,
        discardsTotal: false
      }
    })
    expect(s.application.replaceRule(coolant.slug, edited).ok).toBe(true)
    expect(storedSignal()).toEqual({ path: COOLANT, source: CANONICAL })
    expect(s.alerts()).toEqual([['rules.coolant-high', true]])
  })

  it('a gate pinned to a CAN name reads the address form of that device', () => {
    const s = setup()
    withDevice(s.server)
    const gated = {
      ...coolant,
      detector: { ...coolant.detector, duration: 0 },
      gates: [
        {
          signal: { path: RPM, source: CANONICAL },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 }
        }
      ]
    }
    expect(s.application.createRule(gated).ok).toBe(true)
    s.at(0)
    s.server.subscriptionmanager.publish(RPM, 'can0.10', 70)
    s.at(1, COOLANT, 390)
    expect(s.alerts()).toEqual([['rules.coolant-high', true]])
  })
})
