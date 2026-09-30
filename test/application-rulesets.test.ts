import * as fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Value } from '@signalk/server-api'
import { Application } from '../src/application.js'
import { serverDeps } from '../src/alerts/server.js'
import { validateRuleset } from '../src/model/validate.js'
import type { LoadedRuleset } from '../src/rulesets/discovery.js'
import { Store } from '../src/store/store.js'
import { FakeAlertsCore } from './helpers/FakeAlertsCore.js'
import { MockServerAPI } from './helpers/MockServerAPI.js'

const PLUGIN = 'signalk-alert-rules'
const WALL = '2026-09-30T12:00:00.000Z'
const VOLTAGE = 'electrical.batteries.house.voltage'
const START_VOLTAGE = 'electrical.batteries.start.voltage'
const TEMPERATURE = 'electrical.batteries.house.temperature'
const OIL = 'propulsion.main.oilPressure'
const LOW = 'rules.batteries.low'
const HOT = 'rules.batteries.hot'
const PACKAGE = { name: 'signalk-alert-ruleset-batteries', version: '1.0.0' }

const sustained = (direction: string, value: unknown) => ({
  type: 'sustained',
  direction,
  limit: { kind: 'fixed', value },
  duration: 5
})

const low = {
  name: 'Battery low',
  slug: 'low',
  message: 'Battery voltage low',
  priority: 'warning',
  signal: { path: '${prefix}.voltage' },
  detector: sustained('below', { param: 'lowVoltage' })
}
const hot = {
  name: 'Battery hot',
  slug: 'hot',
  message: 'Battery hot',
  priority: 'warning',
  signal: { path: TEMPERATURE },
  detector: sustained('above', 330)
}
const silent = {
  name: 'Battery silent',
  slug: 'silent',
  message: 'Battery monitor silent',
  priority: 'warning',
  signal: { path: '${prefix}.voltage' },
  detector: { type: 'absence', event: { op: 'changes' }, within: 10 }
}
const oil = {
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  priority: 'alarm',
  signal: { path: OIL },
  detector: sustained('below', 100000)
}

