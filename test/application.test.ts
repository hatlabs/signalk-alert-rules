import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertPathOf } from '../src/alerts/paths.js'
import type { Value } from '@signalk/server-api'
import { Application, LOG_LIMIT } from '../src/application.js'
import type { RunnerDeps } from '../src/alerts/runner.js'
import { serverDeps } from '../src/alerts/server.js'
import type { Template, TemplateSet } from '../src/model/template.js'
import { Store, type Checkpoints } from '../src/store/store.js'
import type { DiscoveryResult } from '../src/templates/discovery.js'
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
  signal: { path: OIL },
  detector: {
    type: 'sustained',
    direction: 'below',
    steps: [{ limit: 100000, priority: 'alarm' }],
    duration: 5
  }
}
const coolant = {
  name: 'Coolant high',
  slug: 'coolant-high',
  message: 'Coolant temperature is high',
  signal: { path: COOLANT },
  detector: {
    type: 'sustained',
    direction: 'above',
    steps: [{ limit: 368, priority: 'alarm' }],
    duration: 2
  }
}
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', steps: [{ limit: 1000, priority: 'caution' }] }
}

const integral = {
  ...hours,
  detector: {
    type: 'accumulator',
    measure: 'integral',
    steps: [{ limit: 1000, priority: 'caution' }]
  }
}
/** Fails validation: an accumulator limit must be positive. */
const brokenHours = {
  ...hours,
  detector: { ...hours.detector, steps: [{ limit: -5, priority: 'caution' }] }
}
/** A rule with an unknown priority on its step. */
function loud<R extends { detector: object }>(rule: R) {
  return { ...rule, detector: { ...rule.detector, steps: [{ limit: 1, priority: 'loud' }] } }
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
    // Stored as given: without a condition name, its default follows the rule.
    expect(JSON.parse(readFileSync(join(dir, 'rules', 'coolant-high.json'), 'utf8'))).toEqual(
      coolant
    )
    expect(application.allRules().map((r) => r.slug)).toEqual(['oil-pressure-low', 'coolant-high'])

    // The oil rule's timer kept running across the save: it raises 5 s after
    // its value, not 5 s after the save.
    at(4)
    expect(alerts()).toEqual([])
    at(5)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', true]])

    at(5, COOLANT, 380)
    at(7)
    expect(alerts()).toContainEqual(['propulsion.main.coolantTemperatureHigh', true])
  })

  it('an edit persists and applies to the running rule', () => {
    stored(oil)
    const { application, at, server } = setup()
    at(0, OIL, 0)
    at(5)
    expect(application.replaceRule(oil.slug, { ...oil, message: 'Check the oil' }).ok).toBe(true)
    at(25)
    expect(server.core.getByPath('propulsion.main.oilPressureLow')?.message).toBe('Check the oil')
    expect(new Store(dir).load().rules[0]?.value).toMatchObject({ message: 'Check the oil' })
  })

  it('rejects an invalid rule with field-path errors and persists nothing', () => {
    const { application } = setup()
    const result = application.createRule(loud(oil))
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    if (!result.ok && result.reason === 'invalid') {
      expect(result.errors.map((e) => e.path)).toContain('/detector/steps/0/priority')
    }
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(false)
    expect(application.allRules()).toEqual([])
  })

  it('refuses a rule whose alert path another rule has, or could have for an instance', () => {
    stored(oil)
    const { application } = setup()
    const same = { ...coolant, condition: 'oilPressureLow' }
    expect(application.createRule(same)).toEqual({
      ok: false,
      reason: 'alertPathTaken',
      holder: 'oil-pressure-low'
    })
    const everyEngine = {
      ...oil,
      slug: 'any-oil-low',
      signal: { path: 'propulsion.*.oilPressure' }
    }
    expect(application.createRule(everyEngine)).toMatchObject({ reason: 'alertPathTaken' })
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
    expect(application.createRule({ ...same, condition: 'oilPressureLost' }).ok).toBe(true)
  })

  it('takes the condition name an edit gives, and the default when it gives none', () => {
    stored({ ...oil, condition: 'lubricationFailed' })
    const { application } = setup()
    const reversed = { ...oil, detector: { ...oil.detector, direction: 'above' } }
    const pathAfter = (edit: unknown) => {
      const result = application.replaceRule(oil.slug, edit)
      return result.ok ? alertPathOf(result.value) : result
    }
    expect(pathAfter({ ...reversed, condition: 'lubricationFailed' })).toBe(
      'propulsion.main.lubricationFailed'
    )
    expect(pathAfter(reversed)).toBe('propulsion.main.oilPressureHigh')
  })

  it('refuses an edit whose new default alert path another rule has', () => {
    stored(oil)
    stored({ ...oil, slug: 'oil-high', detector: { ...oil.detector, direction: 'above' } })
    const { application } = setup()
    const reversed = { ...oil, detector: { ...oil.detector, direction: 'above' } }
    expect(application.replaceRule(oil.slug, reversed)).toEqual({
      ok: false,
      reason: 'alertPathTaken',
      holder: 'oil-high'
    })
  })

  it("puts the condition name under the edited input's parent, with its wildcard or without", () => {
    const everyCoolant = {
      ...coolant,
      slug: 'any-coolant-high',
      condition: 'coolantOverheat',
      signal: { path: 'propulsion.*.coolantTemperature' }
    }
    stored(oil)
    stored(everyCoolant)
    const { application } = setup()
    const pathAfter = (slug: string, edit: unknown) => {
      const result = application.replaceRule(slug, edit)
      return result.ok ? alertPathOf(result.value) : result
    }
    expect(pathAfter(oil.slug, { ...oil, signal: { path: 'propulsion.*.oilPressure' } })).toBe(
      'propulsion.*.oilPressureLow'
    )
    expect(pathAfter(everyCoolant.slug, { ...everyCoolant, signal: { path: COOLANT } })).toBe(
      'propulsion.main.coolantOverheat'
    )
  })

  it('runs only the first of two stored rules with overlapping alert paths, reporting the other', () => {
    const portOil = { ...oil, slug: 'port-oil', signal: { path: 'propulsion.*.oilPressure' } }
    stored(oil)
    stored(portOil)
    const { application } = setup()
    expect(application.allRules().map((r) => r.slug)).toEqual(['oil-pressure-low'])
    expect(application.issues).toEqual([])
    expect(application.rule(portOil.slug)).toEqual({
      slug: portOil.slug,
      invalid: {
        errors: [
          {
            path: '/condition',
            message:
              'makes an alert path overlapping that of rule oil-pressure-low; each rule needs its own'
          }
        ],
        body: portOil
      },
      state: {
        ruleState: 'enabled',
        condition: 'problem',
        reason: 'invalidRule',
        changedAt: expect.any(String) as unknown,
        issues: [],
        errors: [],
        instances: []
      }
    })

    // An edit is the repair: it needs an alert path of its own.
    expect(application.replaceRule(portOil.slug, portOil)).toEqual({
      ok: false,
      reason: 'alertPathTaken',
      holder: 'oil-pressure-low'
    })
    const own = { ...portOil, condition: 'oilPressureLost' }
    expect(application.replaceRule(portOil.slug, own)).toMatchObject({ ok: true, value: own })
    expect(application.allRules().map((r) => r.slug)).toEqual(['oil-pressure-low', 'port-oil'])
    expect(application.rule(portOil.slug)).not.toHaveProperty('invalid')
    expect(application.rules().map((e) => e.slug)).toEqual(['oil-pressure-low', 'port-oil'])
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
        ['propulsion.main.oilPressureLow', false],
        ['propulsion.main.coolantTemperatureHigh', true]
      ])
    )
    expect(application.deleteRule('oil-pressure-low', 'admin')).toBe(false)
  })

  it('lists an invalid stored rule as a problem with its errors and body while the others run, and can delete it', () => {
    stored(oil)
    stored(loud(coolant))
    writeFileSync(join(dir, 'rules', 'renamed.json'), JSON.stringify(coolant))
    const { application, at, alerts } = setup()
    expect(application.issues).toEqual([])
    expect(application.rules().map((e) => e.slug)).toEqual([
      'oil-pressure-low',
      'coolant-high',
      'renamed'
    ])
    expect(application.rule('coolant-high')).toMatchObject({
      invalid: {
        errors: [expect.objectContaining({ path: '/detector/steps/0/priority' }) as unknown],
        body: loud(coolant)
      },
      state: { condition: 'problem', reason: 'invalidRule' }
    })
    expect(application.rule('renamed')).toMatchObject({
      invalid: { errors: [{ path: '/slug' }], body: coolant },
      state: { condition: 'problem', reason: 'invalidRule' }
    })
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', true]])

    expect(application.deleteRule('coolant-high', 'admin')).toBe(true)
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
    expect(application.rule('coolant-high')).toBeUndefined()
  })

  it('a disabled invalid stored rule reports its rule state disabled', () => {
    stored(loud(coolant))
    new Store(dir).saveControls({
      rules: { 'coolant-high': { disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' } } }
    })
    const { application } = setup()
    expect(application.rule('coolant-high')).toMatchObject({
      disabled: { actor: 'admin' },
      state: { ruleState: 'disabled', condition: 'problem', reason: 'invalidRule' }
    })
  })

  it('replacing an invalid stored rule with a valid one starts it', () => {
    stored(loud(coolant))
    const { application, at, alerts } = setup()
    expect(application.statusNotes()).toEqual([
      expect.stringMatching(
        /^stored rule coolant-high does not run: \/detector\/steps\/0\/priority /
      )
    ])
    expect(application.replaceRule(coolant.slug, coolant).ok).toBe(true)
    expect(application.statusNotes()).toEqual([])
    expect(application.rule(coolant.slug)).toMatchObject({ rule: coolant })
    expect(application.rule(coolant.slug)).not.toHaveProperty('invalid')
    at(0, COOLANT, 380)
    at(5)
    expect(alerts()).toEqual([['propulsion.main.coolantTemperatureHigh', true]])
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
    stored({ ...loud(hours), slug: 'genset-hours' })
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
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', true]])
    expect(server.core.writes).toBe(sent)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 5 } }
    })
  })
})

