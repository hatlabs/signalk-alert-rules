import { describe, it, expect } from 'vitest'
import type { PathValueState, Value } from '@signalk/server-api'
import { HEARTBEAT_S, type AlertValue } from '../../src/alerts/emitter.js'
import { RuleRunner, type LoadedRule } from '../../src/alerts/runner.js'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'
import { FakeAlertsCore } from '../helpers/FakeAlertsCore.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

const PLUGIN = 'signalk-alert-rules'
const TIMED_OUT: PathValueState = { timedOut: true }

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

const OIL = 'propulsion.main.oilPressure'
const RPM = 'propulsion.main.revolutions'
const oil = valid({
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  priority: 'alarm',
  signal: { path: OIL },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'fixed', value: 100000 },
    duration: 5,
    hysteresis: 50000,
    clearDuration: 10
  }
})
const gatedOil = valid({
  ...oil,
  gates: [
    { signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 }, duration: 10 }
  ]
})
const coolant = valid({
  name: 'Coolant high',
  slug: 'coolant-high',
  message: 'Coolant high on {instance}',
  priority: 'alarm',
  signal: { path: 'propulsion.*.coolantTemperature' },
  detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } }
})
const OIL_ALERT = 'rules.user.oil-pressure-low'
const PORT_ALERT = 'rules.user.coolant-high.port'

function setup(rules: Rule[], options: { core?: FakeAlertsCore } = {}) {
  const sm = new FakeSubscriptionManager()
  const core = options.core ?? new FakeAlertsCore()
  const sent: [string, AlertValue | null][] = []
  let now = 0
  const loaded: LoadedRule[] = rules.map((rule) => ({ origin: 'user', rule }))
  const runner = new RuleRunner(
    {
      pluginId: PLUGIN,
      subscriptions: sm,
      meta: () => undefined,
      timeoutSettings: () => ({ enforce: true, useDefaults: true }),
      clock: () => now,
      wallClock: () => new Date('2026-09-29T12:00:00Z'),
      alerts: core,
      send: (path, value) => {
        sent.push([path, value])
        core.ingest(PLUGIN, path, value)
      }
    },
    loaded
  )
  runner.start()
  return {
    core,
    sent,
    runner,
    at: (t: number, path?: string, value?: Value, state?: PathValueState) => {
      now = t
      if (path === undefined) runner.tick()
      else sm.publish(path, 'src', value ?? null, state)
    },
    run: (from: number, to: number) => {
      for (now = from; now <= to; now++) runner.tick()
    }
  }
}

function coreWith(path: string, message = 'Engine oil pressure is low'): FakeAlertsCore {
  const core = new FakeAlertsCore()
  core.ingest(PLUGIN, path, {
    priority: 'alarm',
    message,
    latching: false,
    data: { rule: 'user.oil-pressure-low' }
  })
  core.alertings = 0
  return core
}

const sentTo = (sent: [string, AlertValue | null][], path: string) =>
  sent.filter(([p]) => p === path)

