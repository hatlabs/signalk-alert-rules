import { describe, it, expect } from 'vitest'
import type { PathValueState, Value } from '@signalk/server-api'
import { HEARTBEAT_S, type AlertValue } from '../../src/alerts/emitter.js'
import { RuleRunner } from '../../src/alerts/runner.js'
import type { PathMeta } from '../../src/engine/evaluator.js'
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
const VOLTAGE = 'electrical.batteries.house.voltage'
const batteryLow = valid({
  name: 'House battery low',
  slug: 'house-battery-low',
  message: 'House battery voltage is low',
  signal: { path: VOLTAGE },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'zone', level: 'warn' },
    duration: 5,
    hysteresis: 0.1,
    clearDuration: 5
  }
})
const batteryZones: PathMeta = {
  zones: [
    { upper: 11.5, state: 'alarm', message: 'Battery flat' },
    { lower: 11.5, upper: 12, state: 'warn', message: 'Battery low' }
  ]
}
const PUMP = 'electrical.switches.bilgePump.state'
const pumpCycling = valid({
  name: 'Bilge pump cycling',
  slug: 'bilge-pump-cycling',
  message: 'Bilge pump is cycling',
  priority: 'alarm',
  signal: { path: PUMP },
  detector: { type: 'count', event: { op: 'changesTo', value: true }, window: 60, limit: 1 }
})
const latchingPump = valid({ ...pumpCycling, latching: true })
const pumpOn = valid({
  name: 'Bilge pump on',
  slug: 'bilge-pump-on',
  message: 'Bilge pump started',
  priority: 'alarm',
  latching: true,
  signal: { path: PUMP },
  detector: { type: 'match', op: 'changesTo', value: true }
})
const BATTERY_ALERT = 'electrical.batteries.house.voltageLow'
const OIL_ALERT = 'propulsion.main.oilPressureLow'
const PORT_ALERT = 'propulsion.port.coolantTemperatureHigh'
const PUMP_ALERT = 'electrical.switches.bilgePump.stateFrequent'

function setup(
  rules: Rule[],
  options: {
    core?: FakeAlertsCore
    meta?: Record<string, PathMeta>
    /** Values already in the server's delta cache, replayed when the runner subscribes. */
    cached?: [string, Value][]
    /** Accumulator totals restored from the store, by rule id and instance segment. */
    accumulated?: Map<string, Map<string, number>>
    disabled?: (id: string) => boolean
    subscriptions?: FakeSubscriptionManager
  } = {}
) {
  const sm = options.subscriptions ?? new FakeSubscriptionManager()
  const core = options.core ?? new FakeAlertsCore()
  const sent: [string, AlertValue | null][] = []
  let now = 0
  const runner = new RuleRunner(
    {
      pluginId: PLUGIN,
      subscriptions: sm,
      meta: (path) => options.meta?.[path],
      timeoutSettings: () => ({ enforce: true, useDefaults: true }),
      clock: () => now,
      wallClock: () => new Date('2026-09-29T12:00:00Z'),
      alerts: core,
      send: (path, value) => {
        sent.push([path, value])
        core.ingest(PLUGIN, path, value)
      }
    },
    rules,
    options.accumulated,
    options.disabled
  )
  for (const [path, value] of options.cached ?? []) sm.publish(path, 'src', value)
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
    data: { rule: 'oil-pressure-low' }
  })
  core.alertings = 0
  return core
}

/** Two pump starts from `t`, which puts the pump rule over its limit at `t + 3`. */
function pumpStarts(at: (t: number, path: string, value: Value) => void, t: number): void {
  for (const [dt, on] of [
    [0, false],
    [1, true],
    [2, false],
    [3, true]
  ] as const)
    at(t + dt, PUMP, on)
}

