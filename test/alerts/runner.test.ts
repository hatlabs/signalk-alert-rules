import { describe, it, expect } from 'vitest'
import type { PathValueState, Value } from '@signalk/server-api'
import { HEARTBEAT_S, type AlertValue } from '../../src/alerts/emitter.js'
import { RuleRunner } from '../../src/alerts/runner.js'
import type { PathMeta } from '../../src/engine/evaluator.js'
import type { Priority, Rule } from '../../src/model/rule.js'
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
  signal: { path: OIL },
  detector: {
    type: 'sustained',
    direction: 'below',
    steps: [{ limit: 100000, priority: 'alarm' }],
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
  signal: { path: 'propulsion.*.coolantTemperature' },
  detector: { type: 'sustained', direction: 'above', steps: [{ limit: 368, priority: 'alarm' }] }
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
const steppedBattery = valid({
  ...batteryLow,
  detector: {
    type: 'sustained',
    direction: 'below',
    steps: [
      { limit: 12.2, priority: 'warning' },
      { limit: 11.8, priority: 'alarm' }
    ],
    duration: 5
  }
})
const PUMP = 'electrical.switches.bilgePump.state'
const pumpCycling = valid({
  name: 'Bilge pump cycling',
  slug: 'bilge-pump-cycling',
  message: 'Bilge pump is cycling',
  signal: { path: PUMP },
  detector: {
    type: 'count',
    event: { op: 'changesTo', value: true },
    window: 60,
    steps: [{ limit: 1, priority: 'alarm' }]
  }
})
const latchingPump = valid({ ...pumpCycling, latching: true })
const pumpOn = valid({
  name: 'Bilge pump on',
  slug: 'bilge-pump-on',
  message: 'Bilge pump started',
  latching: true,
  signal: { path: PUMP },
  detector: { type: 'match', op: 'changesTo', steps: [{ value: true, priority: 'alarm' }] }
})
const BATTERY_ALERT = 'electrical.batteries.house.voltageLow'
const OIL_ALERT = 'propulsion.main.oilPressureLow'
const PORT_ALERT = 'propulsion.port.coolantTemperatureHigh'
const PUMP_ALERT = 'electrical.switches.bilgePump.stateFrequent'

const WALL_START = Date.parse('2026-09-29T12:00:00Z')

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
    /** Wall time advances with the clock; otherwise it stays at its start. */
    wall?: boolean
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
      wallClock: () => new Date(WALL_START + (options.wall === true ? now * 1000 : 0)),
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
    // What SKAR's raise wrote, the limit included, so adoption has nothing to change.
    data: { rule: 'oil-pressure-low', limit: 100000 }
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
          references: [OIL],
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

  it("refers a wildcard instance's raise to the paths it reads, its gate's included", () => {
    const gatedCoolant = valid({
      ...coolant,
      gates: [
        {
          signal: { path: 'propulsion.*.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 }
        },
        { signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }
      ]
    })
    const { at, run, sent } = setup([gatedCoolant])
    at(0, 'propulsion.port.revolutions', 20)
    at(0, RPM, 20)
    at(0, 'propulsion.port.coolantTemperature', 380)
    run(1, 2)
    expect(sentTo(sent, PORT_ALERT)[0]?.[1]?.references).toEqual([
      'propulsion.port.coolantTemperature',
      'propulsion.port.revolutions',
      RPM
    ])
  })

  it('a message or priority edit on an active rule is sent with the next heartbeat', () => {
    const { at, run, runner, sent, core } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    const raised = sent[0]?.[1]
    runner.update({
      ...oil,
      message: 'Check the oil',
      detector: { ...oil.detector, steps: [{ limit: 100000, priority: 'emergency' }] }
    } as Rule)
    expect(sent).toHaveLength(1)
    run(6, 5 + HEARTBEAT_S)
    expect(sent.at(-1)).toEqual([
      OIL_ALERT,
      {
        priority: 'emergency',
        message: 'Check the oil',
        latching: false,
        references: [OIL],
        data: raised?.data
      }
    ])
    expect(core.getByPath(OIL_ALERT)).toMatchObject({
      priority: 'emergency',
      message: 'Check the oil'
    })
  })

  it('a zone-limit alert escalates at once when a more severe level is entered, and keeps it through a fall', () => {
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
          references: [VOLTAGE],
          data: { ...raised?.data, limit: 11.5 }
        }
      ]
    ])
    expect(core.getByPath(BATTERY_ALERT)).toMatchObject({
      priority: 'alarm',
      state: 'unacknowledged'
    })
    expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
      level: 'alarm',
      priority: 'alarm'
    })
    at(12, VOLTAGE, 11.8)
    run(13, 17)
    expect(sent).toHaveLength(2)
    expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
      level: 'alarm',
      priority: 'alarm'
    })
    run(18, 17 + HEARTBEAT_S)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'alarm' })
    expect(sent).toHaveLength(3)
    expect(core.getByPath(BATTERY_ALERT)).toMatchObject({ priority: 'alarm', condition: true })
  })

  it('an alert with steps is raised with the reached step limit and escalated on the same path', () => {
    const { at, run, sent, core } = setup([steppedBattery])
    at(0, VOLTAGE, 12)
    run(1, 5)
    expect(sent[0]?.[1]).toMatchObject({ priority: 'warning', data: { limit: 12.2 } })
    core.acknowledge(BATTERY_ALERT)
    at(6, VOLTAGE, 11.7)
    run(7, 11)
    expect(sent.map(([path, value]) => [path, value?.priority])).toEqual([
      [BATTERY_ALERT, 'warning'],
      [BATTERY_ALERT, 'alarm']
    ])
    expect(core.getByPath(BATTERY_ALERT)).toMatchObject({
      priority: 'alarm',
      state: 'unacknowledged',
      data: { rule: 'house-battery-low', limit: 11.8, raisedAt: sent[0]?.[1]?.data?.raisedAt }
    })
  })

  it("an edit to a reached step's limit reaches the alert's data", () => {
    const { at, run, sent, runner, core } = setup([steppedBattery])
    at(0, VOLTAGE, 11.7)
    run(1, 5)
    runner.update(
      valid({
        ...steppedBattery,
        detector: {
          ...steppedBattery.detector,
          steps: [
            { limit: 12.2, priority: 'warning' },
            { limit: 11.9, priority: 'alarm' }
          ]
        }
      })
    )
    run(6, 5 + HEARTBEAT_S)
    expect(sent.at(-1)?.[1]?.data).toMatchObject({ rule: 'house-battery-low', limit: 11.9 })
    expect(core.getByPath(BATTERY_ALERT)?.data).toMatchObject({ limit: 11.9 })
  })

  describe('an edit to an alert that has climbed', () => {
    function climbed() {
      const setupResult = setup([steppedBattery])
      setupResult.at(0, VOLTAGE, 11.7)
      setupResult.run(1, 5)
      return setupResult
    }
    const edited = (steps: { limit: number; priority: string }[]) =>
      valid({ ...steppedBattery, detector: { ...steppedBattery.detector, steps } })

    it('keeps the reached priority when the reached step is removed', () => {
      const { run, sent, runner } = climbed()
      runner.update(edited([{ limit: 12.2, priority: 'warning' }]))
      run(6, 5 + HEARTBEAT_S)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 0,
        priority: 'alarm'
      })
      expect(sent.at(-1)?.[1]?.priority).toBe('alarm')
    })

    it('keeps a priority an edit raised once a later edit lowers it again', () => {
      const { at, run, sent, runner, core } = setup([steppedBattery])
      at(0, VOLTAGE, 12)
      run(1, 5)
      runner.update(
        edited([
          { limit: 12.2, priority: 'alarm' },
          { limit: 11.8, priority: 'emergency' }
        ])
      )
      run(6, 5 + HEARTBEAT_S)
      expect(sent.at(-1)?.[1]?.priority).toBe('alarm')
      runner.update(steppedBattery)
      run(6 + HEARTBEAT_S, 5 + 2 * HEARTBEAT_S)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 0,
        priority: 'alarm'
      })
      expect(sent.at(-1)?.[1]?.priority).toBe('alarm')
      expect(core.getByPath(BATTERY_ALERT)?.priority).toBe('alarm')
    })

    it('keeps the limit core holds when a step is inserted ahead of the reached one', () => {
      const { at, run, sent, runner, core } = climbed()
      // Above the alarm step, so the inserted step does not climb back to it.
      at(6, VOLTAGE, 11.9)
      runner.update(
        edited([
          { limit: 12.4, priority: 'caution' },
          { limit: 12.2, priority: 'warning' },
          { limit: 11.8, priority: 'alarm' }
        ])
      )
      run(7, 7 + 2 * HEARTBEAT_S)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 1,
        priority: 'alarm'
      })
      expect(sent.every(([, value]) => value?.data?.limit !== 12.2)).toBe(true)
      expect(core.getByPath(BATTERY_ALERT)?.data).toMatchObject({ limit: 11.8 })
    })

    it("keeps the reached priority when the reached step's priority is lowered", () => {
      const { run, sent, runner } = climbed()
      runner.update(
        edited([
          { limit: 12.2, priority: 'caution' },
          { limit: 11.8, priority: 'warning' }
        ])
      )
      run(6, 5 + HEARTBEAT_S)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 1,
        priority: 'alarm'
      })
      expect(sent.at(-1)?.[1]?.priority).toBe('alarm')
    })
  })

  it('an adopted alert that climbs keeps the data core stored, with the reached limit', () => {
    const core = new FakeAlertsCore()
    const stored = { rule: 'house-battery-low', name: 'House battery low', limit: 12.2 }
    core.ingest(PLUGIN, BATTERY_ALERT, {
      priority: 'warning',
      message: 'House battery voltage is low',
      latching: false,
      data: stored
    })
    const { at, run, sent } = setup([steppedBattery], { core })
    at(0, VOLTAGE, 11.7)
    run(1, 5)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'alarm', data: { ...stored, limit: 11.8 } })
    expect(core.getByPath(BATTERY_ALERT)).toMatchObject({
      priority: 'alarm',
      data: { ...stored, limit: 11.8 }
    })
  })

  describe('an adopted alert core holds above the first step', () => {
    // What the warning's raise stored; core now holds the alert at a higher
    // priority while the value has not moved.
    const stored = { rule: 'house-battery-low', name: 'House battery low', limit: 12.2 }

    function adoptedAt(priority: 'caution' | 'alarm' | 'emergency') {
      const core = new FakeAlertsCore()
      core.ingest(PLUGIN, BATTERY_ALERT, {
        priority,
        message: 'House battery voltage is low',
        latching: false,
        data: stored
      })
      core.acknowledge(BATTERY_ALERT)
      return setup([steppedBattery], { core })
    }

    it("stays at the first step at core's priority, keeps core's data and heartbeats without re-alerting", () => {
      const { at, run, sent, runner, core } = adoptedAt('alarm')
      const alertings = core.alertings
      at(0, VOLTAGE, 12)
      run(1, 2 * HEARTBEAT_S)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        condition: 'alerting',
        step: 0,
        priority: 'alarm'
      })
      expect(sent.length).toBeGreaterThan(1)
      expect(sent.every(([, value]) => value?.priority === 'alarm')).toBe(true)
      expect(sent.every(([, value]) => value?.data === undefined)).toBe(true)
      expect(core.getByPath(BATTERY_ALERT)).toMatchObject({
        priority: 'alarm',
        state: 'acknowledged',
        data: stored
      })
      expect(core.alertings).toBe(alertings)
    })

    it("climbs once a further step's own detector holds, and only then names its limit", () => {
      const { at, run, sent, runner, core } = adoptedAt('alarm')
      at(0, VOLTAGE, 12)
      run(1, 5)
      at(6, VOLTAGE, 11.7)
      run(7, 11)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 1,
        priority: 'alarm',
        limit: 11.8
      })
      expect(sent.at(-1)?.[1]).toMatchObject({
        priority: 'alarm',
        data: { ...stored, limit: 11.8 }
      })
      expect(core.getByPath(BATTERY_ALERT)?.data).toEqual({ ...stored, limit: 11.8 })
    })

    it('an edit applied in place leaves the limit core holds', () => {
      const { at, run, runner, core } = adoptedAt('alarm')
      at(0, VOLTAGE, 12)
      runner.update(
        valid({
          ...steppedBattery,
          detector: {
            ...steppedBattery.detector,
            steps: [
              { limit: 12.3, priority: 'warning' },
              { limit: 11.8, priority: 'alarm' }
            ]
          }
        })
      )
      run(1, 2 * HEARTBEAT_S)
      expect(core.getByPath(BATTERY_ALERT)?.data).toEqual(stored)
    })

    it('stays at the first step when core holds a priority beyond every step', () => {
      const { at, sent, runner } = adoptedAt('emergency')
      at(0, VOLTAGE, 12)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 0,
        priority: 'emergency'
      })
      expect(sent.at(-1)?.[1]?.priority).toBe('emergency')
    })

    it("heartbeats at the first step's priority when core holds less than it", () => {
      const { at, sent, runner } = adoptedAt('caution')
      at(0, VOLTAGE, 12)
      expect(runner.state('house-battery-low')?.instances[0]).toMatchObject({
        step: 0,
        priority: 'warning'
      })
      expect(sent.at(-1)?.[1]?.priority).toBe('warning')
    })
  })

  it('a latching count sends a latching raise at each step it climbs to', () => {
    const cycling = valid({
      ...latchingPump,
      detector: {
        ...latchingPump.detector,
        window: 3600,
        steps: [
          { limit: 1, priority: 'warning' },
          { limit: 3, priority: 'alarm' }
        ]
      }
    })
    const { at, sent, core } = setup([cycling])
    pumpStarts(at, 0)
    expect(sent.map(([, value]) => [value?.priority, value?.latching])).toEqual([['warning', true]])
    pumpStarts(at, 10)
    expect(sent.map(([, value]) => [value?.priority, value?.latching])).toEqual([
      ['warning', true],
      ['alarm', true]
    ])
    expect(core.getByPath(PUMP_ALERT)).toMatchObject({
      priority: 'alarm',
      state: 'unacknowledged'
    })
  })

  it("an edit to an active zone-limit rule keeps the level's priority", () => {
    const { at, run, sent, runner } = setup([batteryLow], { meta: { [VOLTAGE]: batteryZones } })
    at(0, VOLTAGE, 11.3)
    run(1, 5)
    runner.update({ ...batteryLow, message: 'Charge the battery' })
    run(6, 5 + HEARTBEAT_S)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'alarm', message: 'Charge the battery' })
  })

  it("an adopted zone-limit alert is heartbeated at core's priority before its zones are readable", () => {
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
        { priority: 'alarm', message: 'House battery voltage is low', latching: false }
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
    expect(runner.state('oil-pressure-low')?.instances[0]).toMatchObject({
      condition: 'alerting',
      awaitingInput: true
    })
  })

  it('an absence alert raised while its input has never been seen keeps heartbeating', () => {
    const watch = valid({
      name: 'Watch not acknowledged',
      slug: 'watch-not-acknowledged',
      message: 'No watch acknowledgement received',
      signal: { path: 'navigation.watch.acknowledged' },
      detector: {
        type: 'absence',
        event: { op: 'changes' },
        steps: [{ within: 900, priority: 'alarm' }]
      }
    })
    const { run, sent, runner } = setup([watch])
    run(0, 900 + 2 * HEARTBEAT_S)
    expect(sent).toHaveLength(3)
    expect(runner.state('watch-not-acknowledged')?.instances[0]).toMatchObject({
      condition: 'alerting',
      awaitingInput: false
    })
  })

  it('an adopted absence alert keeps heartbeating while its input stays silent', () => {
    const WATCH_ALERT = 'navigation.watch.acknowledgedMissing'
    const watch = valid({
      name: 'Watch not acknowledged',
      slug: 'watch-not-acknowledged',
      message: 'No watch acknowledgement received',
      signal: { path: 'navigation.watch.acknowledged' },
      detector: {
        type: 'absence',
        event: { op: 'changes' },
        steps: [{ within: 900, priority: 'alarm' }]
      }
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
      signal: { path: DEPTH },
      detector: { type: 'match', op: 'timedOut', steps: [{ priority: 'warning' }], duration: 30 }
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
    expect(runner.state('bilge-pump-cycling')?.instances[0]).toMatchObject({
      condition: 'normal'
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
    expect(runner.state('oil-pressure-low')).toBeDefined()
  })

  it('restores accumulator totals per rule and reports them for checkpoints', () => {
    const hours = valid({
      name: 'Engine hours',
      slug: 'engine-hours',
      message: 'Engine service due',
      signal: { path: 'propulsion.main.revolutions' },
      detector: {
        type: 'accumulator',
        measure: 'time',
        steps: [{ limit: 100, priority: 'caution' }]
      }
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
        signal: { path: 'propulsion.main.revolutions' },
        detector: {
          type: 'accumulator',
          measure: 'time',
          steps: [{ limit: 100, priority: 'caution' }]
        }
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
      signal: { path: 'tanks.fuel.*.currentLevel' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 0.1, priority: 'warning' }]
      }
    })
    const { at, sent, runner } = setup([rule])
    at(0, `tanks.fuel.${'x'.repeat(260)}.currentLevel`, 0.05)
    expect(sent).toEqual([])
    expect(runner.state('tank-low')).toMatchObject({
      condition: 'problem',
      reason: 'alertPathInvalid',
      errors: []
    })
    expect(runner.state('tank-low')?.instances[0]).toMatchObject({
      condition: 'problem',
      reason: 'alertPathInvalid'
    })
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
    const state = runner.state('coolant-high')
    expect(state).toMatchObject({
      ruleState: 'enabled',
      condition: 'alerting',
      reason: 'alertActive',
      instance: { name: 'port' },
      priority: 'alarm',
      step: 0,
      errors: [],
      issues: []
    })
    const byName = new Map(state?.instances.map((i) => [i.instance?.name, i]))
    expect(byName.get('port')).toMatchObject({
      condition: 'alerting',
      reason: 'alertActive',
      value: 370,
      limit: 368,
      gates: [{ path: 'propulsion.port.revolutions', value: 30, holds: true, input: 'value' }],
      awaitingInput: false
    })
    expect(byName.get('starboard')).toMatchObject({
      condition: 'normal',
      reason: 'outsideGate',
      value: 371,
      limit: 368,
      gates: [{ path: 'propulsion.starboard.revolutions', value: 0, holds: false, input: 'value' }]
    })
  })

  type Step = (s: ReturnType<typeof setup>) => void
  it.each<[string, string, Rule, Step]>([
    [
      'normal',
      'withinLimits',
      oil,
      ({ at }) => {
        at(0, OIL, 300000)
      }
    ],
    [
      'noData',
      'neverReported',
      oil,
      ({ at }) => {
        at(2)
      }
    ],
    [
      'noData',
      'inputUnavailable',
      oil,
      ({ at }) => {
        at(0, OIL, null)
      }
    ],
    [
      'normal',
      'outsideGate',
      gatedOil,
      ({ at }) => {
        at(0, RPM, 0)
        at(0, OIL, 0)
      }
    ],
    [
      'alerting',
      'alertActive',
      oil,
      ({ at, run }) => {
        at(0, OIL, 0)
        run(1, 5)
      }
    ]
  ])('reports %s with the reason %s', (condition, reason, rule, step) => {
    const s = setup([rule])
    step(s)
    expect(s.runner.state(OIL_ID)).toMatchObject({ ruleState: 'enabled', condition, reason })
  })

  it('reports a rule waiting out its duration as normal, without the timer', () => {
    const { at, runner } = setup([oil])
    at(0, OIL, 0)
    at(2)
    expect(runner.state(OIL_ID)).toMatchObject({ condition: 'normal', reason: 'withinLimits' })
    expect(runner.state(OIL_ID)?.instances[0]?.progress).toBeUndefined()
  })

  it('reports a missing zone as a problem with its facts', () => {
    const { at, runner } = setup([batteryLow], {
      meta: { [VOLTAGE]: { zones: [{ upper: 11.5, state: 'alarm' }] } }
    })
    at(0, VOLTAGE, 12.6)
    expect(runner.state('house-battery-low')).toMatchObject({
      condition: 'problem',
      reason: 'missingZone',
      level: 'warn'
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
    expect(runner.state('house-battery-low')).toMatchObject({
      condition: 'problem',
      reason: 'evaluationError',
      errors: ['evaluation failed: meta unreadable']
    })
    broken = false
    runner.update(batteryLow)
    expect(runner.state('house-battery-low')).toMatchObject({ condition: 'normal', errors: [] })
  })

  it('a rule that throws at start is a problem while the others run, until it is edited', () => {
    let broken = true
    const meta = {
      get [VOLTAGE](): PathMeta {
        if (broken) throw new Error('meta unreadable')
        return batteryZones
      }
    }
    const { at, run, runner, sent } = setup([batteryLow, oil], { meta })
    expect(runner.state('house-battery-low')).toMatchObject({
      condition: 'problem',
      reason: 'evaluationError',
      errors: ['failed to start: meta unreadable']
    })
    at(0, OIL, 0)
    at(0, VOLTAGE, 11.8)
    run(1, 6)
    expect(sent.map(([path]) => path)).toEqual([OIL_ALERT])

    broken = false
    runner.update(batteryLow)
    expect(runner.state('house-battery-low')).toMatchObject({ errors: [] })
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
      signal: { path: RPM },
      detector: {
        type: 'accumulator',
        measure: 'time',
        steps: [{ limit: 100, priority: 'caution' }]
      }
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
      expect(runner.state(HOURS_ID)?.condition).toBe('problem')
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
        detector: {
          type: 'accumulator',
          measure: 'integral',
          steps: [{ limit: 100, priority: 'caution' }]
        }
      })
      runner.update(integral)
      expect(runner.accumulators().get(HOURS_ID)?.totals.get('') ?? 0).toBe(0)
    })
  })

  it('reports a gate whose input went unavailable while it keeps holding', () => {
    const { at, runner } = setup([gatedOil])
    at(0, RPM, 30)
    at(0, OIL, 300000)
    at(10)
    at(11, RPM, null)
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'normal',
      reason: 'withinLimits',
      gates: [{ holds: true, input: 'unavailable' }]
    })
  })

  it('reports an alert timing its clear duration as alerting, without the timer', () => {
    const { at, run, runner } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    at(6, OIL, 200000)
    at(8)
    expect(runner.state(OIL_ID)).toMatchObject({ condition: 'alerting', value: 200000 })
    expect(runner.state(OIL_ID)?.progress).toBeUndefined()
  })

  it('reports awaiting input for an active alert whose input went unavailable', () => {
    const { at, run, runner } = setup([oil])
    at(0, OIL, 0)
    run(1, 5)
    at(6, OIL, null)
    expect(runner.state(OIL_ID)).toMatchObject({ condition: 'alerting', awaitingInput: true })
  })

  it('reports when an unavailable input last had a value', () => {
    const { at, runner } = setup([oil], { wall: true })
    at(10, OIL, 300000)
    at(30, OIL, null)
    at(90)
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'noData',
      reason: 'inputUnavailable',
      lastSeen: '2026-09-29T12:00:10.000Z'
    })
  })

  it('moves the time of the last change only when the condition changes', () => {
    const { at, run, runner } = setup([oil], { wall: true })
    at(0, OIL, 300000)
    run(1, 10)
    // A sample changes the state between ticks; the next tick observes it.
    expect(runner.state(OIL_ID)?.changedAt).toBe('2026-09-29T12:00:01.000Z')
    at(20, OIL, 0)
    run(21, 30)
    // Timed at the tick it became alerting, though nobody asked until later.
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'alerting',
      changedAt: '2026-09-29T12:00:25.000Z'
    })
    at(31, OIL, 50000)
    run(32, 40)
    expect(runner.state(OIL_ID)?.changedAt).toBe('2026-09-29T12:00:25.000Z')
  })

  it('times a disable as a change, and keeps that time while the condition stays present', () => {
    const disabled = new Set<string>()
    const { at, run, runner } = setup([gatedOil], {
      wall: true,
      disabled: (id) => disabled.has(id)
    })
    at(0, RPM, 30)
    at(0, OIL, 0)
    run(1, 20)
    disabled.add(OIL_ID)
    runner.refresh(OIL_ID)
    run(21, 30)
    expect(runner.state(OIL_ID)).toMatchObject({
      ruleState: 'disabled',
      condition: 'present',
      changedAt: '2026-09-29T12:00:21.000Z'
    })
    run(31, 40)
    expect(runner.state(OIL_ID)?.changedAt).toBe('2026-09-29T12:00:21.000Z')
  })

  it('reads a disabled condition held across a gate cycle as normal, timed from the gate closing', () => {
    const { at, run, runner } = setup([gatedOil], { wall: true, disabled: () => true })
    at(0, RPM, 30)
    at(0, OIL, 0)
    run(1, 20)
    expect(runner.state(OIL_ID)).toMatchObject({ condition: 'present' })
    at(21, RPM, 0)
    run(22, 30)
    const closed = runner.state(OIL_ID)
    expect(closed).toMatchObject({ condition: 'normal', reason: 'outsideGate' })
    // Inside the recovery margin, so the restarted detector stays undecided.
    at(31, OIL, 120000)
    at(40, RPM, 30)
    run(41, 60)
    const reopened = runner.state(OIL_ID)
    expect(reopened).toMatchObject({
      condition: 'normal',
      reason: 'withinLimits',
      changedAt: closed?.changedAt
    })
    expect(reopened?.instances).toHaveLength(1)
    expect(reopened?.instances[0]).toMatchObject({ condition: 'normal', reason: 'withinLimits' })
    expect(reopened?.instances[0]).not.toHaveProperty('clearSince')
    expect(reopened?.instances[0]).not.toHaveProperty('clearedAt')
  })

  // Each tick and each read judge the condition; were the two to disagree,
  // the time of the last change would move on every read.
  it.each<
    [
      string,
      () => { runner: RuleRunner; id: string; run: (from: number, to: number) => void },
      object
    ]
  >([
    [
      'noData, never reported',
      () => ({ ...setup([oil], { wall: true }), id: OIL_ID }),
      { condition: 'noData', reason: 'neverReported' }
    ],
    [
      'noData, input unavailable',
      () => {
        const s = setup([oil], { wall: true })
        s.at(0, OIL, 300000)
        s.at(0, OIL, null)
        return { ...s, id: OIL_ID }
      },
      { condition: 'noData', reason: 'inputUnavailable' }
    ],
    [
      'problem, missing zone',
      () => {
        const meta = { [VOLTAGE]: { zones: [{ upper: 11.5, state: 'alarm' as const }] } }
        const s = setup([batteryLow], { wall: true, meta })
        s.at(0, VOLTAGE, 12.5)
        return { ...s, id: 'house-battery-low' }
      },
      { condition: 'problem', reason: 'missingZone' }
    ],
    [
      'problem, alert path invalid',
      () => {
        const s = setup([coolant], { wall: true })
        s.at(0, 'propulsion.__proto__.coolantTemperature', 300)
        return { ...s, id: 'coolant-high' }
      },
      { condition: 'problem', reason: 'alertPathInvalid' }
    ],
    [
      'problem, evaluation error',
      () => {
        const meta = {
          get [VOLTAGE](): PathMeta {
            throw new Error('meta unreadable')
          }
        }
        return { ...setup([batteryLow], { wall: true, meta }), id: 'house-battery-low' }
      },
      { condition: 'problem', reason: 'evaluationError' }
    ],
    [
      'normal, outside the gate',
      () => {
        const s = setup([gatedOil], { wall: true })
        s.at(0, RPM, 0)
        s.at(0, OIL, 300000)
        return { ...s, id: OIL_ID }
      },
      { condition: 'normal', reason: 'outsideGate' }
    ],
    [
      'noData, an adopted alert of a disabled rule',
      () => ({
        ...setup([oil], { wall: true, core: coreWith(OIL_ALERT), disabled: () => true }),
        id: OIL_ID
      }),
      { ruleState: 'disabled', condition: 'noData', reason: 'neverReported' }
    ]
  ])('keeps the time of the last change across reads: %s', (_, scenario, expected) => {
    const { runner, id, run } = scenario()
    run(1, 5)
    const first = runner.state(id)
    expect(first).toMatchObject({ ...expected, changedAt: '2026-09-29T12:00:01.000Z' })
    run(6, 10)
    expect(runner.state(id)).toMatchObject({ ...expected, changedAt: first?.changedAt })
    run(11, 15)
    expect(runner.state(id)?.changedAt).toBe(first?.changedAt)
  })

  it('times an adopted alert from when it was raised, and anything else from plugin start', () => {
    const core = new FakeAlertsCore()
    const raised = (instance: string, raisedAt: unknown) => {
      core.ingest(PLUGIN, `propulsion.${instance}.coolantTemperatureHigh`, {
        priority: 'alarm',
        message: `Coolant high on ${instance}`,
        latching: false,
        data: { rule: 'coolant-high', instance, limit: 368, raisedAt }
      })
    }
    raised('port', '2026-09-28T08:00:00.000Z')
    raised('starboard', '2026-09-27T20:00:00.000Z')
    core.ingest(PLUGIN, OIL_ALERT, {
      priority: 'alarm',
      message: 'Engine oil pressure is low',
      latching: false,
      data: { rule: 'oil-pressure-low', limit: 100000, raisedAt: 'not a time' }
    })
    core.alertings = 0
    const { run, runner } = setup([coolant, oil], { wall: true, core })
    run(1, 5)
    // The rule has alerted since its first instance did.
    expect(runner.state('coolant-high')).toMatchObject({
      condition: 'alerting',
      changedAt: '2026-09-27T20:00:00.000Z'
    })
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'alerting',
      changedAt: '2026-09-29T12:00:01.000Z'
    })
  })

  it('raises at the alert path of a rule added again under its slug with another condition', () => {
    const { at, run, runner, sent } = setup([oil])
    at(0, OIL, 300000)
    run(1, 2)
    runner.remove(OIL_ID)
    runner.update(valid({ ...oil, condition: 'oilPressureLost' }))
    at(3, OIL, 0)
    run(4, 9)
    expect(sent.map(([path]) => path)).toEqual(['propulsion.main.oilPressureLost'])
  })

  it('times a rule removed and added again from its new start', () => {
    const { run, runner } = setup([oil], { wall: true })
    run(1, 5)
    expect(runner.state(OIL_ID)?.changedAt).toBe('2026-09-29T12:00:01.000Z')
    runner.remove(OIL_ID)
    run(6, 19)
    runner.update(oil)
    run(20, 25)
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'noData',
      changedAt: '2026-09-29T12:00:20.000Z'
    })
  })

  it('does not move the time of the last change on a change of reason alone', () => {
    const { at, run, runner } = setup([gatedOil], { wall: true })
    at(0, RPM, 30)
    at(0, OIL, 300000)
    run(1, 20)
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'normal',
      reason: 'withinLimits',
      changedAt: '2026-09-29T12:00:01.000Z'
    })
    at(21, RPM, 0)
    run(22, 30)
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'normal',
      reason: 'outsideGate',
      changedAt: '2026-09-29T12:00:01.000Z'
    })
  })
})