describe('application operator actions', () => {
  const OIL_ALERT = 'propulsion.main.oilPressureLow'
  // Not caution: core drops a cleared caution alert, which the tests read back.
  const shortHours = {
    ...hours,
    detector: { ...hours.detector, steps: [{ limit: 10, priority: 'warning' }] }
  }

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
    expect(application.rule(oil.slug)?.state).toMatchObject({
      ruleState: 'enabled',
      condition: 'noData',
      reason: 'notEvaluated',
      changedAt: expect.any(String) as unknown
    })
  })

  it('a disabled rule before start reports its rule state disabled', () => {
    stored(oil)
    new Store(dir).saveControls({
      rules: { [oil.slug]: { disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' } } }
    })
    const server = new MockServerAPI(true, dir, new FakeAlertsCore())
    const application = new Application(serverDeps(server.asServerAPI(), PLUGIN), new Store(dir))
    expect(application.rule(oil.slug)?.state).toMatchObject({
      ruleState: 'disabled',
      condition: 'noData',
      reason: 'notEvaluated'
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
    expect(alerts()).toEqual([['propulsion.main.revolutionsAccumulated', true]])

    expect(application.resetAccumulator('engine-hours', 'skipper')).toBe('reset')
    expect(alerts()).toEqual([['propulsion.main.revolutionsAccumulated', false]])
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 0 } }
    })
    expect(application.log()).toEqual([
      { at: WALL, actor: 'skipper', action: 'reset', rule: 'engine-hours' }
    ])

    // It keeps accumulating from zero and raises again at the limit.
    at(11)
    expect(alerts()).toEqual([['propulsion.main.revolutionsAccumulated', false]])
    at(12)
    expect(alerts()).toEqual([['propulsion.main.revolutionsAccumulated', true]])
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

    const retyped = {
      ...oil,
      detector: { type: 'match', op: 'equals', steps: [{ value: 0, priority: 'alarm' }] }
    }
    const clearing = application.previewRule('oil-pressure-low', retyped)
    expect(clearing).toMatchObject({
      ok: true,
      value: { restarts: true, activeAlerts: 1, clearsActiveAlert: true }
    })
    if (clearing.ok) expect(clearing.value.changes).toContain('detector.type')

    const limit = {
      ...oil,
      detector: { ...oil.detector, steps: [{ limit: 90000, priority: 'alarm' }] }
    }
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

  it('moves the alert of a rule without a condition name to the default of an edit', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', true]])
    const reversed = {
      ...oil,
      detector: {
        ...oil.detector,
        direction: 'above',
        steps: [{ limit: -1, priority: 'alarm' }]
      }
    }
    expect(application.previewRule(oil.slug, reversed)).toMatchObject({
      ok: true,
      value: {
        restarts: true,
        changes: ['alertPath', 'detector.direction'],
        clearsActiveAlert: true
      }
    })
    expect(application.replaceRule(oil.slug, reversed).ok).toBe(true)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', false]])
    at(6, OIL, 0)
    at(11)
    expect(new Map(alerts())).toEqual(
      new Map([
        ['propulsion.main.oilPressureLow', false],
        ['propulsion.main.oilPressureHigh', true]
      ])
    )
  })

  it('keeps a stored condition name through an edit, even one equal to the default', () => {
    const named = { ...oil, condition: 'oilPressureLow' }
    stored(named)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', true]])
    const reversed = {
      ...named,
      detector: {
        ...oil.detector,
        direction: 'above',
        steps: [{ limit: -1, priority: 'alarm' }]
      }
    }
    expect(application.previewRule(oil.slug, reversed)).toMatchObject({
      ok: true,
      value: { restarts: true, changes: ['detector.direction'] }
    })
    expect(application.replaceRule(oil.slug, reversed).ok).toBe(true)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', false]])
    at(6, OIL, 0)
    at(11)
    expect(alerts()).toEqual([['propulsion.main.oilPressureLow', true]])
  })

  it('moves an alert adopted at start when an edit changes its alert path', () => {
    stored(oil)
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, OIL_ALERT, { priority: 'alarm', message: oil.message, latching: false })
    const { application, at, alerts } = setup(undefined, core)
    expect(alerts()).toEqual([[OIL_ALERT, true]])
    const renamed = { ...oil, condition: 'lubricationFailed' }
    expect(application.replaceRule(oil.slug, renamed).ok).toBe(true)
    expect(alerts()).toEqual([[OIL_ALERT, false]])
    at(0, OIL, 0)
    at(5)
    expect(new Map(alerts())).toEqual(
      new Map([
        [OIL_ALERT, false],
        ['propulsion.main.lubricationFailed', true]
      ])
    )
  })

  it("moves each instance's alert of a wildcard rule to a new alert path", () => {
    const everyCoolant = {
      ...coolant,
      slug: 'any-coolant-high',
      signal: { path: 'propulsion.*.coolantTemperature' }
    }
    const port = 'propulsion.port.coolantTemperature'
    stored(everyCoolant)
    const { application, at, alerts } = setup()
    at(0, port, 380)
    at(2)
    expect(alerts()).toEqual([['propulsion.port.coolantTemperatureHigh', true]])
    const moved = { ...everyCoolant, condition: 'coolantOverheat' }
    expect(application.replaceRule(everyCoolant.slug, moved).ok).toBe(true)
    expect(alerts()).toEqual([['propulsion.port.coolantTemperatureHigh', false]])
    at(3, port, 380)
    at(5)
    expect(alerts()).toContainEqual(['propulsion.port.coolantOverheat', true])
  })

  it('a structural edit of a rule without an active alert restarts it and clears nothing', () => {
    stored(oil)
    const { application } = setup()
    const reversed = { ...oil, detector: { ...oil.detector, direction: 'above' } }
    expect(application.previewRule('oil-pressure-low', reversed)).toEqual({
      ok: true,
      value: {
        restarts: true,
        changes: ['alertPath', 'detector.direction'],
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
    const alert = 'electrical.batteries.house.voltageLow'
    core.ingest(PLUGIN, alert, { priority: 'warning', message: 'x', latching: false })
    const { application } = setup(undefined, core, () => {
      throw new Error('meta unreadable')
    })
    expect(application.rule(battery.slug)?.state.condition).toBe('problem')

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
    expect(application.createRule(loud(oil))).toMatchObject({
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
    expect(entry.state.condition).toBe('alerting')
    expect(application.rule('oil-pressure-low')?.state.condition).toBe('alerting')
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
    expect(application.rule(ID)).toHaveProperty('invalid')
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
    expect(application.rule(ID)).toMatchObject({ invalid: { errors: [{ path: '/slug' }] } })

    expect(application.replaceRule(hours.slug, hours).ok).toBe(true)
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(total()).toBe(120)
  })

  it('a stored rule refused at load for an overlapping alert path keeps its total', () => {
    const generator = { ...hours, slug: 'generator-hours' }
    stored(hours)
    stored(generator)
    new Store(dir).saveCheckpoints({
      [generator.slug]: { measure: 'time', totals: { '': 100 } }
    })
    const { application } = setup()
    expect(application.rule(generator.slug)).toMatchObject({
      invalid: { errors: [{ path: '/condition' }] }
    })
    application.checkpoint()
    const totals: Partial<Checkpoints> = new Store(dir).load().accumulators
    expect(totals[generator.slug]?.totals['']).toBe(100)
  })

  it('renaming the condition of an accumulator rule keeps its total, through a restart', () => {
    stored(hours)
    const first = setup()
    first.at(0, RPM, 30)
    first.at(20)
    const renamed = { ...hours, condition: 'serviceDue' }
    expect(first.application.previewRule(hours.slug, renamed)).toMatchObject({
      ok: true,
      value: { changes: ['alertPath'], discardsTotal: false }
    })
    expect(first.application.replaceRule(hours.slug, renamed).ok).toBe(true)
    first.at(30)
    first.application.stop()
    expect(total()).toBe(30)

    const second = setup()
    expect(second.application.rule(hours.slug)).toHaveProperty('rule.condition', 'serviceDue')
    second.at(40, RPM, 30)
    second.at(50)
    second.application.checkpoint()
    expect(total()).toBe(40)
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

    expect(application.rule(hours.slug)?.state.instances).toMatchObject([
      { progress: { total: 0 } }
    ])
    application.checkpoint()
    expect(total() ?? 0).toBe(0)
  })

  it('a stored rule that is not an accumulator loses its total at start, whatever its measure', () => {
    stored({ ...hours, detector: { type: 'sustained', measure: 'time', limit: 1000 } })
    new Store(dir).saveCheckpoints({ [ID]: { measure: 'time', totals: { '': 100 } } })
    const { application } = setup()
    expect(application.rule(ID)).toHaveProperty('invalid')
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
  const OIL_ALERT = 'propulsion.main.oilPressureLow'
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
      state: { ruleState: 'disabled' }
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
    expect(application.rule(oil.slug)?.state).toMatchObject({
      ruleState: 'disabled',
      condition: 'present',
      reason: 'conditionPresent'
    })
    at(110, OIL, 200000)
    at(170)
    // The test's wall clock stands still while the evaluation clock runs.
    expect(application.rule(oil.slug)?.state).toMatchObject({
      ruleState: 'disabled',
      condition: 'normal',
      reason: 'withinLimits',
      clearedAt: new Date(Date.parse(WALL) - 60_000).toISOString()
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
      state: { ruleState: 'disabled', condition: 'present', instances: [{ condition: 'present' }] }
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
      state: { ruleState: 'disabled', condition: 'present', instances: [{ condition: 'present' }] }
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
    expect(s.alerts()).toEqual([['propulsion.main.coolantTemperatureHigh', true]])
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
    expect(s.application.rule(coolant.slug)).toHaveProperty('rule.template.pick', {
      source: CANONICAL
    })
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
    expect(s.application.rule(coolant.slug)?.state).toMatchObject({
      condition: 'noData',
      reason: 'neverReported'
    })
  })

  it('an edit of a rule stored in address form is not structural for the change of form alone', () => {
    stored(pinned('can0.10'))
    const s = setup()
    withDevice(s.server)
    s.at(0)
    s.server.subscriptionmanager.publish(COOLANT, 'can0.10', 390)
    s.at(3)
    expect(s.alerts()).toEqual([['propulsion.main.coolantTemperatureHigh', true]])

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
    expect(s.alerts()).toEqual([['propulsion.main.coolantTemperatureHigh', true]])
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
    expect(s.alerts()).toEqual([['propulsion.main.coolantTemperatureHigh', true]])
  })
})

describe('templates', () => {
  function template(id: string): Template {
    return {
      id,
      open: ['instance'],
      rule: {
        name: `${id} \${instance}`,
        message: id,
        signal: { path: `electrical.batteries.\${instance}.${id}` },
        detector: {
          type: 'sustained',
          direction: 'below',
          steps: [{ limit: 1, priority: 'warning' }]
        }
      }
    }
  }

  function set(id: string, version: string, templates: string[]): TemplateSet {
    return { name: id, id, version, templates: templates.map(template) }
  }

  function withSets(found: { current: DiscoveryResult }, store = new Store(dir)) {
    const server = new MockServerAPI(true, dir, new FakeAlertsCore())
    const deps = {
      ...serverDeps(server.asServerAPI(), PLUGIN),
      clock: () => 0,
      wallClock: () => new Date(WALL)
    }
    const application = new Application(deps, store, () => found.current)
    application.start()
    return application
  }

  const problem = { source: 'file broken.yaml', message: '/id: is required' }

  it('lists each set with its templates, all new, and the sets that failed to load', () => {
    const found: { current: DiscoveryResult } = {
      current: {
        sets: [
          { source: 'built-in', set: set('builtin', '1.0.0', ['voltage-low']) },
          {
            source: 'package some-templates',
            package: { name: 'some-templates', version: '2.0.0' },
            set: { ...set('extra', '2.0.0', ['current-high']), description: 'More' }
          }
        ],
        problems: [problem]
      }
    }
    expect(withSets(found).templates()).toEqual({
      sets: [
        {
          id: 'builtin',
          name: 'builtin',
          version: '1.0.0',
          source: 'built-in',
          templates: [template('voltage-low')],
          new: ['voltage-low']
        },
        {
          id: 'extra',
          name: 'extra',
          version: '2.0.0',
          description: 'More',
          source: 'package some-templates',
          package: { name: 'some-templates', version: '2.0.0' },
          templates: [template('current-high')],
          new: ['current-high']
        }
      ],
      problems: [problem]
    })
  })

  it('dismissing marks the templates shown seen, for good; an update makes only its additions new', () => {
    const found: { current: DiscoveryResult } = {
      current: {
        sets: [{ source: 'built-in', set: set('builtin', '1', ['a', 'b']) }],
        problems: []
      }
    }
    const application = withSets(found)
    expect(application.dismissTemplates({ builtin: ['a', 'b'] }).sets.map((s) => s.new)).toEqual([
      []
    ])
    found.current = {
      sets: [{ source: 'built-in', set: set('builtin', '2', ['a', 'b', 'c']) }],
      problems: []
    }
    expect(
      withSets(found)
        .templates()
        .sets.map((s) => s.new)
    ).toEqual([['c']])
  })

  it('a template installed after the notice was drawn stays new when it is dismissed', () => {
    const found: { current: DiscoveryResult } = {
      current: {
        sets: [{ source: 'built-in', set: set('builtin', '1', ['a', 'b']) }],
        problems: []
      }
    }
    const application = withSets(found)
    const shown = { builtin: application.templates().sets[0]?.new ?? [] }
    found.current = {
      sets: [
        { source: 'built-in', set: set('builtin', '2', ['a', 'b', 'c']) },
        { source: 'file extra.yaml', set: set('extra', '1', ['d']) }
      ],
      problems: []
    }
    expect(application.dismissTemplates(shown).sets.map((s) => s.new)).toEqual([['c'], ['d']])
  })

  it('dismissing again after an update adds to the templates already seen', () => {
    const found: { current: DiscoveryResult } = {
      current: {
        sets: [{ source: 'built-in', set: set('builtin', '1', ['a', 'b']) }],
        problems: []
      }
    }
    const application = withSets(found)
    application.dismissTemplates({ builtin: ['a', 'b'] })
    found.current = {
      sets: [{ source: 'built-in', set: set('builtin', '2', ['a', 'b', 'c']) }],
      problems: []
    }
    application.dismissTemplates({ builtin: ['c'] })
    expect(application.templates().sets.map((s) => s.new)).toEqual([[]])
  })

  it('dismissing ignores templates and sets that are not installed', () => {
    const found: { current: DiscoveryResult } = {
      current: { sets: [{ source: 'built-in', set: set('builtin', '1', ['a']) }], problems: [] }
    }
    const application = withSets(found)
    application.dismissTemplates({ builtin: ['a', 'gone'], removed: ['x'] })
    found.current = {
      sets: [
        { source: 'built-in', set: set('builtin', '2', ['a', 'gone']) },
        { source: 'file removed.yaml', set: set('removed', '1', ['x']) }
      ],
      problems: []
    }
    expect(application.templates().sets.map((s) => s.new)).toEqual([['gone'], ['x']])
  })

  it('a set that does not load while dismissing keeps its templates seen', () => {
    const found: { current: DiscoveryResult } = {
      current: { sets: [{ source: 'built-in', set: set('builtin', '1', ['a']) }], problems: [] }
    }
    const application = withSets(found)
    application.dismissTemplates({ builtin: ['a'] })
    found.current = { sets: [], problems: [problem] }
    application.dismissTemplates({ builtin: ['a'] })
    found.current = {
      sets: [{ source: 'built-in', set: set('builtin', '1', ['a']) }],
      problems: []
    }
    expect(application.templates().sets.map((s) => s.new)).toEqual([[]])
  })

  it('dismissing with nothing new writes nothing', () => {
    const found: { current: DiscoveryResult } = { current: { sets: [], problems: [] } }
    const application = withSets(found)
    application.dismissTemplates({ builtin: ['a'] })
    expect(existsSync(join(dir, 'controls.json'))).toBe(false)
  })

  it('templates never affect the rules: a rule made from one runs whatever the sets do', () => {
    const found: { current: DiscoveryResult } = {
      current: {
        sets: [{ source: 'built-in', set: set('builtin', '1', ['voltage']) }],
        problems: []
      }
    }
    const application = withSets(found)
    const rule = {
      ...oil,
      template: { set: 'builtin', id: 'voltage', version: '1', pick: { instance: 'house' } }
    }
    expect(application.createRule(rule).ok).toBe(true)
    found.current = { sets: [], problems: [] }
    expect(application.templates().sets).toEqual([])
    expect(application.rule(oil.slug)).toHaveProperty('rule', rule)
  })
})