function coreWithLatching(path: string, message: string): FakeAlertsCore {
  const core = new FakeAlertsCore()
  core.ingest(PLUGIN, path, { priority: 'alarm', message, latching: true })
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
            rule: 'oil-pressure-low',
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
    runner.update({ ...oil, message: 'Check the oil', priority: 'emergency' })
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

  it('a zone-limit alert escalates at once when a more severe level is entered, and reports a fall', () => {
    const { at, run, sent, core, runner } = setup([batteryLow], {
      meta: { [VOLTAGE]: batteryZones }
    })
    at(0, VOLTAGE, 11.8)
    run(1, 5)
    const raised = sent[0]?.[1]
    expect(raised).toMatchObject({ priority: 'warning', message: 'House battery voltage is low' })
    core.acknowledge(BATTERY_ALERT)
    at(6, VOLTAGE, 11.3)
    run(7, 11)
    expect(sent).toEqual([
      [BATTERY_ALERT, raised],
      [
        BATTERY_ALERT,
        {
          priority: 'alarm',
          message: 'House battery voltage is low',
          latching: false,
          data: raised?.data
        }
      ]
    ])
    expect(core.getByPath(BATTERY_ALERT)).toMatchObject({
      priority: 'alarm',
      state: 'unacknowledged'
    })
    expect(runner.status('house-battery-low')?.instances[0]).toMatchObject({
      level: 'alarm',
      priority: 'alarm'
    })
    at(12, VOLTAGE, 11.8)
    run(13, 17)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'warning' })
    expect(sent).toHaveLength(3)
    expect(core.getByPath(BATTERY_ALERT)).toMatchObject({ priority: 'alarm', condition: true })
    run(18, 17 + HEARTBEAT_S)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'warning' })
    expect(sent).toHaveLength(4)
  })

  it("an edit to an active zone-limit rule keeps the level's priority", () => {
    const { at, run, sent, runner } = setup([batteryLow], { meta: { [VOLTAGE]: batteryZones } })
    at(0, VOLTAGE, 11.3)
    run(1, 5)
    runner.update({ ...batteryLow, message: 'Charge the battery' })
    run(6, 5 + HEARTBEAT_S)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'alarm', message: 'Charge the battery' })
  })

  it('an adopted zone-limit alert is heartbeated at the priority of its named level', () => {
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, BATTERY_ALERT, {
      priority: 'alarm',
      message: 'House battery voltage is low',
      latching: false
    })
    const { sent } = setup([batteryLow], { core, meta: { [VOLTAGE]: batteryZones } })
    expect(sent).toEqual([
      [
        BATTERY_ALERT,
        { priority: 'warning', message: 'House battery voltage is low', latching: false }
      ]
    ])
    expect(core.getByPath(BATTERY_ALERT)?.priority).toBe('alarm')
  })

  it("adopts an alert of an existing rule with the rule's current message and no data, without raising", () => {
    const core = coreWith(OIL_ALERT, 'Old message')
    core.acknowledge(OIL_ALERT)
    const { at, run, sent } = setup([{ ...oil, message: 'New message' }], { core })
    at(0, OIL, 0)
    run(1, 2 * HEARTBEAT_S)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every(([, v]) => v?.message === 'New message' && v.data === undefined)).toBe(true)
    expect(core.getByPath(OIL_ALERT)).toMatchObject({
      data: { rule: 'oil-pressure-low' },
      message: 'New message',
      state: 'acknowledged'
    })
    expect(core.alertings).toBe(0)
  })

  it("an adopted wildcard alert's message keeps the instance name its raise used", () => {
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, 'propulsion.port_aft.coolantTemperatureHigh', {
      priority: 'alarm',
      message: 'Coolant high on port.aft',
      latching: false,
      data: { rule: 'coolant-high', instance: 'port.aft' }
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
    const core = coreWith('electrical.batteries.start.voltageLow')
    const { sent } = setup([oil], { core })
    expect(sent).toEqual([['electrical.batteries.start.voltageLow', null]])
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
    expect(runner.status('oil-pressure-low')?.instances[0]?.awaitingInput).toBe(true)
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
    expect(runner.status('watch-not-acknowledged')?.instances[0]?.awaitingInput).toBe(false)
  })

  it('an adopted absence alert keeps heartbeating while its input stays silent', () => {
    const WATCH_ALERT = 'navigation.watch.acknowledgedMissing'
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

  it('a latching rule raises once on entry, and sends nothing while its condition lasts or when it ends', () => {
    const { at, run, runner, sent, core } = setup([latchingPump])
    pumpStarts(at, 0)
    pumpStarts(at, 10)
    runner.update({ ...latchingPump, message: 'Check the bilge' })
    run(14, 13 + 60 + 3 * HEARTBEAT_S)
    expect(sent).toEqual([
      [PUMP_ALERT, expect.objectContaining({ priority: 'alarm', latching: true })]
    ])
    expect(core.getByPath(PUMP_ALERT)).toMatchObject({ condition: false, state: 'unacknowledged' })
  })

  it('a latching rule raises again when its condition returns, and core alerts each time', () => {
    const { at, run, sent, core } = setup([latchingPump])
    pumpStarts(at, 0)
    run(4, 70)
    pumpStarts(at, 100)
    run(104, 103 + HEARTBEAT_S)
    expect(sent.map(([, v]) => v?.latching)).toEqual([true, true])
    expect(core.alertings).toBe(2)
  })

  it('a latching alert core holds at start is neither adopted nor sent anything', () => {
    const core = coreWithLatching(PUMP_ALERT, 'Bilge pump is cycling')
    const { at, run, sent, runner } = setup([latchingPump], { core })
    at(0, PUMP, false)
    run(1, 3 * HEARTBEAT_S)
    expect(sent).toEqual([])
    expect(runner.status('bilge-pump-cycling')?.instances[0]).toMatchObject({
      active: false,
      adopted: false
    })
    expect(core.getByPath(PUMP_ALERT)).toMatchObject({ condition: false, state: 'unacknowledged' })
  })

  it('turning latching on clears an active alert, and the next occurrence raises once as an event', () => {
    const { at, run, runner, sent } = setup([pumpCycling])
    pumpStarts(at, 0)
    runner.update(latchingPump)
    pumpStarts(at, 10)
    run(14, 13 + 3 * HEARTBEAT_S)
    expect(sent.map(([, v]) => v?.latching ?? null)).toEqual([false, null, true])
  })

  it('turning latching off has nothing to clear, and the next occurrence raises an active alert', () => {
    const { at, run, runner, sent, core } = setup([latchingPump])
    pumpStarts(at, 0)
    runner.update(pumpCycling)
    pumpStarts(at, 10)
    run(14, 13 + HEARTBEAT_S)
    expect(sent.map(([, v]) => v?.latching ?? null)).toEqual([true, false, false])
    expect(core.getByPath(PUMP_ALERT)).toMatchObject({ condition: true, latching: false })
  })

  it('an active alert of a rule turned latching while SKAR was down is cleared, and the rule starts afresh', () => {
    const core = coreWith(PUMP_ALERT, 'Bilge pump is cycling')
    const { at, run, sent } = setup([latchingPump], { core })
    pumpStarts(at, 0)
    run(4, 3 + 2 * HEARTBEAT_S)
    expect(sent.map(([, v]) => v?.latching ?? null)).toEqual([null, true])
  })

  it('a latching count does not raise again at restart: the replayed last value is not an event', () => {
    const core = coreWithLatching(PUMP_ALERT, 'Bilge pump is cycling')
    const { at, run, sent } = setup([latchingPump], { core, cached: [[PUMP, true]] })
    at(5, PUMP, false)
    at(6, PUMP, true)
    run(7, 3 * HEARTBEAT_S)
    expect(sent).toEqual([])
    expect(core.alertings).toBe(0)
  })

  it('a latching changesTo match does not raise again at restart when its value is replayed', () => {
    const alert = 'electrical.switches.bilgePump.stateChanged'
    const core = coreWithLatching(alert, 'Bilge pump started')
    const { at, run, sent } = setup([pumpOn], { core, cached: [[PUMP, true]] })
    at(5, PUMP, true)
    run(6, 3 * HEARTBEAT_S)
    expect(sent).toEqual([])
    expect(core.alertings).toBe(0)
  })

  it('starts a rule added while running', () => {
    const { at, run, runner, sent } = setup([])
    runner.update(oil)
    at(0, OIL, 0)
    run(1, 5)
    expect(sent).toHaveLength(1)
    expect(runner.status('oil-pressure-low')).toBeDefined()
  })

  it('restores accumulator totals per rule and reports them for checkpoints', () => {
    const hours = valid({
      name: 'Engine hours',
      slug: 'engine-hours',
      message: 'Engine service due',
      priority: 'caution',
      signal: { path: 'propulsion.main.revolutions' },
      detector: { type: 'accumulator', measure: 'time', limit: 100 }
    })
    const { at, run, runner, sent } = setup([hours, oil], {
      accumulated: new Map([
        ['engine-hours', new Map([['', 95]])],
        ['deleted-rule', new Map([['', 5]])]
      ])
    })
    at(0, 'propulsion.main.revolutions', 30)
    run(1, 4)
    expect(runner.accumulators()).toEqual(
      new Map([['engine-hours', { measure: 'time', totals: new Map([['', 99]]) }]])
    )
    run(5, 5)
    expect(sent.map(([path]) => path)).toEqual(['propulsion.main.revolutionsAccumulated'])
  })

  it('a rule added while running reports its accumulator total', () => {
    const { at, runner } = setup([])
    runner.update(
      valid({
        name: 'Engine hours',
        slug: 'engine-hours',
        message: 'Engine service due',
        priority: 'caution',
        signal: { path: 'propulsion.main.revolutions' },
        detector: { type: 'accumulator', measure: 'time', limit: 100 }
      })
    )
    at(0, 'propulsion.main.revolutions', 30)
    at(7)
    expect(runner.accumulators()).toEqual(
      new Map([['engine-hours', { measure: 'time', totals: new Map([['', 7]]) }]])
    )
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
    runner.remove('oil-pressure-low')
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
    expect(runner.status('tank-low')).toMatchObject({ badge: 'inactive', errors: [] })
    expect(runner.status('tank-low')?.reason).toMatch(/longer than/)
    expect(runner.status('tank-low')?.instances[0]?.inactive).toMatch(/longer than/)
  })
})

describe('rule status', () => {
  const OIL_ID = 'oil-pressure-low'

  it('a wildcard rule with one instance active and one gated off reports each instance', () => {
    const rule = valid({
      ...coolant,
      gates: [
        {
          signal: { path: 'propulsion.*.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 }
        }
      ]
    })
    const { at, runner } = setup([rule])
    at(0, 'propulsion.port.revolutions', 30)
    at(0, 'propulsion.starboard.revolutions', 0)
    at(1, 'propulsion.port.coolantTemperature', 370)
    at(1, 'propulsion.starboard.coolantTemperature', 371)
    const status = runner.status('coolant-high')
    expect(status).toMatchObject({ badge: 'alertActive', subLabels: [], errors: [], issues: [] })
    const byName = new Map(status?.instances.map((i) => [i.instance?.name, i]))
    expect(byName.get('port')).toMatchObject({
      badge: 'alertActive',
      subLabels: [],
      active: true,
      value: 370,
      limit: 368,
      gates: [{ holds: true, input: 'value' }],
      awaitingInput: false
    })
    expect(byName.get('starboard')).toMatchObject({
      badge: 'gatedOff',
      active: false,
      value: 371,
      limit: 368,
      gates: [{ holds: false, input: 'value' }]
    })
  })

  type Step = (s: ReturnType<typeof setup>) => void
  it.each<[string, Rule, Step]>([
    [
      'idle',
      oil,
      ({ at }) => {
        at(0, OIL, 300000)
      }
    ],
    [
      'timerRunning',
      oil,
      ({ at }) => {
        at(0, OIL, 0)
        at(2)
      }
    ],
    [
      'neverSeen',
      oil,
      ({ at }) => {
        at(2)
      }
    ],
    [
      'inputUnavailable',
      oil,
      ({ at }) => {
        at(0, OIL, null)
      }
    ],
    [
      'gatedOff',
      gatedOil,
      ({ at }) => {
        at(0, RPM, 0)
        at(0, OIL, 0)
      }
    ],
    [
      'alertActive',
      oil,
      ({ at, run }) => {
        at(0, OIL, 0)
        run(1, 5)
      }
    ]
  ])('reports %s', (badge, rule, step) => {
    const s = setup([rule])
    step(s)
    expect(s.runner.status(OIL_ID)).toMatchObject({ badge, subLabels: [] })
    expect(s.runner.status(OIL_ID)?.reason).toBeUndefined()
  })

  it('reports inactive with the reason', () => {
    const { at, runner } = setup([batteryLow], {
      meta: { [VOLTAGE]: { zones: [{ upper: 11.5, state: 'alarm' }] } }
    })
    at(0, VOLTAGE, 12.6)
    expect(runner.status('house-battery-low')).toMatchObject({
      badge: 'inactive',
      reason: 'the path has no warn zone'
    })
  })

  it('reports errored with the evaluation error, until the rule is edited', () => {
    let broken = false
    const meta = {
      get [VOLTAGE](): PathMeta {
        if (broken) throw new Error('meta unreadable')
        return batteryZones
      }
    }
    const { at, runner } = setup([batteryLow], { meta })
    at(0, VOLTAGE, 12.6)
    broken = true
    at(1)
    expect(runner.status('house-battery-low')).toMatchObject({
      badge: 'errored',
      reason: 'evaluation failed: meta unreadable',
      errors: ['evaluation failed: meta unreadable']
    })
    broken = false
    runner.update(batteryLow)
    expect(runner.status('house-battery-low')).toMatchObject({ badge: 'idle', errors: [] })
  })

  it('a rule that throws at start is errored while the others run, until it is edited', () => {
    let broken = true
    const meta = {
      get [VOLTAGE](): PathMeta {
        if (broken) throw new Error('meta unreadable')
        return batteryZones
      }
    }
    const { at, run, runner, sent } = setup([batteryLow, oil], { meta })
    expect(runner.status('house-battery-low')).toMatchObject({
      badge: 'errored',
      reason: 'failed to start: meta unreadable'
    })
    at(0, OIL, 0)
    at(0, VOLTAGE, 11.8)
    run(1, 6)
    expect(sent.map(([path]) => path)).toEqual([OIL_ALERT])

    broken = false
    runner.update(batteryLow)
    expect(runner.status('house-battery-low')).toMatchObject({ errors: [] })
    at(7, VOLTAGE, 11.8)
    run(8, 12)
    expect(sent.map(([path]) => path)).toEqual([OIL_ALERT, BATTERY_ALERT])
  })

  describe('a rule that failed to start with an adopted alert', () => {
    const failing = () => {
      const core = new FakeAlertsCore()
      core.ingest(PLUGIN, BATTERY_ALERT, {
        priority: 'warning',
        message: 'House battery voltage is low',
        latching: false
      })
      const meta = {
        get [VOLTAGE](): PathMeta {
          throw new Error('meta unreadable')
        }
      }
      const env = setup([batteryLow], { core, meta })
      expect(env.runner.failedToStart('house-battery-low')).toBe(true)
      expect(core.getByPath(BATTERY_ALERT)?.condition).toBe(true)
      return env
    }

    it('clears the alert when edited', () => {
      const { core, run, runner, sent } = failing()
      runner.update({ ...batteryLow, message: 'Check the battery' })
      expect(core.getByPath(BATTERY_ALERT)?.condition).toBe(false)
      const cleared = sent.length
      run(1, 120)
      expect(sent.slice(cleared)).toEqual([])
    })

    it('clears the alert when deleted', () => {
      const { core, run, runner, sent } = failing()
      runner.remove('house-battery-low')
      expect(core.getByPath(BATTERY_ALERT)?.condition).toBe(false)
      const cleared = sent.length
      run(1, 120)
      expect(sent.slice(cleared)).toEqual([])
    })
  })

  describe('an accumulator rule that failed to start with a restored total', () => {
    const HOURS_ID = 'engine-hours'
    const hours = valid({
      name: 'Engine hours',
      slug: 'engine-hours',
      message: 'Engine service due',
      priority: 'caution',
      signal: { path: RPM },
      detector: { type: 'accumulator', measure: 'time', limit: 100 }
    })
    const failing = () => {
      const subscriptions = new FakeSubscriptionManager()
      subscriptions.subscribe = () => {
        throw new Error('subscriptions unavailable')
      }
      const runner = new RuleRunner(
        {
          pluginId: PLUGIN,
          subscriptions,
          meta: () => undefined,
          timeoutSettings: () => undefined,
          clock: () => 0,
          wallClock: () => new Date(),
          alerts: new FakeAlertsCore(),
          send: () => undefined
        },
        [hours],
        new Map([[HOURS_ID, new Map([['', 42]])]])
      )
      runner.start()
      expect(runner.failedToStart(HOURS_ID)).toBe(true)
      return runner
    }

    it('keeps the total for the checkpoint', () => {
      const runner = failing()
      expect(runner.status(HOURS_ID)?.badge).toBe('errored')
      expect(runner.accumulators()).toEqual(
        new Map([[HOURS_ID, { measure: 'time', totals: new Map([['', 42]]) }]])
      )
    })

    it('keeps the total across an edit that carries it', () => {
      const runner = failing()
      runner.update({ ...hours, message: 'Service the engine' })
      expect(runner.accumulators().get(HOURS_ID)?.totals).toEqual(new Map([['', 42]]))
    })

    it('drops the total on a measure change', () => {
      const runner = failing()
      const integral = valid({
        ...hours,
        detector: { type: 'accumulator', measure: 'integral', limit: 100 }
      })
      runner.update(integral)
      expect(runner.accumulators().get(HOURS_ID)?.totals.get('') ?? 0).toBe(0)
    })
  })

  it('reports gate input unavailable on a gate that keeps holding', () => {
    const { at, runner } = setup([gatedOil])
    at(0, RPM, 30)
    at(0, OIL, 300000)
    at(10)
    at(11, RPM, null)
    expect(runner.status(OIL_ID)).toMatchObject({
      badge: 'idle',
      subLabels: ['gateInputUnavailable']
    })
  })

  it('reports waiting for clear while an active alert times its clear duration', () => {
    const { at, run, runner } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    at(6, OIL, 200000)
    at(8)
    expect(runner.status(OIL_ID)).toMatchObject({
      badge: 'alertActive',
      subLabels: ['waitingForClear']
    })
    expect(runner.status(OIL_ID)?.instances[0]?.progress).toEqual({
      kind: 'timer',
      toward: 'clear',
      elapsed: 2,
      target: 10
    })
  })

  it('reports awaiting input for an active alert whose input went unavailable', () => {
    const { at, run, runner } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    at(6, OIL, null)
    expect(runner.status(OIL_ID)).toMatchObject({
      badge: 'alertActive',
      subLabels: ['awaitingInput']
    })
  })
})

describe('disabled rules', () => {
  const OIL_ID = 'oil-pressure-low'

  it('disabling a rule clears its alert in core, stops its heartbeat and shows it disabled', () => {
    const disabled = new Set<string>()
    const { at, run, runner, core, sent } = setup([oil], { disabled: (id) => disabled.has(id) })
    at(0, OIL, 0)
    at(5)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
    disabled.add(OIL_ID)
    runner.refresh(OIL_ID)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(false)
    const count = sent.length
    run(6, 100)
    expect(sent).toHaveLength(count)
    const status = runner.status(OIL_ID)
    expect(status).toMatchObject({ badge: 'disabled' })
    expect(status?.instances[0]).toMatchObject({ badge: 'disabled', conditionPresent: true })
  })

  it('applying a disable to a rule whose evaluation throws records the error', () => {
    let broken = false
    const meta = {
      get [VOLTAGE](): PathMeta {
        if (broken) throw new Error('meta unreadable')
        return batteryZones
      }
    }
    const { at, runner } = setup([batteryLow], { meta, disabled: () => broken })
    at(0, VOLTAGE, 12.6)
    broken = true
    expect(() => {
      runner.refresh('house-battery-low')
    }).not.toThrow()
    expect(runner.status('house-battery-low')?.errors).toEqual([
      'evaluation failed: meta unreadable'
    ])
  })

  describe('a rule that failed to start with an adopted alert', () => {
    const BATTERY_ID = 'house-battery-low'
    const failing = (disabled: Set<string>) => {
      const core = new FakeAlertsCore()
      core.ingest(PLUGIN, BATTERY_ALERT, {
        priority: 'warning',
        message: 'House battery voltage is low',
        latching: false
      })
      // Failing before the first evaluation, so no step gets to clear the alert.
      const subscriptions = new FakeSubscriptionManager()
      subscriptions.subscribe = () => {
        throw new Error('subscriptions unavailable')
      }
      const env = setup([batteryLow], {
        core,
        subscriptions,
        disabled: (id) => disabled.has(id)
      })
      expect(env.runner.failedToStart(BATTERY_ID)).toBe(true)
      return env
    }

    it('clears the alert at start when the rule is disabled', () => {
      const { core, run, sent } = failing(new Set([BATTERY_ID]))
      expect(core.getByPath(BATTERY_ALERT)?.condition).toBe(false)
      const cleared = sent.length
      run(1, 120)
      expect(sent.slice(cleared)).toEqual([])
    })

    it('clears the alert when the rule is disabled later', () => {
      const disabled = new Set<string>()
      const { core, run, runner, sent } = failing(disabled)
      expect(core.getByPath(BATTERY_ALERT)?.condition).toBe(true)
      disabled.add(BATTERY_ID)
      runner.refresh(BATTERY_ID)
      expect(core.getByPath(BATTERY_ALERT)?.condition).toBe(false)
      const cleared = sent.length
      run(1, 120)
      expect(sent.slice(cleared)).toEqual([])
    })
  })

  it('enabling a rule raises an alert whose condition holds as a new alert', () => {
    const disabled = new Set([OIL_ID])
    const { at, runner, core } = setup([oil], { disabled: (id) => disabled.has(id) })
    at(0, OIL, 0)
    at(5)
    expect(core.getByPath(OIL_ALERT)).toBeNull()
    disabled.delete(OIL_ID)
    runner.refresh(OIL_ID)
    expect(core.getByPath(OIL_ALERT)?.condition).toBe(true)
    expect(core.alertings).toBe(1)
  })
})