describe('disabled rules', () => {
  const OIL_ID = 'oil-pressure-low'

  it('an adopted alert of a rule disabled before its input reports is no data, then present once it does', () => {
    const disabled = new Set<string>()
    const { at, run, runner } = setup([oil], {
      core: coreWith(OIL_ALERT),
      disabled: (id) => disabled.has(id)
    })
    run(1, 3)
    expect(runner.state(OIL_ID)).toMatchObject({ ruleState: 'enabled', condition: 'alerting' })
    disabled.add(OIL_ID)
    runner.refresh(OIL_ID)
    run(4, 6)
    expect(runner.state(OIL_ID)).toMatchObject({
      ruleState: 'disabled',
      condition: 'noData',
      reason: 'neverReported',
      instances: [{ condition: 'noData', reason: 'neverReported' }]
    })
    at(7, OIL, 0)
    run(8, 9)
    expect(runner.state(OIL_ID)).toMatchObject({
      ruleState: 'disabled',
      condition: 'present',
      reason: 'conditionPresent',
      instances: [{ condition: 'present' }]
    })
  })

  it('a disabled rule clear since the plugin started is clear since that start', () => {
    const { at, run, runner } = setup([oil], { wall: true, disabled: () => true })
    at(0, OIL, 300000)
    run(1, 10)
    expect(runner.state(OIL_ID)).toMatchObject({
      condition: 'normal',
      reason: 'withinLimits',
      clearSince: '2026-09-29T12:00:00.000Z'
    })
  })

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
    const state = runner.state(OIL_ID)
    expect(state).toMatchObject({ ruleState: 'disabled', condition: 'present' })
    expect(state?.instances[0]).toMatchObject({ condition: 'present', reason: 'conditionPresent' })
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
    expect(runner.state('house-battery-low')?.errors).toEqual([
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

describe('message placeholders', () => {
  const HOUSE = 'electrical.batteries.house.voltage'
  const units = { [HOUSE]: { units: 'V' } }
  const bank = valid({
    name: 'Battery low',
    slug: 'battery-low',
    message: '{instance} below {limit} for {duration}: {value}',
    signal: { path: 'electrical.batteries.*.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [
        { limit: 12.2, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ],
      duration: 5
    }
  })
  const BANK_ALERT = 'electrical.batteries.house.voltageLow'
  const messages = (sent: [string, AlertValue | null][]) => sent.map(([, v]) => v?.message)

  function raised() {
    const setupResult = setup([bank], { meta: units })
    setupResult.at(0, HOUSE, 12)
    setupResult.run(1, 5)
    return setupResult
  }

  it('a raise renders the limit, duration, value and instance, and the status carries it', () => {
    const { sent, runner } = raised()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual([
      BANK_ALERT,
      expect.objectContaining({ priority: 'warning', message: 'house below 12.2 V for 5 s: 12 V' })
    ])
    const state = runner.state('battery-low')
    expect(state).toMatchObject({ message: 'house below 12.2 V for 5 s: 12 V' })
    expect(state?.instances[0]).toMatchObject({ message: 'house below 12.2 V for 5 s: 12 V' })
  })

  it("a climb renders the new step's limit at once", () => {
    const { at, run, sent, runner } = raised()
    at(6, HOUSE, 11.7)
    run(7, 11)
    expect(sent.at(-1)?.[1]).toMatchObject({
      priority: 'alarm',
      message: 'house below 11.8 V for 5 s: 11.7 V'
    })
    expect(runner.state('battery-low')?.instances[0]).toMatchObject({
      message: 'house below 11.8 V for 5 s: 11.7 V'
    })
  })

  it("an outside alert's limit follows the value to the other side at the next heartbeat, with no new event", () => {
    const HEEL = 'navigation.attitude.roll'
    const heel = valid({
      name: 'Heel',
      slug: 'heel',
      message: 'Heel {value}, past {limit}',
      signal: { path: HEEL },
      detector: {
        type: 'outside',
        steps: [{ low: -25, high: 25, priority: 'warning' }],
        duration: 5
      }
    })
    const { at, run, sent, runner } = setup([heel], { meta: { [HEEL]: { units: 'deg' } } })
    at(0, HEEL, 27)
    run(1, 5)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject([
      'navigation.attitude.rollOutOfRange',
      { priority: 'warning', message: 'Heel 27 deg, past 25 deg', data: { limit: 25 } }
    ])
    expect(runner.state('heel')?.instances[0]).toMatchObject({ limit: 25, passed: 'high' })
    at(6, HEEL, -27)
    run(7, 5 + HEARTBEAT_S)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.[1]).toMatchObject({
      priority: 'warning',
      message: 'Heel -27 deg, past -25 deg',
      data: { limit: 25 }
    })
    expect(runner.state('heel')?.instances[0]).toMatchObject({ limit: -25, passed: 'low' })
  })

  it.each([
    [24, '-25 deg'],
    [27, '25 deg']
  ])(
    "an adopted outside alert names core's limit until its value is past one (input %s)",
    (value, limit) => {
      const HEEL = 'navigation.attitude.roll'
      const heel = valid({
        name: 'Heel',
        slug: 'heel',
        message: 'Heel {value}, past {limit}',
        signal: { path: HEEL },
        detector: {
          type: 'outside',
          steps: [{ low: -25, high: 25, priority: 'warning' }],
          hysteresis: 2
        }
      })
      const core = new FakeAlertsCore()
      core.ingest(PLUGIN, 'navigation.attitude.rollOutOfRange', {
        priority: 'warning',
        message: 'as raised',
        latching: false,
        data: { rule: 'heel', name: 'Heel', limit: -25 }
      })
      const { sent } = setup([heel], {
        core,
        meta: { [HEEL]: { units: 'deg' } },
        cached: [[HEEL, value]]
      })
      expect(sent.map(([, v]) => v?.message)).toEqual([`Heel ${String(value)} deg, past ${limit}`])
    }
  )

  it('a value change while alerting is sent with the next heartbeat, at the same priority and with the data of the raise', () => {
    const { at, run, sent, runner } = raised()
    at(6, HOUSE, 12.1)
    expect(sent).toHaveLength(1)
    run(7, 5 + HEARTBEAT_S)
    expect(sent).toEqual([
      [BANK_ALERT, expect.objectContaining({ message: 'house below 12.2 V for 5 s: 12 V' })],
      [
        BANK_ALERT,
        {
          ...sent[0]?.[1],
          message: 'house below 12.2 V for 5 s: 12.1 V'
        }
      ]
    ])
    expect(runner.state('battery-low')).toMatchObject({
      message: 'house below 12.2 V for 5 s: 12.1 V'
    })
  })

  it('a burst of value changes is sent with the heartbeat alone', () => {
    const { at, run, sent } = raised()
    for (let i = 0; i < 100; i++) at(5 + (i + 1) * 0.09, HOUSE, 12 + (i % 10) / 100)
    run(15, 5 + 3 * HEARTBEAT_S)
    expect(sent).toHaveLength(4)
  })

  it('a message without placeholders is sent unchanged in every emission', () => {
    const plain = valid({ ...bank, message: 'House bank low' })
    const { at, run, sent } = setup([plain], { meta: units })
    at(0, HOUSE, 12)
    run(1, 5)
    at(6, HOUSE, 12.1)
    run(7, 5 + 2 * HEARTBEAT_S)
    expect(sent).toHaveLength(3)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[2]).toEqual(sent[0])
  })

  it('an edit to the message is sent with the next heartbeat, and the status shows what was sent', () => {
    const { run, sent, runner } = raised()
    runner.update(valid({ ...bank, message: '{value} on {instance}' }))
    expect(sent).toHaveLength(1)
    expect(runner.state('battery-low')).toMatchObject({
      message: 'house below 12.2 V for 5 s: 12 V'
    })
    run(6, 5 + HEARTBEAT_S)
    expect(sent).toHaveLength(2)
    expect(sent.at(-1)?.[1]?.message).toBe('12 V on house')
    expect(runner.state('battery-low')).toMatchObject({ message: '12 V on house' })
  })

  it('renders the threshold of a zone limit', () => {
    const zoned = valid({ ...batteryLow, message: 'below {limit}' })
    const { at, run, sent } = setup([zoned], {
      meta: { [VOLTAGE]: { ...batteryZones, units: 'V' } }
    })
    at(0, VOLTAGE, 11.8)
    run(1, 5)
    expect(messages(sent)).toEqual(['below 12 V'])
  })

  function coreHolding(priority: Priority, data: Record<string, unknown>): FakeAlertsCore {
    const core = new FakeAlertsCore()
    core.ingest(PLUGIN, BANK_ALERT, {
      priority,
      message: 'as raised',
      latching: false,
      data: { rule: 'battery-low', instance: 'house', ...data }
    })
    return core
  }

  it("an adopted alert's one emission at start is a heartbeat without data naming the value its input replayed", () => {
    const core = coreHolding('warning', { limit: 12.2 })
    const { sent } = setup([bank], { core, meta: units, cached: [[HOUSE, 11.9]] })
    expect(sent).toEqual([
      [
        BANK_ALERT,
        { priority: 'warning', latching: false, message: 'house below 12.2 V for 5 s: 11.9 V' }
      ]
    ])
  })

  it.each([11.5, 11.9])(
    'an alert adopted at alarm names the limit it was sent with, not the first step’s (input %s)',
    (value) => {
      const core = coreHolding('alarm', { limit: 11.8 })
      const short = valid({ ...bank, message: 'below {limit}: {value}' })
      const { sent, runner } = setup([short], { core, meta: units, cached: [[HOUSE, value]] })
      expect(sent.map(([, v]) => [v?.priority, v?.message])).toEqual([
        ['alarm', `below 11.8 V: ${String(value)} V`]
      ])
      expect(runner.state('battery-low')).toMatchObject({
        message: `below 11.8 V: ${String(value)} V`
      })
    }
  )

  it('an edit inserting a step ahead of the reached one keeps naming the limit sent', () => {
    const short = valid({ ...bank, message: 'below {limit}' })
    const { at, run, sent, runner } = setup([short], { meta: units })
    at(0, HOUSE, 11.7)
    run(1, 5)
    expect(messages(sent)).toEqual(['below 11.8 V'])
    runner.update(
      valid({
        ...short,
        detector: {
          ...bank.detector,
          steps: [
            { limit: 12.4, priority: 'caution' },
            { limit: 12.2, priority: 'warning' },
            { limit: 11.8, priority: 'alarm' }
          ]
        }
      })
    )
    run(6, 5 + HEARTBEAT_S)
    expect(sent.at(-1)?.[1]).toMatchObject({ priority: 'alarm', message: 'below 11.8 V' })
  })

  it('a stale adopted alert sends nothing at start, and its state shows the message rendered from the replayed value', () => {
    const core = coreHolding('warning', { limit: 12.2 })
    core.markStale(BANK_ALERT)
    const { sent, runner } = setup([bank], {
      core,
      meta: units,
      cached: [[HOUSE, 11.9]]
    })
    expect(sent).toEqual([])
    expect(runner.state('battery-low')?.instances[0]).toMatchObject({
      message: 'house below 12.2 V for 5 s: 11.9 V'
    })
  })

  it('an adopted alert that climbs while its rule starts is sent once, at the step it reached', () => {
    const core = coreHolding('warning', { limit: 12.2 })
    const prompt = valid({
      ...bank,
      message: 'below {limit}',
      detector: { ...bank.detector, duration: undefined }
    })
    const { sent } = setup([prompt], { core, meta: units, cached: [[HOUSE, 11.5]] })
    expect(sent.map(([, v]) => [v?.priority, v?.message])).toEqual([['alarm', 'below 11.8 V']])
  })

  it('a latching alert carries the message of its raise in the status', () => {
    const latching = valid({ ...latchingPump, message: 'Pump started over {limit} times' })
    const { at, sent, runner } = setup([latching])
    pumpStarts(at, 0)
    expect(messages(sent)).toEqual(['Pump started over 1 times'])
    expect(runner.state('bilge-pump-cycling')).toMatchObject({
      condition: 'alerting',
      message: 'Pump started over 1 times'
    })
  })

  describe('a rule whose alert data names no limit, when no step set its priority', () => {
    function adoptedAt(rule: Rule, path: string, cached: [string, Value][]) {
      const core = new FakeAlertsCore()
      core.ingest(PLUGIN, path, {
        priority: 'alarm',
        message: 'as raised',
        latching: false,
        data: { rule: rule.slug }
      })
      return setup([rule], { core, cached })
    }

    it('names the limit of the step at the alert’s index for a count', () => {
      const pumps = valid({
        ...pumpCycling,
        message: 'Pump started over {limit} times',
        detector: {
          ...pumpCycling.detector,
          steps: [
            { limit: 3, priority: 'warning' },
            { limit: 5, priority: 'alarm' }
          ]
        }
      })
      const { sent } = adoptedAt(pumps, PUMP_ALERT, [[PUMP, false]])
      // An adopted alert starts at the first step whatever priority core holds.
      expect(sent.map(([, v]) => [v?.priority, v?.message])).toEqual([
        ['alarm', 'Pump started over 3 times']
      ])
    })

    it('names the window of the step at the alert’s index for an absence', () => {
      const quiet = valid({
        name: 'Pump quiet',
        slug: 'pump-quiet',
        condition: 'quiet',
        message: 'No pump change for {limit}',
        signal: { path: PUMP },
        detector: {
          type: 'absence',
          event: { op: 'changes' },
          steps: [
            { within: 600, priority: 'warning' },
            { within: 1800, priority: 'alarm' }
          ]
        }
      })
      const { sent } = adoptedAt(quiet, 'electrical.switches.bilgePump.quiet', [[PUMP, false]])
      expect(messages(sent)).toEqual(['No pump change for 10 min'])
    })

    it("names the reached step's limit after an edit lowers that step's priority", () => {
      const TEMPERATURE = 'propulsion.main.temperature'
      const rising = valid({
        name: 'Temperature rising',
        slug: 'temperature-rising',
        message: 'Rising faster than {limit}',
        signal: { path: TEMPERATURE },
        detector: {
          type: 'slope',
          direction: 'rising',
          window: 10,
          steps: [
            { limit: 0.05, priority: 'warning' },
            { limit: 0.1, priority: 'alarm' }
          ]
        }
      })
      const { at, sent, runner } = setup([rising], {
        meta: { [TEMPERATURE]: { units: 'K' } }
      })
      for (let t = 0; t <= 15; t++) at(t, TEMPERATURE, 300 + t)
      expect(sent.at(-1)?.[1]).toMatchObject({
        priority: 'alarm',
        message: 'Rising faster than 0.1 K/s'
      })
      runner.update(
        valid({
          ...rising,
          detector: {
            ...rising.detector,
            steps: [
              { limit: 0.05, priority: 'caution' },
              { limit: 0.1, priority: 'warning' }
            ]
          }
        })
      )
      const before = sent.length
      for (let t = 16; t <= 15 + HEARTBEAT_S; t++) {
        at(t, TEMPERATURE, 300 + t)
        at(t)
      }
      expect(sent.length).toBeGreaterThan(before)
      expect(sent.at(-1)?.[1]).toMatchObject({
        priority: 'alarm',
        message: 'Rising faster than 0.1 K/s'
      })
    })
  })
})