describe('rule runner', () => {
  it('raises on condition entry with stable data, heartbeats it, and clears on exit', () => {
    const { at, run, sent, core } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    expect(sent).toEqual([
      [
        OIL_ALERT,
        {
          priority: 'alarm',
          message: 'Engine oil pressure is low',
          latching: false,
          data: {
            rule: 'user.oil-pressure-low',
            name: 'Oil pressure low',
            limit: 100000,
            valueAtRaise: 0,
            raisedAt: '2026-09-29T12:00:00.000Z'
          }
        }
      ]
    ])
    run(6, 5 + HEARTBEAT_S)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    at(40, OIL, 300000)
    run(41, 50)
    expect(sent.at(-1)).toEqual([OIL_ALERT, null])
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(false)
  })

  it('a message or priority edit on an active rule is sent with the next heartbeat', () => {
    const { at, run, runner, sent, core } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    const raised = sent[0]?.[1]
    runner.update({
      origin: 'user',
      rule: { ...oil, message: 'Check the oil', priority: 'emergency' }
    })
    expect(sent).toHaveLength(1)
    run(6, 5 + HEARTBEAT_S)
    expect(sent.at(-1)).toEqual([
      OIL_ALERT,
      { priority: 'emergency', message: 'Check the oil', latching: false, data: raised?.data }
    ])
    expect(core.getByPath(OIL_ALERT)).toMatchObject({
      priority: 'emergency',
      message: 'Check the oil'
    })
  })

  it("adopts an alert of an existing rule with the rule's current message and no data, without raising", () => {
    const core = coreWith(OIL_ALERT, 'Old message')
    const { at, run, sent } = setup([{ ...oil, message: 'New message' }], { core })
    at(0, OIL, 0)
    run(1, 2 * HEARTBEAT_S)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every(([, v]) => v?.message === 'New message' && v.data === undefined)).toBe(true)
    expect(core.getByPath(OIL_ALERT)?.data).toEqual({ rule: 'user.oil-pressure-low' })
  })

  it("an adopted wildcard alert's message keeps the instance name its raise used", () => {
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, 'rules.user.coolant-high.port_aft', {
      priority: 'alarm',
      message: 'Coolant high on port.aft',
      latching: false,
      data: { rule: 'user.coolant-high', instance: 'port.aft' }
    })
    core.alertings = 0
    const { sent } = setup([coolant], { core })
    expect(sent.at(0)?.[1]?.message).toBe('Coolant high on port.aft')
    expect(core.alertings).toBe(0)
  })

  it("an adopted wildcard alert's message names its instance", () => {
    const core = coreWith(PORT_ALERT)
    const { sent } = setup([coolant], { core })
    expect(sentTo(sent, PORT_ALERT)[0]?.[1]?.message).toBe('Coolant high on port')
  })

  it('clears an alert whose rule was deleted', () => {
    const core = coreWith('rules.user.deleted-rule')
    const { sent } = setup([oil], { core })
    expect(sent).toEqual([['rules.user.deleted-rule', null]])
  })

  it('leaves an alert whose condition ended to core across a restart, and raises it on re-entry', () => {
    const core = coreWith(OIL_ALERT)
    core.ingest(PLUGIN, OIL_ALERT, null)
    const { at, run, sent } = setup([oil], { core })
    at(0, OIL, 300000)
    run(1, 3 * HEARTBEAT_S)
    expect(sent).toEqual([])
    expect(core.getByPath(OIL_ALERT)?.state).toBe('rtn-unacknowledged')
    at(100, OIL, 0)
    run(101, 105)
    expect(sent.map(([, v]) => v?.priority)).toEqual(['alarm'])
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
  })

  it('an adopted sustained alert inside the hysteresis band stays active when inputs arrive late', () => {
    const core = coreWith(OIL_ALERT)
    const { at, run } = setup([oil], { core })
    run(0, 100)
    at(101, OIL, 120000)
    run(102, 300)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
    expect(core.alertings).toBe(0)
  })

  it('an adopted gated alert whose gate input arrives late is neither cleared nor re-raised', () => {
    const core = coreWith(OIL_ALERT)
    const { at, run, sent } = setup([gatedOil], { core })
    at(0, OIL, 0)
    run(1, 30)
    at(31, RPM, 30)
    run(32, 100)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
    expect(core.alertings).toBe(0)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every(([, v]) => v !== null)).toBe(true)
  })

  it('an adopted wildcard instance is heartbeated on its own input only, and kept until it reports', () => {
    const core = coreWith(PORT_ALERT)
    const { at, run, sent } = setup([coolant], { core })
    at(0, 'propulsion.starboard.coolantTemperature', 350)
    for (let t = 20; t <= 100; t += 20) at(t, 'propulsion.starboard.coolantTemperature', 350)
    run(1, 100)
    expect(sentTo(sent, PORT_ALERT)).toHaveLength(1)
    expect(core.getByPath(PORT_ALERT)?.condition).toBe(true)
    at(101, 'propulsion.port.coolantTemperature', 370)
    run(102, 150)
    expect(sentTo(sent, PORT_ALERT).length).toBeGreaterThan(1)
    expect(core.getByPath(PORT_ALERT)?.condition).toBe(true)
    expect(core.alertings).toBe(0)
  })

  it('an adopted alert whose inputs never arrive gets one heartbeat at adoption and no more', () => {
    const core = coreWith(OIL_ALERT)
    const { run, sent, runner } = setup([oil], { core })
    run(0, 200)
    expect(sent).toHaveLength(1)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
    expect(runner.status('user.oil-pressure-low')?.instances[0]?.awaitingInput).toBe(true)
  })

  it('an absence alert raised while its input has never been seen keeps heartbeating', () => {
    const watch = valid({
      name: 'Watch not acknowledged',
      slug: 'watch-not-acknowledged',
      message: 'No watch acknowledgement received',
      priority: 'alarm',
      signal: { path: 'navigation.watch.acknowledged' },
      detector: { type: 'absence', event: { op: 'changes' }, within: 900 }
    })
    const { run, sent, runner } = setup([watch])
    run(0, 900 + 2 * HEARTBEAT_S)
    expect(sent).toHaveLength(3)
    expect(runner.status('user.watch-not-acknowledged')?.instances[0]?.awaitingInput).toBe(false)
  })

  it('an adopted absence alert keeps heartbeating while its input stays silent', () => {
    const WATCH_ALERT = 'rules.user.watch-not-acknowledged'
    const watch = valid({
      name: 'Watch not acknowledged',
      slug: 'watch-not-acknowledged',
      message: 'No watch acknowledgement received',
      priority: 'alarm',
      signal: { path: 'navigation.watch.acknowledged' },
      detector: { type: 'absence', event: { op: 'changes' }, within: 900 }
    })
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, WATCH_ALERT, {
      priority: 'alarm',
      message: 'No watch acknowledgement received',
      latching: false
    })
    const { run, sent } = setup([watch], { core })
    run(0, 3 * HEARTBEAT_S)
    expect(sentTo(sent, WATCH_ALERT)).toHaveLength(4)
  })

  it('a raised timeout rule is heartbeated although its input is timed out', () => {
    const DEPTH = 'environment.depth.belowTransducer'
    const depth = valid({
      name: 'Depth sensor silent',
      slug: 'depth-sensor-silent',
      message: 'No depth data',
      priority: 'warning',
      signal: { path: DEPTH },
      detector: { type: 'match', op: 'timedOut', duration: 30 }
    })
    const { at, run, sent } = setup([depth])
    at(0, DEPTH, 7)
    at(10, DEPTH, null, TIMED_OUT)
    run(11, 40 + 2 * HEARTBEAT_S)
    expect(sent).toHaveLength(3)
  })

  it("another source's report that the condition ended is overridden at the next heartbeat", () => {
    const { at, run, core } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    core.reportEnded('alerts-api', OIL_ALERT)
    run(6, 5 + HEARTBEAT_S)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
  })

  it('starts a rule added while running', () => {
    const { at, run, runner, sent } = setup([])
    runner.update({ origin: 'user', rule: oil })
    at(0, OIL, 0)
    run(1, 5)
    expect(sent).toHaveLength(1)
    expect(runner.status('user.oil-pressure-low')).toBeDefined()
  })

  it('stopping clears nothing', () => {
    const { at, run, runner, sent } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    runner.stop()
    expect(sent).toHaveLength(1)
  })

  it('removing a rule clears its alert', () => {
    const { at, run, runner, sent } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    runner.remove('user.oil-pressure-low')
    expect(sent.at(-1)).toEqual([OIL_ALERT, null])
  })

  it('an instance whose alert path would be invalid is reported and emits nothing', () => {
    const rule = valid({
      name: 'Tank low',
      slug: 'tank-low',
      message: 'Tank {instance} low',
      priority: 'warning',
      signal: { path: 'tanks.fuel.*.currentLevel' },
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 0.1 } }
    })
    const { at, sent, runner } = setup([rule])
    at(0, `tanks.fuel.${'x'.repeat(260)}.currentLevel`, 0.05)
    expect(sent).toEqual([])
    expect(runner.status('user.tank-low')?.issues.join()).toMatch(/longer than/)
  })
})