function batteries(version = '1.0.0', rules: unknown[] = [low, hot]): LoadedRuleset {
  const result = validateRuleset({
    name: 'Battery monitoring',
    slug: 'batteries',
    version,
    parameters: [
      { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
      { name: 'lowVoltage', type: 'number', unit: 'V', default: 12, minimum: 10, maximum: 14 }
    ],
    rules
  })
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return {
    slug: 'batteries',
    source: `package ${PACKAGE.name}`,
    package: { ...PACKAGE, version },
    ruleset: result.value
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-rulesets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** What discovery finds; a test changes it to install, upgrade or remove a ruleset. */
interface Installed {
  rulesets: LoadedRuleset[]
}

function setup(installed: Installed, core = new FakeAlertsCore()) {
  const server = new MockServerAPI(true, dir, core)
  let now = 0
  const deps = {
    ...serverDeps(server.asServerAPI(), PLUGIN),
    clock: () => now,
    wallClock: () => new Date(WALL)
  }
  const application = new Application(deps, new Store(dir), () => ({
    rulesets: installed.rulesets,
    problems: []
  }))
  application.start()
  const alerts = () => core.list().map((a) => [a.path, a.condition] as [string, boolean])
  return {
    core,
    application,
    alerts,
    at: (t: number, path?: string, value?: Value) => {
      now = t
      if (path === undefined) application.tick()
      else server.subscriptionmanager.publish(path, 'src', value ?? null)
    }
  }
}

function storedControls(): unknown {
  return JSON.parse(fs.readFileSync(join(dir, 'controls.json'), 'utf8'))
}

describe('rulesets in the application', () => {
  it('starts a newly discovered ruleset disabled and runs it at the defaults once enabled', () => {
    const { application, at, alerts } = setup({ rulesets: [batteries()] })
    at(0, VOLTAGE, 11)
    at(10)

    expect(alerts()).toEqual([])
    expect(application.rulesets().rulesets).toMatchObject([
      { slug: 'batteries', enabled: false, values: {}, rules: ['low', 'hot'], notices: [] }
    ])
    expect(application.rule('batteries', 'low')?.status).toMatchObject({
      badge: 'disabled',
      reason: 'ruleset is disabled'
    })
    expect(storedControls()).toMatchObject({ rulesets: { batteries: { enabled: false } } })

    expect(application.setRulesetEnabled('batteries', true, 'admin')).toBe('ok')
    at(14)
    expect(alerts()).toEqual([])
    at(15)
    expect(alerts()).toEqual([[LOW, true]])
    expect(application.log()[0]).toEqual({
      at: WALL,
      actor: 'admin',
      action: 'enable',
      ruleset: 'batteries'
    })
  })

  it('names the ruleset, its version and package on its rules', () => {
    const { application } = setup({ rulesets: [batteries()] })
    expect(application.rule('batteries', 'low')).toMatchObject({
      origin: 'batteries',
      slug: 'low',
      ruleset: { name: 'Battery monitoring', version: '1.0.0', package: PACKAGE },
      rule: { signal: { path: VOLTAGE } }
    })
  })

  it('disabling a ruleset clears its alerts and keeps other rules running', () => {
    stored(oil)
    const { application, at, alerts } = setup({ rulesets: [batteries()] })
    at(0, VOLTAGE, 11)
    at(0, OIL, 0)
    application.setRulesetEnabled('batteries', true, 'admin')
    at(5)
    expect(alerts()).toEqual([
      ['rules.user.oil-pressure-low', true],
      [LOW, true]
    ])

    application.setRulesetEnabled('batteries', false, 'admin')
    expect(alerts()).toEqual([
      ['rules.user.oil-pressure-low', true],
      [LOW, false]
    ])
  })

  it('a parameter change restarts only the rules it changes', () => {
    const { application, at, alerts, core } = setup({ rulesets: [batteries()] })
    at(0, VOLTAGE, 11)
    at(0, START_VOLTAGE, 11)
    at(0, TEMPERATURE, 340)
    application.setRulesetEnabled('batteries', true, 'admin')
    at(5)
    expect(alerts()).toEqual([
      [LOW, true],
      [HOT, true]
    ])
    const alertings = core.alertings

    at(6)
    const outcome = application.setRulesetParameters(
      'batteries',
      { prefix: 'electrical.batteries.start' },
      'admin'
    )

    expect(outcome).toEqual({ ok: true })
    // A changed path restarts the rule; the other rule is not touched.
    expect(alerts()).toEqual([
      [LOW, false],
      [HOT, true]
    ])
    expect(application.rule('batteries', 'low')?.rule.signal).toEqual({ path: START_VOLTAGE })
    at(10)
    expect(core.alertings).toBe(alertings)
    at(11)
    expect(alerts()).toEqual([
      [LOW, true],
      [HOT, true]
    ])
    expect(application.rulesets().rulesets[0]?.values).toEqual({
      prefix: 'electrical.batteries.start'
    })
    expect(application.log()[0]).toMatchObject({ action: 'parameters', ruleset: 'batteries' })
  })

  it('a parameter change applied in place keeps the rule timer', () => {
    const { application, at, alerts } = setup({ rulesets: [batteries()] })
    at(0, VOLTAGE, 11)
    application.setRulesetEnabled('batteries', true, 'admin')
    at(3)

    application.setRulesetParameters('batteries', { lowVoltage: 11.5 }, 'admin')

    at(5)
    expect(alerts()).toEqual([[LOW, true]])
  })

  it('refuses parameter values that do not validate and changes nothing', () => {
    const { application } = setup({ rulesets: [batteries()] })

    const outcome = application.setRulesetParameters('batteries', { lowVoltage: 20 }, 'admin')

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'invalid',
      errors: [{ path: '/lowVoltage' }]
    })
    expect(application.rulesets().rulesets[0]?.values).toEqual({})
    expect(application.setRulesetParameters('other', {}, 'admin')).toEqual({
      ok: false,
      reason: 'notFound'
    })
  })

  it('a ruleset installed after start appears after a rescan, without restarting other rules', () => {
    stored(oil)
    const installed: Installed = { rulesets: [] }
    const { application, at, alerts } = setup(installed)
    at(0, OIL, 0)
    at(3)

    installed.rulesets = [batteries()]
    const listing = application.rescan('admin')

    expect(listing.rulesets).toMatchObject([{ slug: 'batteries', enabled: false }])
    expect(application.log()[0]).toEqual({ at: WALL, actor: 'admin', action: 'rescan' })
    at(4)
    expect(alerts()).toEqual([])
    at(5)
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])
  })

  it('an upgrade keeps the settings of surviving rules and clears a removed rule', () => {
    const installed: Installed = { rulesets: [batteries()] }
    const { application, at, alerts, core } = setup(installed)
    at(0, VOLTAGE, 11)
    at(0, TEMPERATURE, 340)
    application.setRulesetEnabled('batteries', true, 'admin')
    application.setRulesetParameters('batteries', { lowVoltage: 11.5 }, 'admin')
    application.setNote('batteries', 'low', 'checked in spring', 'admin')
    application.setNote('batteries', 'hot', 'sensor on the house bank', 'admin')
    at(5)
    const alertings = core.alertings

    installed.rulesets = [batteries('2.0.0', [low])]
    application.rescan('admin')

    expect(alerts()).toEqual([
      [LOW, true],
      [HOT, false]
    ])
    expect(core.alertings).toBe(alertings)
    expect(application.rule('batteries', 'hot')).toBeUndefined()
    expect(application.rule('batteries', 'low')).toMatchObject({
      note: 'checked in spring',
      ruleset: { version: '2.0.0' }
    })
    expect(storedControls()).toMatchObject({ rules: { 'batteries.low': {} } })
    expect(storedControls()).not.toMatchObject({ rules: { 'batteries.hot': {} } })
    expect(application.rulesets().rulesets).toMatchObject([
      {
        version: '2.0.0',
        enabled: true,
        values: { lowVoltage: 11.5 },
        rules: ['low'],
        notices: [{ at: WALL, message: expect.stringContaining('rule hot') as string }]
      }
    ])
  })

  it('an upgrade installed while stopped clears the removed rule at start; its notice persists until dismissed', () => {
    const core = new FakeAlertsCore()
    const first = setup({ rulesets: [batteries()] }, core)
    first.at(0, TEMPERATURE, 340)
    first.application.setRulesetEnabled('batteries', true, 'admin')
    first.at(5)
    expect(first.alerts()).toEqual([[HOT, true]])
    first.application.stop()

    const upgraded = { rulesets: [batteries('2.0.0', [low])] }
    const second = setup(upgraded, core)
    expect(second.alerts()).toEqual([[HOT, false]])
    const notices = second.application.rulesets().rulesets[0]?.notices
    expect(notices).toEqual([{ at: WALL, message: expect.stringContaining('rule hot') as string }])
    second.application.stop()

    const third = setup(upgraded, core)
    expect(third.application.rulesets().rulesets[0]?.notices).toEqual(notices)
    expect(third.application.dismissNotices('batteries', 'admin')).toBe('ok')
    expect(third.application.rulesets().rulesets[0]?.notices).toEqual([])
    expect(third.application.log()[0]).toMatchObject({ action: 'dismiss', ruleset: 'batteries' })
    expect(third.application.dismissNotices('other', 'admin')).toBe('notFound')
  })

  it('a ruleset no longer installed stops its rules and clears their alerts', () => {
    const installed: Installed = { rulesets: [batteries()] }
    const { application, at, alerts } = setup(installed)
    at(0, VOLTAGE, 11)
    application.setRulesetEnabled('batteries', true, 'admin')
    at(5)

    installed.rulesets = []
    application.rescan('admin')

    expect(alerts()).toEqual([[LOW, false]])
    expect(application.rulesets().rulesets).toEqual([])
    expect(application.rule('batteries', 'low')).toBeUndefined()
  })

  it('takes per-rule controls under the ruleset rule id', () => {
    const { application, at, alerts } = setup({ rulesets: [batteries()] })
    application.setRulesetEnabled('batteries', true, 'admin')
    expect(application.setEnabled('batteries', 'low', false, 'admin')).toBe('ok')
    at(0, VOLTAGE, 11)
    at(5)
    expect(alerts()).toEqual([])
    expect(application.rule('batteries', 'low')?.status).toMatchObject({ reason: 'disabled' })

    application.setEnabled('batteries', 'low', true, 'admin')
    at(10)
    expect(alerts()).toEqual([[LOW, true]])
    application.suppressRule('batteries', 'low', {}, 'admin')
    expect(alerts()).toEqual([[LOW, false]])
  })

  describe('a rule whose path the server has not had', () => {
    it('stays inactive and raises nothing, not even absence, until the path appears', () => {
      const { application, at, alerts } = setup({ rulesets: [batteries('1.0.0', [silent])] })
      application.setRulesetEnabled('batteries', true, 'admin')
      at(0)
      at(30)

      expect(alerts()).toEqual([])
      expect(application.rule('batteries', 'silent')?.status).toMatchObject({
        badge: 'inactive',
        reason: 'ruleset path missing',
        issues: [`path ${VOLTAGE} has not been seen`],
        errors: []
      })
      expect(application.rulesets().rulesets[0]?.missingPaths).toEqual([VOLTAGE])

      at(30, VOLTAGE, 12.5)
      at(31)
      expect(application.rule('batteries', 'silent')?.status.badge).not.toBe('inactive')
      expect(application.rulesets().rulesets[0]?.missingPaths).toEqual([])
      at(41)
      expect(alerts()).toEqual([['rules.batteries.silent', true]])
    })

    it('starts once the path a parameter change points it at appears', () => {
      const { application, at, alerts } = setup({ rulesets: [batteries('1.0.0', [low])] })
      application.setRulesetEnabled('batteries', true, 'admin')
      at(0)
      expect(application.rule('batteries', 'low')?.status.badge).toBe('inactive')

      application.setRulesetParameters(
        'batteries',
        { prefix: 'electrical.batteries.start' },
        'admin'
      )
      at(1, START_VOLTAGE, 11)
      at(2)
      at(10)

      expect(alerts()).toEqual([[LOW, true]])
    })

    it('goes inactive again when a parameter change points it at a path not seen', () => {
      const { application, at, alerts } = setup({ rulesets: [batteries('1.0.0', [silent])] })
      at(0, VOLTAGE, 12.5)
      application.setRulesetEnabled('batteries', true, 'admin')
      at(1)
      expect(application.rule('batteries', 'silent')?.status.badge).not.toBe('inactive')

      application.setRulesetParameters(
        'batteries',
        { prefix: 'electrical.batteries.start' },
        'admin'
      )
      expect(application.rule('batteries', 'silent')?.status.badge).toBe('inactive')
      at(2)
      at(40)

      expect(alerts()).toEqual([])
      expect(application.rule('batteries', 'silent')?.status).toMatchObject({
        badge: 'inactive',
        reason: 'ruleset path missing',
        issues: [`path ${START_VOLTAGE} has not been seen`]
      })
      expect(application.rulesets().rulesets[0]?.missingPaths).toEqual([START_VOLTAGE])
    })

    it('says it starts at the next tick once its paths have appeared', () => {
      const { application, at } = setup({ rulesets: [batteries('1.0.0', [silent])] })
      application.setRulesetEnabled('batteries', true, 'admin')
      at(0)
      at(1, VOLTAGE, 12.5)

      expect(application.rule('batteries', 'silent')?.status).toMatchObject({
        badge: 'inactive',
        reason: 'starts at the next tick',
        issues: []
      })
    })

    it('lists the missing paths of a disabled ruleset too', () => {
      const { application } = setup({ rulesets: [batteries()] })
      expect(application.rulesets().rulesets[0]?.missingPaths).toEqual([VOLTAGE, TEMPERATURE])
    })

    it('keeps an alert core holds for it at start, before the path reports again', () => {
      const core = new FakeAlertsCore()
      const first = setup({ rulesets: [batteries()] }, core)
      first.at(0, VOLTAGE, 11)
      first.application.setRulesetEnabled('batteries', true, 'admin')
      first.at(5)
      first.application.stop()

      // A new server has not had any path yet.
      const second = setup({ rulesets: [batteries()] }, core)
      second.at(6)
      expect(second.alerts()).toEqual([[LOW, true]])
      expect(second.application.rule('batteries', 'low')?.status.badge).toBe('alertActive')
    })
  })

  it('an unknown ruleset cannot be enabled', () => {
    const { application } = setup({ rulesets: [] })
    expect(application.setRulesetEnabled('batteries', true, 'admin')).toBe('notFound')
  })
})

function stored(rule: { slug: string }): void {
  fs.mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
}
