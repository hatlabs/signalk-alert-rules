import { describe, it, expect } from 'vitest'
import type { PathValueState, Value } from '@signalk/server-api'
import {
  RuleEvaluator,
  structuralChanges,
  type Adopted,
  type PathMeta,
  type RuleEvent,
  type TimeoutSettings
} from '../../src/engine/evaluator.js'
import type { Zone } from '../../src/engine/limits.js'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

const TIMED_OUT: PathValueState = { timedOut: true }
const ENFORCED: TimeoutSettings = { enforce: true, useDefaults: true }

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

interface Options {
  meta?: Record<string, PathMeta>
  settings?: TimeoutSettings
  adopted?: Adopted[]
  /** Accumulator totals restored from the store, by instance segment. */
  accumulated?: Map<string, number>
  /** Values already in the server's delta cache when the rule starts. */
  cached?: [string, Value][]
  /** Whether the rule starts disabled. */
  disabled?: boolean
}

type Logged = [number, string, string, string?]

function setup(rule: Rule, options: Options = {}) {
  const sm = new FakeSubscriptionManager()
  const meta = new Map(Object.entries(options.meta ?? {}))
  let now = 0
  const log: Logged[] = []
  const events: RuleEvent[] = []
  let disabled = options.disabled ?? false
  const evaluator = new RuleEvaluator(
    rule,
    {
      subscriptions: sm,
      meta: (path) => meta.get(path),
      timeoutSettings: () => ('settings' in options ? options.settings : ENFORCED),
      clock: () => now
    },
    (e) => {
      events.push(e)
      const key = e.instance?.segment ?? ''
      log.push(e.type === 'clear' ? [now, e.type, key] : [now, e.type, key, e.priority])
    },
    options.adopted,
    options.accumulated,
    () => disabled
  )
  for (const [path, value] of options.cached ?? []) sm.publish(path, 'src', value)
  evaluator.start()
  return {
    evaluator,
    log,
    events,
    meta,
    /** Publishes a value at `t`, or only lets time pass when no path is given. */
    at: (t: number, path?: string, value?: Value, state?: PathValueState, source = 'src') => {
      now = t
      if (path === undefined) evaluator.tick()
      else sm.publish(path, source, value ?? null, state)
    },
    /** Disables or enables the rule at `t`, applied at once as the runner does. */
    setDisabled: (t: number, value: boolean) => {
      now = t
      disabled = value
      evaluator.refresh()
    }
  }
}

const VOLTAGE = 'electrical.batteries.house.voltage'
const batteryZones: Zone[] = [
  { upper: 11.5, state: 'alarm' },
  { lower: 11.5, upper: 12, state: 'warn' }
]
const batteryLow = valid({
  name: 'House battery low',
  slug: 'house-battery-low',
  message: 'House battery voltage is low',
  signal: { path: VOLTAGE },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'zone', level: 'warn' },
    duration: 30
  }
})

const batteryCritical = valid({
  ...batteryLow,
  name: 'House battery critical',
  slug: 'house-battery-critical',
  detector: { ...batteryLow.detector, limit: { kind: 'zone', level: 'alarm' } }
})

describe('zone limits', () => {
  const zoned = { meta: { [VOLTAGE]: { zones: batteryZones } } }
  const escalating = valid({
    ...batteryLow,
    detector: { ...batteryLow.detector, hysteresis: 0.1, clearDuration: 10 }
  })

  it("an adopted alert keeps core's priority at its named level until the value enters a severer one", () => {
    const { at, events, meta, evaluator } = setup(escalating, { adopted: [{ priority: 'alarm' }] })
    at(0)
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { step: 0, priority: 'alarm' } }
    })
    meta.set(VOLTAGE, { zones: batteryZones })
    at(1, VOLTAGE, 11.7)
    expect(events).toEqual([])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { step: 0, level: 'warn', priority: 'alarm' } }
    })
    at(2, VOLTAGE, 11.4)
    at(32)
    expect(events).toEqual([
      { type: 'priority', instance: undefined, priority: 'alarm', limit: 11.5 }
    ])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { step: 1, level: 'alarm' } }
    })
  })

  it('entering warn raises at warning, and entering alarm while active escalates the same alert', () => {
    const { at, log, events, evaluator } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.8)
    at(30)
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'warn', priority: 'warning' } }
    })
    at(40, VOLTAGE, 11.3)
    at(69)
    at(70)
    expect(log).toEqual([
      [30, 'raise', '', 'warning'],
      [70, 'priority', '', 'alarm']
    ])
    expect(events.at(-1)?.instance).toBeUndefined()
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'alarm', priority: 'alarm' } }
    })
  })

  it('falling from alarm back to warn stays at alarm, and the condition ends only when warn clears', () => {
    const { at, log, evaluator } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.3)
    at(30)
    at(40, VOLTAGE, 11.55)
    at(100)
    at(110, VOLTAGE, 11.8)
    at(120)
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'alarm', priority: 'alarm' } }
    })
    at(130, VOLTAGE, 12.05)
    at(200)
    at(210, VOLTAGE, 12.2)
    at(220)
    expect(log).toEqual([
      [30, 'raise', '', 'alarm'],
      [220, 'clear', '']
    ])
    expect(evaluator.status().instances[0]?.judgement.alert).toBeUndefined()
  })

  it('an excursion into alarm shorter than the duration does not escalate', () => {
    const { at, log } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.8)
    at(30)
    at(40, VOLTAGE, 11.3)
    at(69, VOLTAGE, 11.8)
    at(200)
    expect(log).toEqual([[30, 'raise', '', 'warning']])
  })

  it('a path whose zones have no level more severe than the named one is a single-level rule', () => {
    const { at, log, evaluator } = setup(batteryCritical, zoned)
    at(0, VOLTAGE, 11.3)
    at(30)
    at(40, VOLTAGE, 10)
    at(200)
    expect(log).toEqual([[30, 'raise', '', 'alarm']])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'alarm', priority: 'alarm' } }
    })
  })

  it('a fixed-limit rule reports its own priority and no level', () => {
    const { at, evaluator } = setup({ ...oilPressure, gates: undefined })
    at(0, OIL, 0)
    at(5)
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { priority: 'alarm' } }
    })
    expect(evaluator.status().instances[0]?.judgement.alert?.level).toBeUndefined()
  })

  it('an adopted zone-limit alert holds its named level until a more severe one is entered', () => {
    const { at, log, evaluator } = setup(escalating, { ...zoned, adopted: [{}] })
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'warn' } }
    })
    at(0, VOLTAGE, 11.3)
    at(30)
    expect(log).toEqual([[30, 'priority', '', 'alarm']])
  })

  it('a gated alert that escalated re-enters use at its named level and waits out the duration again', () => {
    const rule = valid({
      ...escalating,
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const { at, log } = setup(rule, zoned)
    at(0, RPM, 30)
    at(0, VOLTAGE, 11.3)
    at(30)
    at(40, RPM, 0)
    at(50, VOLTAGE, 11.8)
    at(60, RPM, 30)
    at(90)
    at(100, VOLTAGE, 11.3)
    at(129)
    at(130)
    expect(log).toEqual([
      [30, 'raise', '', 'alarm'],
      [40, 'clear', ''],
      [90, 'raise', '', 'warning'],
      [130, 'priority', '', 'alarm']
    ])
  })

  it('a zone edit that removes the held more severe level reports the named level at the priority reached, and sends nothing', () => {
    const { at, log, meta, evaluator } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.3)
    at(30)
    meta.set(VOLTAGE, { zones: [{ upper: 12, state: 'warn' }] })
    at(31)
    expect(log).toEqual([[30, 'raise', '', 'alarm']])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'warn', priority: 'alarm' } }
    })
  })

  describe('an edit of the named level clears and restarts', () => {
    const graded = {
      meta: {
        [VOLTAGE]: {
          zones: [
            { upper: 11.5, state: 'alarm' },
            { lower: 11.5, upper: 12, state: 'warn' },
            { lower: 12, upper: 12.4, state: 'alert' }
          ]
        }
      }
    }
    const watchAlert = valid({
      ...batteryLow,
      detector: {
        ...batteryLow.detector,
        limit: { kind: 'zone', level: 'alert' },
        hysteresis: 0.1,
        clearDuration: 60
      }
    })
    const raiseToWarn = (rule: Rule): Rule =>
      ({ ...rule, detector: { ...rule.detector, limit: { kind: 'zone', level: 'warn' } } }) as Rule

    it('and a value only in the old level raises nothing at the new one', () => {
      const { at, log, evaluator } = setup(watchAlert, graded)
      at(0, VOLTAGE, 12.2)
      at(30)
      at(40)
      evaluator.update(raiseToWarn(watchAlert))
      for (let t = 41; t <= 200; t++) at(t)
      expect(log).toEqual([
        [30, 'raise', '', 'caution'],
        [40, 'clear', '']
      ])
      expect(evaluator.status().instances[0]).toMatchObject({
        limit: 12,
        judgement: expect.not.objectContaining({ alert: expect.anything() as unknown }) as unknown
      })
    })

    it('and a value in the new level raises at it once the duration has run again', () => {
      const { at, log, evaluator } = setup(watchAlert, graded)
      at(0, VOLTAGE, 11.8)
      at(30)
      at(40)
      evaluator.update(raiseToWarn(watchAlert))
      for (let t = 41; t <= 100; t++) at(t)
      expect(log).toEqual([
        [30, 'raise', '', 'warning'],
        [40, 'clear', ''],
        [70, 'raise', '', 'warning']
      ])
    })
  })

  it('a gate with a zone limit uses only the level it names', () => {
    const rule = valid({
      ...oilPressure,
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'zone', level: 'warn' } }]
    })
    const { at, log } = setup(rule, {
      meta: {
        [RPM]: {
          zones: [
            { lower: 10, upper: 50, state: 'warn' },
            { lower: 50, state: 'alarm' }
          ]
        }
      }
    })
    at(0, RPM, 20)
    at(0, OIL, 0)
    at(5)
    at(6, RPM, 60)
    at(100)
    expect(log).toEqual([[5, 'raise', '', 'alarm']])
  })

  it('a zone edit that removes the level makes the rule inactive and clears it', () => {
    const { at, log, meta, evaluator } = setup(batteryLow, {
      meta: { [VOLTAGE]: { zones: batteryZones } }
    })
    at(0, VOLTAGE, 11.8)
    at(30)
    meta.set(VOLTAGE, { zones: [{ upper: 11.5, state: 'alarm' }] })
    at(31)
    expect(log).toEqual([
      [30, 'raise', '', 'warning'],
      [31, 'clear', '']
    ])
    expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
      reason: 'missingZone',
      level: 'warn'
    })
  })

  it('on a path zoned on both sides, a below rule raises and escalates on the low-side zones only', () => {
    const twoSided: Zone[] = [
      { upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 12, state: 'warn' },
      { lower: 12, upper: 14.4, state: 'normal' },
      { lower: 14.4, upper: 14.8, state: 'warn' },
      { lower: 14.8, upper: 16, state: 'alarm' }
    ]
    const { at, log, evaluator } = setup(escalating, { meta: { [VOLTAGE]: { zones: twoSided } } })
    at(0, VOLTAGE, 13)
    at(100)
    expect(log).toEqual([])
    at(110, VOLTAGE, 11.8)
    at(140)
    at(150, VOLTAGE, 11.3)
    at(180)
    expect(log).toEqual([
      [140, 'raise', '', 'warning'],
      [180, 'priority', '', 'alarm']
    ])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'alarm', priority: 'alarm' } }
    })
  })

  it('a projection against a zone limit alerts at its named level and does not escalate', () => {
    const LEVEL = 'tanks.freshWater.0.currentLevel'
    const rule = valid({
      name: 'Fresh water running out',
      slug: 'fresh-water-running-out',
      message: 'Fresh water tank will be empty soon',
      signal: { path: LEVEL },
      detector: {
        type: 'projection',
        direction: 'falling',
        limit: { kind: 'zone', level: 'alert' },
        window: 600,
        horizon: 3600
      }
    })
    const zones: Zone[] = [
      { upper: 0.02, state: 'emergency' },
      { lower: 0.02, upper: 0.05, state: 'alarm' },
      { lower: 0.05, upper: 0.1, state: 'warn' },
      { lower: 0.1, upper: 0.2, state: 'alert' }
    ]
    const { at, log, evaluator } = setup(rule, { meta: { [LEVEL]: { zones } } })
    for (let t = 0; t <= 2400; t += 10) at(t, LEVEL, 0.3 - t / 6000)
    expect(log).toEqual([[600, 'raise', '', 'caution']])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { level: 'alert', priority: 'caution' } }
    })
  })

  it('a projection with typed steps raises at the furthest step the trend reaches', () => {
    const LEVEL = 'tanks.freshWater.0.currentLevel'
    const rule = valid({
      name: 'Fresh water running out',
      slug: 'fresh-water-running-out',
      message: 'Fresh water tank will be empty soon',
      signal: { path: LEVEL },
      detector: {
        type: 'projection',
        direction: 'falling',
        steps: [
          { limit: 0.2, priority: 'caution' },
          { limit: 0.1, priority: 'alarm' }
        ],
        window: 600,
        horizon: 3600
      }
    })
    const { at, log, evaluator } = setup(rule)
    for (let t = 0; t <= 1200; t += 10) at(t, LEVEL, 0.3 - t / 6000)
    expect(log).toEqual([[600, 'raise', '', 'alarm']])
    expect(evaluator.status().instances[0]).toMatchObject({
      limit: 0.1,
      judgement: { alert: { step: 1 } }
    })
  })
})

describe('escalation steps', () => {
  const voltageLow = valid({
    name: 'House voltage low',
    slug: 'house-voltage-low',
    message: 'House voltage is low',
    signal: { path: VOLTAGE },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [
        { limit: 12.2, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ],
      duration: 30,
      hysteresis: 0.1,
      clearDuration: 10
    }
  })

  it("an adopted alert stays at the first step at core's priority until a further step holds", () => {
    const { at, events, evaluator } = setup(voltageLow, { adopted: [{ priority: 'alarm' }] })
    at(0, VOLTAGE, 12)
    at(60)
    expect(events).toEqual([])
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { step: 0, priority: 'alarm' } }
    })
    expect(evaluator.revisions()).toEqual([{ instance: undefined, priority: 'alarm' }])
    at(70, VOLTAGE, 11.7)
    at(100)
    expect(events).toEqual([
      { type: 'priority', instance: undefined, priority: 'alarm', limit: 11.8 }
    ])
    expect(evaluator.status().instances[0]).toMatchObject({
      limit: 11.8,
      judgement: { alert: { step: 1 } }
    })
  })

  it('raises at the first step, escalates at the second, keeps alarm between them and clears past the first', () => {
    const { at, log, evaluator } = setup(voltageLow)
    at(0, VOLTAGE, 12.6)
    at(10, VOLTAGE, 12)
    at(40)
    expect(evaluator.status().instances[0]).toMatchObject({
      limit: 12.2,
      judgement: { alert: { step: 0, priority: 'warning' } }
    })
    at(50, VOLTAGE, 11.7)
    at(80)
    expect(evaluator.status().instances[0]).toMatchObject({
      limit: 11.8,
      judgement: { alert: { step: 1, priority: 'alarm' } }
    })
    at(90, VOLTAGE, 12)
    at(200)
    expect(evaluator.status().instances[0]).toMatchObject({
      judgement: { alert: { step: 1, priority: 'alarm' } }
    })
    at(210, VOLTAGE, 12.25)
    at(300)
    at(310, VOLTAGE, 12.4)
    at(320)
    expect(log).toEqual([
      [40, 'raise', '', 'warning'],
      [80, 'priority', '', 'alarm'],
      [320, 'clear', '']
    ])
    expect(evaluator.status().instances[0]?.judgement.alert?.step).toBeUndefined()
  })

  it('a dip past the second step shorter than the duration does not escalate', () => {
    const { at, log } = setup(voltageLow)
    at(0, VOLTAGE, 12)
    at(30)
    at(40, VOLTAGE, 11.7)
    at(69, VOLTAGE, 12)
    at(200)
    expect(log).toEqual([[30, 'raise', '', 'warning']])
  })

  it('a value past both steps at once raises at the second, with its limit', () => {
    const { at, log, events } = setup(voltageLow)
    at(0, VOLTAGE, 12.6)
    at(10, VOLTAGE, 11.5)
    at(40)
    expect(log).toEqual([[40, 'raise', '', 'alarm']])
    expect(events[0]).toMatchObject({ type: 'raise', limit: 11.8 })
  })

  it('an adopted alert holds the first step until a further one has been reached', () => {
    const { at, log, evaluator } = setup(voltageLow, { adopted: [{}] })
    expect(evaluator.status().instances[0]).toMatchObject({ judgement: { alert: { step: 0 } } })
    at(0, VOLTAGE, 11.5)
    at(30)
    expect(log).toEqual([[30, 'priority', '', 'alarm']])
  })

  it('a latching count raises again at the step it climbs to', () => {
    const PUMP = 'electrical.switches.bilgePump.state'
    const rule = valid({
      name: 'Bilge pump cycling',
      slug: 'bilge-pump-cycling',
      message: 'Bilge pump is cycling',
      latching: true,
      signal: { path: PUMP },
      detector: {
        type: 'count',
        event: { op: 'changesTo', value: true },
        window: 86400,
        steps: [
          { limit: 2, priority: 'warning' },
          { limit: 5, priority: 'alarm' }
        ]
      }
    })
    const { at, log } = setup(rule)
    at(0, PUMP, false)
    for (let start = 1; start <= 6; start++) {
      at(start * 100, PUMP, true)
      at(start * 100 + 50, PUMP, false)
    }
    expect(log).toEqual([
      [300, 'raise', '', 'warning'],
      [600, 'raise', '', 'alarm']
    ])
  })

  describe('a match', () => {
    const STATE = 'electrical.inverters.main.state'
    const inverter = (op: string) =>
      valid({
        name: 'Inverter fault',
        slug: 'inverter-fault',
        message: 'Inverter fault',
        signal: { path: STATE },
        detector: {
          type: 'match',
          op,
          steps: [
            { value: 'fault', priority: 'warning' },
            { value: 'critical', priority: 'alarm' }
          ]
        }
      })

    it('escalates on the second value, stays there on the first and clears on neither', () => {
      const { at, log, evaluator } = setup(inverter('equals'))
      at(0, STATE, 'ok')
      at(10, STATE, 'fault')
      at(20, STATE, 'critical')
      at(30, STATE, 'fault')
      expect(evaluator.status().instances[0]).toMatchObject({
        judgement: { alert: { step: 1, priority: 'alarm' } }
      })
      at(40, STATE, 'ok')
      expect(log).toEqual([
        [10, 'raise', '', 'warning'],
        [20, 'priority', '', 'alarm'],
        [40, 'clear', '']
      ])
    })

    it('raises a change to each value at its step', () => {
      const { at, log } = setup(inverter('changesTo'))
      at(0, STATE, 'ok')
      at(10, STATE, 'fault')
      at(20, STATE, 'critical')
      expect(log).toEqual([
        [10, 'raise', '', 'warning'],
        [10, 'clear', ''],
        [20, 'raise', '', 'alarm'],
        [20, 'clear', '']
      ])
    })
  })

  it('an absence escalates at the longer window and clears at the event', () => {
    const HEARTBEAT = 'notifications.watch.acknowledged'
    const rule = valid({
      name: 'Watch not acknowledged',
      slug: 'watch-not-acknowledged',
      message: 'Watch not acknowledged',
      signal: { path: HEARTBEAT },
      condition: 'notAcknowledged',
      detector: {
        type: 'absence',
        event: { op: 'changes' },
        steps: [
          { within: 600, priority: 'warning' },
          { within: 1800, priority: 'alarm' }
        ]
      }
    })
    const { at, log } = setup(rule)
    at(0, HEARTBEAT, 1)
    at(600)
    at(1800)
    at(1900, HEARTBEAT, 2)
    expect(log).toEqual([
      [600, 'raise', '', 'warning'],
      [1800, 'priority', '', 'alarm'],
      [1900, 'clear', '']
    ])
  })

  describe('edits', () => {
    const withSteps = (...steps: [number, string][]) =>
      valid({
        ...voltageLow,
        detector: {
          ...voltageLow.detector,
          steps: steps.map(([limit, priority]) => ({ limit, priority }))
        }
      })

    it('adds a step in place; the alert climbs to it once it has held for the duration', () => {
      const { at, log, evaluator } = setup(withSteps([12.2, 'warning']))
      at(0, VOLTAGE, 11.7)
      at(30)
      evaluator.update(withSteps([12.2, 'warning'], [11.8, 'alarm']))
      at(59)
      at(60)
      expect(log).toEqual([
        [30, 'raise', '', 'warning'],
        [60, 'priority', '', 'alarm']
      ])
    })

    it('re-evaluates step limits, priorities and added or removed steps in place', () => {
      expect(
        structuralChanges(
          voltageLow,
          withSteps([12.3, 'caution'], [11.8, 'alarm'], [11, 'emergency'])
        )
      ).toEqual([])
      expect(structuralChanges(voltageLow, withSteps([12.2, 'warning']))).toEqual([])
    })

    it('restarts for a switch between steps and a zone limit', () => {
      const zoned = valid({
        ...voltageLow,
        detector: { type: 'sustained', direction: 'below', limit: { kind: 'zone', level: 'warn' } }
      })
      expect(structuralChanges(voltageLow, zoned)).toEqual(['detector.limit'])
      expect(structuralChanges(zoned, voltageLow)).toEqual(['detector.limit'])
    })

    it("restarts for a match's step values, not for their priorities", () => {
      const match = (...steps: [string, string][]) =>
        valid({
          name: 'Inverter fault',
          slug: 'inverter-fault',
          message: 'Inverter fault',
          signal: { path: 'electrical.inverters.main.state' },
          detector: {
            type: 'match',
            op: 'equals',
            steps: steps.map(([value, priority]) => ({ value, priority }))
          }
        })
      const current = match(['fault', 'warning'], ['critical', 'alarm'])
      expect(
        structuralChanges(current, match(['fault', 'caution'], ['critical', 'emergency']))
      ).toEqual([])
      expect(structuralChanges(current, match(['fault', 'warning']))).toEqual([
        'detector.steps.value'
      ])
      expect(
        structuralChanges(current, match(['error', 'warning'], ['critical', 'alarm']))
      ).toEqual(['detector.steps.value'])
    })

    it('removes the reached step in place; the alert reports the furthest step left at the priority reached, and sends nothing', () => {
      const { at, log, evaluator } = setup(voltageLow)
      at(0, VOLTAGE, 11.7)
      at(30)
      evaluator.update(withSteps([12.2, 'warning']))
      at(40)
      expect(log).toEqual([[30, 'raise', '', 'alarm']])
      expect(evaluator.status().instances[0]).toMatchObject({
        judgement: { alert: { step: 0, priority: 'alarm' } }
      })
    })
  })
})

const HEEL = 'navigation.attitude.roll'
const heel = valid({
  name: 'Heel',
  slug: 'heel',
  message: 'Heel past {limit}',
  signal: { path: HEEL },
  detector: {
    type: 'outside',
    steps: [
      { low: -25, high: 25, priority: 'warning' },
      { low: -35, high: 35, priority: 'alarm' }
    ],
    duration: 10,
    hysteresis: 2,
    clearDuration: 5
  }
})

describe('outside rules', () => {
  it('raises above the high limit at the step priority with the high limit', () => {
    const { at, events } = setup(heel)
    at(0, HEEL, 27)
    at(9)
    expect(events).toEqual([])
    at(10)
    expect(events).toEqual([
      { type: 'raise', instance: undefined, priority: 'warning', rule: heel, value: 27, limit: 25 }
    ])
  })

  it('raises below the low limit with the low limit', () => {
    const { at, events, evaluator } = setup(heel)
    at(0, HEEL, -27)
    at(10)
    expect(events).toMatchObject([{ type: 'raise', priority: 'warning', limit: -25 }])
    expect(evaluator.status().instances[0]).toMatchObject({ limit: -25, passed: 'low' })
  })

  it('escalates to the wider step and keeps its priority when the value falls back', () => {
    const { at, events, log } = setup(heel)
    at(0, HEEL, 30)
    at(10)
    at(11, HEEL, 37)
    at(21)
    at(22, HEEL, 30)
    at(100)
    expect(log).toEqual([
      [10, 'raise', '', 'warning'],
      [21, 'priority', '', 'alarm']
    ])
    expect(events[1]).toEqual({
      type: 'priority',
      instance: undefined,
      priority: 'alarm',
      limit: 35
    })
  })

  it('clears only inside the range narrowed by the hysteresis, after the clear duration', () => {
    const { at, log } = setup(heel)
    at(0, HEEL, 27)
    at(10)
    at(11, HEEL, 24)
    at(100)
    at(101, HEEL, 22.9)
    at(105)
    expect(log).toEqual([[10, 'raise', '', 'warning']])
    at(106)
    expect(log.at(-1)).toEqual([106, 'clear', ''])
  })

  it('a jump from one side to the other within the duration raises on time, with the side reached', () => {
    const { at, events } = setup(heel)
    at(0, HEEL, -27)
    at(5, HEEL, 27)
    at(10)
    expect(events).toMatchObject([{ type: 'raise', value: 27, limit: 25 }])
  })

  it('unavailable input pauses the duration', () => {
    const { at, log } = setup(heel)
    at(0, HEEL, 27)
    at(4, HEEL, null)
    at(100)
    at(100, HEEL, 27)
    at(105)
    expect(log).toEqual([])
    at(106)
    expect(log).toEqual([[106, 'raise', '', 'warning']])
  })

  it('an edit that narrows the range checks the last value against it', () => {
    const { at, events, evaluator } = setup(heel)
    at(0, HEEL, 20)
    at(50)
    const narrowed = valid({
      ...heel,
      detector: { ...heel.detector, steps: [{ low: -15, high: 15, priority: 'warning' }] }
    })
    expect(structuralChanges(heel, narrowed)).toEqual([])
    evaluator.update(narrowed)
    at(59)
    expect(events).toEqual([])
    at(60)
    expect(events).toMatchObject([{ type: 'raise', value: 20, limit: 15 }])
  })

  it('a switch to or from outside restarts the rule', () => {
    const above = valid({
      ...heel,
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 25, priority: 'warning' }]
      }
    })
    expect(structuralChanges(above, heel)).toContain('detector.type')
    expect(structuralChanges(heel, above)).toContain('detector.type')
  })

  describe('the limit passed', () => {
    it('follows a move to the other side while alerting, without an event', () => {
      const { at, events, evaluator } = setup(heel)
      at(0, HEEL, 27)
      at(10)
      expect(evaluator.reached('')).toMatchObject({ step: 0, limit: 25 })
      at(11, HEEL, -27)
      at(30)
      expect(events).toHaveLength(1)
      expect(evaluator.reached('')).toMatchObject({ value: -27, step: 0, limit: -25 })
      expect(evaluator.status().instances[0]).toMatchObject({ limit: -25, passed: 'low' })
      expect(evaluator.revisions()).toEqual([
        { instance: undefined, priority: 'warning', limit: -25 }
      ])
    })

    it("stays the reached step's side when the value falls back inside it", () => {
      const { at, events, evaluator } = setup(heel)
      at(0, HEEL, -37)
      at(10)
      at(11, HEEL, -30)
      at(100)
      expect(events).toMatchObject([{ type: 'raise', priority: 'alarm', limit: -35 }])
      expect(evaluator.reached('')).toMatchObject({ value: -30, step: 1, limit: -35 })
    })

    it("names the reached step's bound on the side of a fall past only the first step's other limit", () => {
      const { at, events, evaluator } = setup(heel)
      at(0, HEEL, 30)
      at(10)
      at(11, HEEL, 37)
      at(21)
      at(22, HEEL, -30)
      at(100)
      expect(events).toMatchObject([
        { type: 'raise', priority: 'warning', limit: 25 },
        { type: 'priority', priority: 'alarm', limit: 35 }
      ])
      expect(evaluator.reached('')).toMatchObject({ value: -30, step: 1, limit: -35 })
      expect(evaluator.status().instances[0]).toMatchObject({ limit: -35, passed: 'low' })
      expect(evaluator.revisions()).toEqual([
        { instance: undefined, priority: 'alarm', limit: -35 }
      ])
    })

    it('escalates on the other side from the raise with the low bound', () => {
      const { at, events } = setup(heel)
      at(0, HEEL, 27)
      at(10)
      at(11, HEEL, -37)
      at(21)
      expect(events).toEqual([
        {
          type: 'raise',
          instance: undefined,
          priority: 'warning',
          rule: heel,
          value: 27,
          limit: 25
        },
        { type: 'priority', instance: undefined, priority: 'alarm', limit: -35 }
      ])
    })

    it("an edit in place after a move to the other side sends that side's bound", () => {
      const { at, evaluator } = setup(heel)
      at(0, HEEL, 27)
      at(10)
      at(11, HEEL, -27)
      at(30)
      evaluator.update(valid({ ...heel, message: 'Heel {value}' }))
      expect(evaluator.revisions()).toEqual([
        { instance: undefined, priority: 'warning', limit: -25 }
      ])
    })

    it("is an adopted alert's high limit once its first value is above the range", () => {
      const { at, events, evaluator } = setup(heel, { adopted: [{}] })
      at(0, HEEL, 27)
      expect(events).toEqual([])
      expect(evaluator.reached('')).toMatchObject({ value: 27, step: 0, limit: 25 })
      expect(evaluator.status().instances[0]).toMatchObject({ limit: 25, passed: 'high' })
    })

    it('is absent for an adopted alert whose first value is in the hysteresis band', () => {
      const { at, events, evaluator } = setup(heel, { adopted: [{}] })
      at(0, HEEL, 24)
      at(100)
      expect(events).toEqual([])
      expect(evaluator.reached('')).toEqual({ value: 24, index: 0, step: 0, limit: undefined })
      expect(evaluator.status().instances[0]?.limit).toBeUndefined()
      expect(evaluator.status().instances[0]?.passed).toBeUndefined()
    })

    it('is absent for a unit never beyond either limit', () => {
      const { at, evaluator } = setup(heel)
      at(0, HEEL, 3)
      expect(evaluator.status().instances[0]?.limit).toBeUndefined()
      expect(evaluator.status().instances[0]?.passed).toBeUndefined()
      expect(evaluator.reached('')).toEqual({ value: 3, index: 0, step: 0, limit: undefined })
    })
  })
})

const RPM = 'propulsion.main.revolutions'
const OIL = 'propulsion.main.oilPressure'
const oilPressure = valid({
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  signal: { path: OIL },
  detector: {
    type: 'sustained',
    direction: 'below',
    steps: [{ limit: 100000, priority: 'alarm' }],
    duration: 5
  },
  gates: [
    { signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 }, duration: 10 }
  ]
})

describe('gates', () => {
  it('a stopped engine takes the rule out of use', () => {
    const { at, log, evaluator } = setup(oilPressure)
    at(0, RPM, 0)
    at(0, OIL, 0)
    at(1000)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]?.inUse).toBe(false)
  })

  it('an active alert clears when the gate stops holding', () => {
    const { at, log } = setup(oilPressure)
    at(0, RPM, 30)
    at(0, OIL, 300000)
    at(10)
    at(20, OIL, 0)
    at(25)
    at(30, RPM, 0)
    expect(log).toEqual([
      [25, 'raise', '', 'alarm'],
      [30, 'clear', '']
    ])
  })

  it('detectors start when the rule comes into use, so pressure building at start does not alarm', () => {
    const { at, log } = setup(oilPressure)
    at(0, RPM, 30)
    at(0, OIL, 0)
    at(10)
    at(12, OIL, 300000)
    at(1000)
    expect(log).toEqual([])
  })

  it('a value unchanged since before the rule came into use still counts', () => {
    const HIGH_WATER = 'environment.bilge.highWater'
    const rule = valid({
      name: 'Bilge high water underway',
      slug: 'bilge-high-water',
      message: 'Bilge water is high',
      signal: { path: HIGH_WATER },
      detector: { type: 'match', op: 'equals', steps: [{ value: true, priority: 'alarm' }] },
      gates: [
        {
          signal: { path: RPM },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 },
          duration: 10
        }
      ]
    })
    const { at, log } = setup(rule)
    at(0, HIGH_WATER, true)
    at(5, RPM, 30)
    at(15)
    expect(log).toEqual([[15, 'raise', '', 'alarm']])
  })

  it('an engine that stopped before its rpm input timed out stays out of use', () => {
    const { at, log, evaluator } = setup(oilPressure)
    at(0, RPM, 30)
    at(0, OIL, 300000)
    at(100, RPM, 0)
    at(101, OIL, 0)
    at(105, RPM, null, TIMED_OUT)
    at(1000)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]).toMatchObject({
      inUse: false,
      gates: [{ holds: false, input: 'unavailable' }]
    })
  })

  it('an rpm input that times out while the engine runs keeps the rule in use', () => {
    const { at, log, evaluator } = setup(oilPressure)
    at(0, RPM, 30)
    at(0, OIL, 300000)
    at(10)
    at(20, RPM, null, TIMED_OUT)
    at(30, OIL, 0)
    at(35)
    expect(log).toEqual([[35, 'raise', '', 'alarm']])
    expect(evaluator.status().instances[0]?.gates).toEqual([
      { path: RPM, holds: true, input: 'unavailable' }
    ])
  })

  it('a gate input never seen since start does not hold', () => {
    const { at, log, evaluator } = setup(oilPressure)
    at(0, OIL, 0)
    at(1000)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]?.inUse).toBe(false)
  })

  it('an adopted alert is kept until the gate input reports', () => {
    const { at, log } = setup(oilPressure, { adopted: [{}] })
    at(0, OIL, 0)
    at(1000)
    expect(log).toEqual([])
    at(1001, RPM, 0)
    expect(log).toEqual([[1001, 'clear', '']])
  })

  it('an accumulator keeps accumulating while its rule is out of use', () => {
    const rule = valid({
      name: 'Genset hours',
      slug: 'genset-hours',
      message: 'Genset service due',
      signal: { path: RPM },
      detector: {
        type: 'accumulator',
        measure: 'time',
        steps: [{ limit: 100, priority: 'caution' }]
      },
      gates: [
        {
          signal: { path: 'environment.mode' },
          direction: 'above',
          limit: { kind: 'fixed', value: 0 }
        }
      ]
    })
    const { at, log } = setup(rule)
    at(0, 'environment.mode', 0)
    for (let t = 0; t <= 150; t += 10) at(t, RPM, 30)
    expect(log).toEqual([])
    at(151, 'environment.mode', 1)
    expect(log).toEqual([[151, 'raise', '', 'caution']])
  })
})

const DEPTH = 'environment.depth.belowTransducer'
const depthTimeout = valid({
  name: 'Depth sensor silent',
  slug: 'depth-sensor-silent',
  message: 'No depth data',
  signal: { path: DEPTH },
  detector: { type: 'match', op: 'timedOut', steps: [{ priority: 'warning' }], duration: 30 }
})

describe('checks when a path reports', () => {
  const HDG_A = 'navigation.headingMagnetic'
  const HDG_B = 'navigation.headingTrue'
  const compasses = valid({
    name: 'Compasses disagree',
    slug: 'compasses-disagree',
    condition: 'compassesDisagree',
    message: 'Compasses disagree',
    signal: {
      combinator: 'absDifference',
      angular: true,
      inputs: [{ path: HDG_A }, { path: HDG_B }]
    },
    detector: {
      type: 'sustained',
      direction: 'above',
      steps: [{ limit: 0.1, priority: 'caution' }]
    }
  })

  it('an angular combination whose input reports units other than radians is inactive', () => {
    const { at, log, evaluator } = setup(compasses, {
      meta: { [HDG_A]: { units: 'rad' }, [HDG_B]: { units: 'deg' } }
    })
    at(0, HDG_A, 0.1)
    at(0, HDG_B, 90)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
      reason: 'unitsNotRadians',
      path: HDG_B,
      units: 'deg'
    })
  })

  it('units that arrive after the values make an active angular rule inactive and clear it', () => {
    const { at, log, evaluator, meta } = setup(compasses)
    at(0, HDG_A, 0.1)
    at(0, HDG_B, 1.5)
    expect(log).toEqual([[0, 'raise', '', 'caution']])
    meta.set(HDG_B, { units: 'deg' })
    at(1)
    expect(log).toEqual([
      [0, 'raise', '', 'caution'],
      [1, 'clear', '']
    ])
    expect(evaluator.status().instances[0]?.judgement.problem).toMatchObject({
      reason: 'unitsNotRadians'
    })
  })

  it('an angular combination in radians evaluates', () => {
    const { at, log, evaluator } = setup(compasses, {
      meta: { [HDG_A]: { units: 'rad' }, [HDG_B]: { units: 'rad' } }
    })
    at(0, HDG_A, 0.1)
    at(0, HDG_B, 1.5)
    expect(log).toEqual([[0, 'raise', '', 'caution']])
    expect(evaluator.status().instances[0]?.judgement.problem).toBeUndefined()
  })

  it.each([
    ['boolean', true, 'booleanPath'],
    ['string', 'ok', 'stringPath']
  ])(
    'a timeout rule whose path reports a %s value is inactive, and its adopted alert clears',
    (_type, value, cause) => {
      const { at, log, evaluator } = setup(depthTimeout, { adopted: [{}] })
      at(5, DEPTH, value)
      expect(log).toEqual([[5, 'clear', '']])
      expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
        reason: 'timeoutNotPossible',
        cause
      })
      at(100, DEPTH, null, TIMED_OUT)
      expect(log).toHaveLength(1)
    }
  )

  it('a timeout rule on a numeric path evaluates', () => {
    const { at, evaluator } = setup(depthTimeout)
    at(0, DEPTH, 7.3)
    expect(evaluator.status().instances[0]?.judgement.problem).toBeUndefined()
  })
})

describe('timeout rules', () => {
  it('fire when the path has not been seen for the duration since start', () => {
    const { at, log } = setup(depthTimeout)
    at(29)
    expect(log).toEqual([])
    at(30)
    expect(log).toEqual([[30, 'raise', '', 'warning']])
  })

  it('fire when the timed-out state lasts for the duration, and clear when data returns', () => {
    const { at, log } = setup(depthTimeout)
    at(0, DEPTH, 7.3)
    at(10, DEPTH, null, TIMED_OUT)
    at(39)
    expect(log).toEqual([])
    at(40)
    at(50, DEPTH, 7)
    expect(log).toEqual([
      [40, 'raise', '', 'warning'],
      [50, 'clear', '']
    ])
  })

  it.each([
    [{ enforce: false, useDefaults: true }, {}, { cause: 'notEnforced' }],
    [{ enforce: true, useDefaults: false }, {}, { cause: 'noTimeout' }],
    [ENFORCED, { updateContract: 'event' }, { cause: 'updateContract', contract: 'event' }],
    [ENFORCED, { timeout: 0 }, { cause: 'timeoutOff' }]
  ])(
    'are inactive when the server can never time the path out (%o, %o)',
    (settings, meta, reason) => {
      const { at, log, evaluator } = setup(depthTimeout, { settings, meta: { [DEPTH]: meta } })
      at(0, DEPTH, 7.3)
      at(1000)
      expect(log).toEqual([])
      expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
        reason: 'timeoutNotPossible',
        ...reason
      })
    }
  )

  it('a meta timeout makes a path time out even with default timeouts off', () => {
    const { at, log } = setup(depthTimeout, {
      settings: { enforce: true, useDefaults: false },
      meta: { [DEPTH]: { timeout: 10 } }
    })
    at(0, DEPTH, 7.3)
    at(10, DEPTH, null, TIMED_OUT)
    at(40)
    expect(log).toEqual([[40, 'raise', '', 'warning']])
  })

  it('unreadable server settings do not make a rule inactive', () => {
    const { at, log } = setup(depthTimeout, { settings: undefined })
    at(30)
    expect(log).toEqual([[30, 'raise', '', 'warning']])
  })
})

describe('wildcard rules', () => {
  const coolant = valid({
    name: 'Coolant temperature high',
    slug: 'coolant-high',
    message: 'Coolant temperature is high on {instance}',
    signal: { path: 'propulsion.*.coolantTemperature' },
    detector: {
      type: 'sustained',
      direction: 'above',
      steps: [{ limit: 368, priority: 'warning' }]
    },
    gates: [
      {
        signal: { path: 'propulsion.*.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 8 }
      }
    ]
  })

  it('evaluate each instance against the gate of the same instance', () => {
    const { at, log } = setup(coolant)
    at(0, 'propulsion.port.revolutions', 30)
    at(0, 'propulsion.starboard.revolutions', 0)
    at(1, 'propulsion.port.coolantTemperature', 370)
    at(1, 'propulsion.starboard.coolantTemperature', 370)
    expect(log).toEqual([[1, 'raise', 'port', 'warning']])
  })
})

describe('field rules', () => {
  const ATTITUDE = 'navigation.attitude'
  const ROLL = 'navigation.attitude#/roll'
  const rollHigh = valid({
    name: 'Roll high',
    slug: 'roll-high',
    message: 'Roll is high',
    signal: { path: ROLL },
    detector: {
      type: 'sustained',
      direction: 'above',
      steps: [{ limit: 0.35, priority: 'warning' }]
    }
  })

  it('evaluate each instance of a wildcard directly before the pointer against its own gate', () => {
    const rule = valid({
      name: 'Battery low',
      slug: 'battery-low',
      message: 'Battery {instance} low',
      signal: { path: 'electrical.batteries.*#/voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 12, priority: 'warning' }]
      },
      gates: [
        {
          signal: { path: 'electrical.batteries.*#/current' },
          direction: 'below',
          limit: { kind: 'fixed', value: 0 }
        }
      ]
    })
    const { at, log, evaluator } = setup(rule)
    at(0, 'electrical.batteries.house', { voltage: 11.5, current: -5 })
    at(0, 'electrical.batteries.start', { voltage: 11.5, current: 2 })
    expect(log).toEqual([[0, 'raise', 'house', 'warning']])
    expect(evaluator.status().instances.map((u) => u.instance?.name)).toEqual(['house', 'start'])
  })

  it('a gate on a field holds on that field of the base path', () => {
    const rule = valid({
      ...rollHigh,
      gates: [
        {
          signal: { path: 'navigation.attitude#/pitch' },
          direction: 'below',
          limit: { kind: 'fixed', value: 0.1 }
        }
      ]
    })
    const { at, log } = setup(rule)
    at(0, ATTITUDE, { roll: 0.4, pitch: 0.2 })
    expect(log).toEqual([])
    at(1, ATTITUDE, { roll: 0.4, pitch: 0 })
    expect(log).toEqual([[1, 'raise', '', 'warning']])
  })

  it("times out on the base path's timeout, as its meta reports for the field", () => {
    const rule = valid({ ...depthTimeout, signal: { path: ROLL } })
    const { at, log, evaluator } = setup(rule, {
      settings: { enforce: true, useDefaults: false },
      meta: { [ROLL]: { timeout: 10 } }
    })
    at(0, ATTITUDE, { roll: 0.1 })
    at(10, ATTITUDE, null, TIMED_OUT)
    at(40)
    expect(log).toEqual([[40, 'raise', '', 'warning']])
    expect(evaluator.status().instances[0]?.judgement.problem).toBeUndefined()
  })

  it('an angular combination of fields reported in other units than radians is inactive', () => {
    const PITCH = 'navigation.attitude#/pitch'
    const rule = valid({
      name: 'Roll and pitch apart',
      slug: 'roll-pitch-apart',
      condition: 'rollPitchApart',
      message: 'm',
      signal: {
        combinator: 'absDifference',
        angular: true,
        inputs: [{ path: ROLL }, { path: PITCH }]
      },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 0.1, priority: 'caution' }]
      }
    })
    const { at, evaluator } = setup(rule, {
      meta: { [ROLL]: { units: 'rad' }, [PITCH]: { units: 'deg' } }
    })
    at(0, ATTITUDE, { roll: 0.4, pitch: 0 })
    expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
      reason: 'unitsNotRadians',
      path: PITCH,
      units: 'deg'
    })
  })
})

const engineStopped = valid({
  name: 'Engine stopped',
  slug: 'engine-stopped',
  message: 'Engine {instance} stopped',
  signal: { path: 'propulsion.*.state' },
  detector: { type: 'match', op: 'changesTo', steps: [{ value: 'stopped', priority: 'warning' }] }
})

describe('pulses', () => {
  it('a transition match raises and clears at once', () => {
    const { at, log } = setup(engineStopped)
    at(0, 'propulsion.port.state', 'started')
    at(5, 'propulsion.port.state', 'stopped')
    expect(log).toEqual([
      [5, 'raise', 'port', 'warning'],
      [5, 'clear', 'port']
    ])
  })
})

describe('rule edits', () => {
  const raised = () => {
    const s = setup(oilPressure)
    s.at(0, RPM, 30)
    s.at(0, OIL, 300000)
    s.at(10)
    s.at(20, OIL, 0)
    s.at(25)
    expect(s.log).toEqual([[25, 'raise', '', 'alarm']])
    s.log.length = 0
    return s
  }

  type Input = [string, Value, PathValueState | undefined, string]
  it.each<[string, (r: Rule) => Rule, Input]>([
    [
      'inputs',
      (r) => ({ ...r, signal: { path: 'propulsion.main.oilPressure', source: 'n2k.1' } }),
      [OIL, 0, undefined, 'n2k.1']
    ],
    [
      'detector type',
      (r) => ({
        ...r,
        detector: { type: 'match', op: 'equals', steps: [{ value: 0, priority: 'alarm' }] }
      }),
      [OIL, 0, undefined, 'src']
    ],
    [
      'limit direction',
      (r) => ({ ...r, detector: { ...r.detector, direction: 'above' } as Rule['detector'] }),
      [OIL, 300001, undefined, 'src']
    ],
    ['gates', (r) => ({ ...r, gates: [] }), [OIL, 0, undefined, 'src']]
  ])('changing %s clears and restarts', (_what, edit, input) => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.update(edit(oilPressure))
    expect(log[0]).toEqual([30, 'clear', ''])
    at(31, RPM, 30)
    at(32, ...input)
    for (let t = 40; t <= 100; t += 10) at(t)
    expect(log.slice(1, 2)).toEqual([[expect.any(Number), 'raise', '', 'alarm']])
  })

  it('changing latching clears and restarts, and the restarted rule counts only live events', () => {
    const PUMP = 'electrical.switches.bilgePump.state'
    const pumpCycling = valid({
      name: 'Bilge pump cycling',
      slug: 'bilge-pump-cycling',
      message: 'Bilge pump is cycling',
      signal: { path: PUMP },
      detector: {
        type: 'count',
        event: { op: 'changesTo', value: true },
        window: 600,
        steps: [{ limit: 1, priority: 'alarm' }]
      }
    })
    const { evaluator, log, at } = setup(pumpCycling)
    at(0, PUMP, true)
    at(1, PUMP, false)
    at(2, PUMP, true)
    evaluator.update({ ...pumpCycling, latching: true })
    expect(log).toEqual([
      [2, 'raise', '', 'alarm'],
      [2, 'clear', '']
    ])
    at(3, PUMP, false)
    at(4, PUMP, true)
    expect(log).toHaveLength(2)
    at(5, PUMP, false)
    at(6, PUMP, true)
    expect(log.at(-1)).toEqual([6, 'raise', '', 'alarm'])
  })

  it('a new limit value is evaluated in place', () => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.update({
      ...oilPressure,
      detector: { ...oilPressure.detector, steps: [{ limit: 50000, priority: 'alarm' }] }
    } as Rule)
    expect(log).toEqual([])
    at(31)
    evaluator.update({
      ...oilPressure,
      detector: { ...oilPressure.detector, steps: [{ limit: -1, priority: 'alarm' }] }
    } as Rule)
    expect(log).toEqual([[31, 'clear', '']])
  })

  it('a priority edit takes effect at the next raise', () => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.update({
      ...oilPressure,
      detector: { ...oilPressure.detector, steps: [{ limit: 100000, priority: 'emergency' }] }
    } as Rule)
    expect(log).toEqual([])
    at(40, OIL, 300000)
    at(50, OIL, 0)
    at(55)
    expect(log.at(-1)).toEqual([55, 'raise', '', 'emergency'])
  })

  it('a message edit takes effect at the next raise', () => {
    const { evaluator, log, at, events } = raised()
    at(30)
    evaluator.update({ ...oilPressure, message: 'Check the oil' })
    expect(log).toEqual([])
    at(40, OIL, 300000)
    at(50, OIL, 0)
    at(55)
    const last = events.at(-1)
    expect(last?.type === 'raise' && last.rule.message).toBe('Check the oil')
  })

  it('stating latching false is not an edit', () => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.update({ ...oilPressure, latching: false })
    expect(log).toEqual([])
  })

  it('removing a rule clears its alerts', () => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.remove()
    expect(log).toEqual([[30, 'clear', '']])
  })

  it('stopping never clears', () => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.stop()
    at(40, OIL, 300000)
    expect(log).toEqual([])
  })
})

describe('adopted alerts', () => {
  const STATE = 'propulsion.main.state'
  const unchanged = valid({
    name: 'Engine state unchanged',
    slug: 'engine-state-unchanged',
    message: 'Engine state unchanged',
    signal: { path: STATE },
    detector: {
      type: 'absence',
      event: { op: 'changes' },
      steps: [{ within: 900, priority: 'warning' }]
    }
  })

  it("an adopted absence alert takes its input's first live value as the baseline", () => {
    const { at, log } = setup(unchanged, { adopted: [{}] })
    at(1, STATE, 'stopped')
    at(1000)
    at(1100, STATE, 'started')
    expect(log).toEqual([[1100, 'clear', '']])
  })

  it("an absence rule without an adopted alert counts its input's first live value", () => {
    const { at, log } = setup(unchanged)
    at(1, STATE, 'stopped')
    at(900)
    at(901)
    expect(log).toEqual([[901, 'raise', '', 'warning']])
  })

  it('an adopted alert cleared by its gate does not raise again when the rule returns to use', () => {
    const rule = {
      ...oilPressure,
      detector: { ...oilPressure.detector, clearDuration: 10 }
    } as Rule
    const { at, log } = setup(rule, {
      adopted: [{}],
      cached: [
        [RPM, 0],
        [OIL, 300000]
      ]
    })
    at(100, RPM, 30)
    for (let t = 101; t <= 200; t++) at(t)
    expect(log).toEqual([[0, 'clear', '']])
  })

  it('a shared gate never seen holds only for the adopted instance', () => {
    const IGNITION = 'electrical.switches.ignition.value'
    const rule = valid({
      name: 'Coolant temperature high',
      slug: 'coolant-high',
      message: 'Coolant temperature is high on {instance}',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 360, priority: 'warning' }]
      },
      gates: [
        { signal: { path: IGNITION }, direction: 'above', limit: { kind: 'fixed', value: 0.5 } }
      ]
    })
    const { at, log, evaluator } = setup(rule, {
      adopted: [{ segment: 'port' }]
    })
    at(1, 'propulsion.starboard.coolantTemperature', 370)
    at(2, 'propulsion.port.coolantTemperature', 370)
    at(100)
    expect(log).toEqual([])
    const instances = evaluator.status().instances
    const of = (segment: string) => instances.find((i) => i.instance?.segment === segment)
    expect(of('port')).toMatchObject({ inUse: true })
    expect(of('starboard')).toMatchObject({
      inUse: false,
      judgement: expect.not.objectContaining({ alert: expect.anything() as unknown }) as unknown
    })
  })

  it('a wildcard adopted instance is kept until its own gate input reports', () => {
    const rule = valid({
      name: 'Coolant temperature high',
      slug: 'coolant-high',
      message: 'Coolant temperature is high on {instance}',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 368, priority: 'warning' }]
      },
      gates: [
        {
          signal: { path: 'propulsion.*.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 }
        }
      ]
    })
    const { at, log } = setup(rule, { adopted: [{ segment: 'port' }] })
    at(1, 'propulsion.starboard.revolutions', 30)
    at(100)
    expect(log).toEqual([])
    at(101, 'propulsion.port.revolutions', 0)
    expect(log).toEqual([[101, 'clear', 'port']])
  })

  it('an in-place edit of an adopted alert emits nothing', () => {
    const { at, log, evaluator } = setup({ ...oilPressure, gates: undefined }, { adopted: [{}] })
    at(0, OIL, 0)
    evaluator.update({ ...oilPressure, gates: undefined, message: 'Check the oil' })
    at(10)
    expect(log).toEqual([])
  })

  it('a timeout rule with default timeouts off still fires for a path never seen, and keeps an adopted alert', () => {
    const settings = { enforce: true, useDefaults: false }
    const fresh = setup(depthTimeout, { settings })
    fresh.at(30)
    expect(fresh.log).toEqual([[30, 'raise', '', 'warning']])
    const adopted = setup(depthTimeout, { settings, adopted: [{}] })
    adopted.at(100)
    expect(adopted.log).toEqual([])
  })
})

describe('restarts and status', () => {
  const genset = valid({
    name: 'Genset hours',
    slug: 'genset-hours',
    message: 'Genset service due',
    signal: { path: RPM },
    detector: { type: 'accumulator', measure: 'time', steps: [{ limit: 100, priority: 'caution' }] }
  })

  const running = (rule: Rule) => {
    const s = setup(rule)
    for (let t = 0; t <= 60; t += 10) s.at(t, RPM, 30)
    return s
  }

  it('continues from a restored accumulator total', () => {
    const { at, log, evaluator } = setup(genset, { accumulated: new Map([['', 90]]) })
    expect(evaluator.accumulators()).toEqual(new Map([['', 90]]))
    at(0, RPM, 30)
    at(9)
    expect(log).toEqual([])
    at(10)
    expect(log).toEqual([[10, 'raise', '', 'caution']])
    expect(evaluator.accumulators()).toEqual(new Map([['', 100]]))
  })

  it('compares one total, restored or added to later, against every step', () => {
    const stepped = valid({
      ...genset,
      detector: {
        ...genset.detector,
        steps: [
          { limit: 100, priority: 'caution' },
          { limit: 150, priority: 'warning' }
        ]
      }
    })
    const { at, log, evaluator } = setup(stepped, { accumulated: new Map([['', 90]]) })
    at(0, RPM, 30)
    at(10)
    evaluator.update(
      valid({
        ...stepped,
        detector: {
          ...stepped.detector,
          steps: [
            { limit: 100, priority: 'caution' },
            { limit: 150, priority: 'warning' },
            { limit: 200, priority: 'alarm' }
          ]
        }
      })
    )
    at(60)
    at(110)
    expect(log).toEqual([
      [10, 'raise', '', 'caution'],
      [60, 'priority', '', 'warning'],
      [110, 'priority', '', 'alarm']
    ])
    expect(evaluator.accumulators()).toEqual(new Map([['', 200]]))
  })

  it("reports each instance's total, keeping restored ones not yet seen", () => {
    const hours = valid({
      ...genset,
      signal: { path: 'propulsion.*.revolutions' }
    })
    const { at, evaluator } = setup(hours, {
      accumulated: new Map([
        ['port', 40],
        ['starboard', 7]
      ])
    })
    at(0, 'propulsion.port.revolutions', 30)
    at(0, 'propulsion.centre.revolutions', 30)
    at(20)
    expect(evaluator.accumulators()).toEqual(
      new Map([
        ['port', 60],
        ['starboard', 7],
        ['centre', 20]
      ])
    )
  })

  it('a structural edit keeps a restored total of an instance not yet seen', () => {
    const hours = valid({
      ...genset,
      signal: { path: 'propulsion.*.revolutions' }
    })
    const { evaluator } = setup(hours, { accumulated: new Map([['port', 40]]) })
    evaluator.update({
      ...hours,
      detector: { ...hours.detector, while: { op: 'above', value: 0 } }
    } as Rule)
    expect(evaluator.accumulators()).toEqual(new Map([['port', 40]]))
  })

  it('reports no totals for a rule that is not an accumulator', () => {
    const { at, evaluator } = setup({ ...oilPressure, gates: undefined })
    at(0, OIL, 0)
    expect(evaluator.accumulators()).toEqual(new Map())
  })

  it('a structural edit keeps an accumulator total with the same measure', () => {
    const { at, log, evaluator } = running(genset)
    evaluator.update({
      ...genset,
      detector: { ...genset.detector, while: { op: 'above', value: 0 } }
    } as Rule)
    for (let t = 70; t <= 100; t += 10) at(t, RPM, 30)
    expect(log).toEqual([[100, 'raise', '', 'caution']])
  })

  it('a structural edit that changes the measure starts the total from zero', () => {
    const { at, log, evaluator } = running(genset)
    evaluator.update({
      ...genset,
      detector: {
        ...genset.detector,
        measure: 'integral',
        steps: [{ limit: 3000, priority: 'caution' }]
      }
    } as Rule)
    for (let t = 70; t <= 150; t += 10) at(t, RPM, 30)
    expect(log).toEqual([])
    for (let t = 160; t <= 170; t += 10) at(t, RPM, 30)
    expect(log).toEqual([[160, 'raise', '', 'caution']])
  })

  it('a structural edit forgets the issues of the old signal', () => {
    const rule = valid({
      name: 'Oil pressure low',
      slug: 'oil-low',
      message: 'Oil pressure low on {instance}',
      signal: { path: 'propulsion.*.oilPressure' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 100000, priority: 'alarm' }]
      }
    })
    const { at, evaluator } = setup(rule)
    at(0, 'propulsion.a b.oilPressure', 300000)
    at(0, 'propulsion.a_b.oilPressure', 300000)
    expect(evaluator.status().issues).not.toEqual([])
    evaluator.update({ ...rule, signal: { path: 'tanks.*.oilPressure' } })
    expect(evaluator.status().issues).toEqual([])
  })

  it("a gate's missing zone makes the rule inactive with the reason", () => {
    const rule = valid({
      ...oilPressure,
      gates: [
        { signal: { path: RPM }, direction: 'above', limit: { kind: 'zone', level: 'alarm' } }
      ]
    })
    const { at, evaluator } = setup(rule, {
      meta: { [RPM]: { zones: [{ lower: 10, state: 'warn' }] } }
    })
    at(0, RPM, 30)
    at(0, OIL, 0)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: false })
    expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
      reason: 'missingZone',
      level: 'alarm',
      gate: 0
    })
  })

  it('an edit to a stopped evaluator does not clear its alerts', () => {
    const { at, log, evaluator } = setup({ ...oilPressure, gates: undefined })
    at(0, OIL, 0)
    at(5)
    evaluator.stop()
    evaluator.update({ ...oilPressure, gates: undefined, signal: { path: 'x.y' } })
    expect(log).toEqual([[5, 'raise', '', 'alarm']])
  })
})

describe('zone changes and adopted gates', () => {
  it('a sample arriving with a zone change is evaluated, not only the zone change', () => {
    const rule = valid({
      ...batteryLow,
      detector: { ...batteryLow.detector, duration: 0 }
    })
    const { at, log, meta, evaluator } = setup(rule, {
      meta: { [VOLTAGE]: { zones: [{ upper: 12, state: 'warn' }] } }
    })
    at(0, VOLTAGE, 12.3)
    meta.set(VOLTAGE, { zones: [{ upper: 12.5, state: 'warn' }] })
    at(1, VOLTAGE, 12.7)
    at(100)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]?.judgement.alert).toBeUndefined()
  })

  it('a gate reporting after its adopted alert cleared still waits for its duration', () => {
    const rule = valid({
      name: 'Coolant temperature high',
      slug: 'coolant-high',
      message: 'Coolant temperature is high on {instance}',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 368, priority: 'warning' }]
      },
      gates: [
        {
          signal: { path: 'propulsion.*.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 },
          duration: 60
        }
      ]
    })
    const { at, log } = setup(rule, { adopted: [{ segment: 'port' }] })
    at(1, 'propulsion.port.coolantTemperature', 340)
    at(10, 'propulsion.port.revolutions', 30)
    at(11, 'propulsion.port.coolantTemperature', 370)
    for (let t = 12; t <= 80; t++) at(t)
    expect(log).toEqual([
      [1, 'clear', 'port'],
      [70, 'raise', 'port', 'warning']
    ])
  })

  it('a shared gate that reports gives only the adopted instance a head start', () => {
    const IGNITION = 'electrical.switches.ignition.value'
    const rule = valid({
      name: 'Coolant temperature high',
      slug: 'coolant-high',
      message: 'Coolant temperature is high on {instance}',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 368, priority: 'warning' }]
      },
      gates: [
        {
          signal: { path: IGNITION },
          direction: 'above',
          limit: { kind: 'fixed', value: 0.5 },
          duration: 60
        }
      ]
    })
    const { at, log, evaluator } = setup(rule, {
      adopted: [{ segment: 'port' }]
    })
    at(1, 'propulsion.port.coolantTemperature', 370)
    at(2, 'propulsion.starboard.coolantTemperature', 370)
    at(5, IGNITION, 1)
    for (let t = 6; t <= 70; t++) at(t)
    expect(log).toEqual([[65, 'raise', 'starboard', 'warning']])
    expect(
      evaluator.status().instances.find((i) => i.instance?.segment === 'port')?.judgement.alert
    ).toBeDefined()
  })
})

describe('live status', () => {
  it('reports the value, the limit, the timer toward set and toward clear, and each gate', () => {
    const rule = valid({
      ...oilPressure,
      detector: { ...oilPressure.detector, hysteresis: 50000, clearDuration: 10 }
    })
    const { at, evaluator } = setup(rule)
    at(0, RPM, 30)
    at(0, OIL, 300000)
    at(10)
    expect(evaluator.status().instances[0]).toMatchObject({
      value: 300000,
      limit: 100000,
      gates: [{ path: RPM, value: 30, holds: true, input: 'value' }]
    })
    expect(evaluator.status().instances[0]?.progress).toBeUndefined()
    at(12, OIL, 90000)
    at(15)
    expect(evaluator.status().instances[0]?.progress).toEqual({
      kind: 'timer',
      toward: 'set',
      elapsed: 3,
      target: 5
    })
    at(17)
    at(20, OIL, 200000)
    at(24)
    expect(evaluator.status().instances[0]).toMatchObject({
      value: 200000,
      progress: { kind: 'timer', toward: 'clear', elapsed: 4, target: 10 }
    })
  })

  it('a gate input never seen does not hold, and one gone unavailable keeps its state', () => {
    const { at, evaluator } = setup(oilPressure)
    at(0, OIL, 300000)
    expect(evaluator.status().instances[0]?.gates).toEqual([
      { path: RPM, holds: false, input: 'neverSeen' }
    ])
    at(1, RPM, 30)
    at(11)
    at(12, RPM, null)
    expect(evaluator.status().instances[0]?.gates).toEqual([
      { path: RPM, holds: true, input: 'unavailable' }
    ])
  })

  it('reports the zone limit resolved to its threshold', () => {
    const { at, evaluator } = setup(batteryLow, { meta: { [VOLTAGE]: { zones: batteryZones } } })
    at(0, VOLTAGE, 12.6)
    expect(evaluator.status().instances[0]).toMatchObject({ value: 12.6, limit: 12 })
  })

  it('an unavailable input reports no value, and how long ago it had one', () => {
    const { at, evaluator } = setup(batteryLow, { meta: { [VOLTAGE]: { zones: batteryZones } } })
    expect(evaluator.status().instances[0]?.sinceValue).toBeUndefined()
    at(0, VOLTAGE, 12.6)
    at(1, VOLTAGE, null)
    at(31)
    expect(evaluator.status().instances[0]).toMatchObject({
      sinceValue: 31,
      judgement: { input: 'unavailable' }
    })
    expect(evaluator.status().instances[0]?.value).toBeUndefined()
  })

  it('reports each gate bound to the instance of a wildcard rule', () => {
    const rule = valid({
      ...oilPressure,
      signal: { path: 'propulsion.*.oilPressure' },
      gates: [
        {
          signal: { path: 'propulsion.*.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 }
        }
      ]
    })
    const { at, evaluator } = setup(rule)
    at(0, 'propulsion.port.revolutions', 0)
    at(0, 'propulsion.port.oilPressure', 300000)
    expect(evaluator.status().instances[0]?.gates).toEqual([
      { path: 'propulsion.port.revolutions', value: 0, holds: false, input: 'value' }
    ])
  })

  it('reports how long the rule has evaluated since it last started', () => {
    const { at, evaluator } = setup(oilPressure)
    at(40)
    expect(evaluator.status().runningFor).toBe(40)
    evaluator.update({ ...oilPressure, signal: { path: 'x.y' } })
    at(50)
    expect(evaluator.status().runningFor).toBe(10)
    evaluator.update({ ...oilPressure, signal: { path: 'x.y' }, message: 'Check the oil' })
    at(60)
    expect(evaluator.status().runningFor).toBe(20)
  })

  it('reports an accumulator total while its rule is out of use', () => {
    const rule = valid({
      ...oilPressure,
      detector: { type: 'accumulator', measure: 'time', steps: [{ limit: 100, priority: 'alarm' }] }
    })
    const { at, evaluator } = setup(rule)
    at(0, RPM, 0)
    at(0, OIL, 300000)
    at(40)
    expect(evaluator.status().instances[0]).toMatchObject({
      inUse: false,
      progress: { kind: 'total', total: 40, limit: 100 }
    })
  })

  it('reports a subscription failure as an error', () => {
    class Failing extends FakeSubscriptionManager {
      override subscribe(...args: Parameters<FakeSubscriptionManager['subscribe']>): void {
        args[2](new Error('subscription refused'))
      }
    }
    const evaluator = new RuleEvaluator(
      oilPressure,
      {
        subscriptions: new Failing(),
        meta: () => undefined,
        timeoutSettings: () => ENFORCED,
        clock: () => 0
      },
      () => undefined
    )
    evaluator.start()
    expect(evaluator.status()).toMatchObject({ errors: ['subscription refused'], issues: [] })
  })

  it('reports the input and adoption of one instance without building the status', () => {
    const { at, evaluator } = setup(oilPressure, { adopted: [{}] })
    expect(evaluator.evidence('')).toEqual({ input: 'neverSeen', adopted: true })
    at(0, OIL, 0)
    expect(evaluator.evidence('')).toEqual({ input: 'value', adopted: true })
    expect(evaluator.evidence('port')).toBeUndefined()
  })
})

describe('disabled rules', () => {
  const portOil = valid({ ...oilPressure, slug: 'port-oil', gates: [] })

  it('disabling clears the active alert at once and raises nothing while the condition holds', () => {
    const { at, log, evaluator, setDisabled } = setup(portOil)
    at(0, OIL, 0)
    at(5)
    setDisabled(6, true)
    at(10, OIL, 50)
    at(100)
    expect(log).toEqual([
      [5, 'raise', '', 'alarm'],
      [6, 'clear', '']
    ])
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: true,
      judgement: expect.not.objectContaining({ alert: expect.anything() as unknown }) as unknown
    })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
  })

  it('enabling while the condition holds raises a new alert at once', () => {
    const { at, log, setDisabled } = setup(portOil, { disabled: true })
    at(0, OIL, 0)
    at(30)
    expect(log).toEqual([])
    setDisabled(31, false)
    expect(log).toEqual([[31, 'raise', '', 'alarm']])
  })

  it('enabling while the condition is clear raises nothing', () => {
    const { at, log, setDisabled } = setup(portOil, { disabled: true })
    at(0, OIL, 0)
    at(30, OIL, 300000)
    setDisabled(31, false)
    at(40)
    expect(log).toEqual([])
  })

  it('reports how long ago the condition cleared, and moves it when it clears again', () => {
    const { at, evaluator } = setup(portOil, { disabled: true })
    at(0, OIL, 0)
    at(5)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(10, OIL, 300000)
    at(70)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 60
    })
    at(80, OIL, 0)
    at(85)
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    at(90, OIL, 300000)
    at(100)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 10
    })
  })

  it('reports the condition per instance of a wildcard rule', () => {
    const each = valid({
      ...portOil,
      signal: { path: 'propulsion.*.oilPressure' }
    })
    const { at, evaluator } = setup(each, { disabled: true })
    at(0, 'propulsion.port.oilPressure', 0)
    at(0, 'propulsion.starboard.oilPressure', 0)
    at(5)
    at(10, 'propulsion.starboard.oilPressure', 300000)
    at(30)
    expect(
      evaluator.status().instances.map((i) => [i.instance?.name, i.conditionPresent, i.clearedFor])
    ).toEqual([
      ['port', true, undefined],
      ['starboard', false, 20]
    ])
  })

  it('keeps the last judged condition while out of use, and judges again back in use', () => {
    const gated = valid({
      ...oilPressure,
      gates: [{ ...oilPressure.gates?.[0], duration: 0 }]
    })
    const { at, evaluator } = setup(gated, { disabled: true })
    at(0, RPM, 30)
    at(0, OIL, 0)
    at(5)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(10, RPM, 0)
    at(100)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: false, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()

    at(110, RPM, 30)
    at(110, OIL, 300000)
    at(120)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 10
    })
    at(130, RPM, 0)
    at(200)
    expect(evaluator.status().instances[0]).toMatchObject({
      inUse: false,
      conditionPresent: false,
      clearedFor: 90
    })
  })

  it('a gate closing and reopening while the condition holds is not a clear', () => {
    const gated = valid({
      ...oilPressure,
      gates: [{ ...oilPressure.gates?.[0], duration: 0 }]
    })
    const { at, evaluator } = setup(gated, { disabled: true })
    at(0, RPM, 30)
    at(0, OIL, 0)
    at(5)
    at(10, RPM, 0)
    at(100, RPM, 30)
    // Back in use, the detector waits out its duration again.
    at(102)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    at(110)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
  })

  it('a gate cycle while a slope condition holds is not a clear while the window refills', () => {
    const VOLTS = 'electrical.batteries.house.voltage'
    const rising = valid({
      name: 'Voltage rising',
      slug: 'voltage-rising',
      message: 'Voltage is rising fast',
      signal: { path: VOLTS },
      detector: {
        type: 'slope',
        direction: 'rising',
        window: 60,
        steps: [{ limit: 0.005, priority: 'warning' }]
      },
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const { at, evaluator } = setup(rising, { disabled: true })
    const volts = (t: number) => 12 + t * 0.01
    at(0, RPM, 30)
    for (let t = 0; t <= 120; t += 10) at(t, VOLTS, volts(t))
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(130, RPM, 0)
    at(200, RPM, 30)
    for (let t = 210; t <= 240; t += 10) at(t, VOLTS, volts(t))
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    for (let t = 250; t <= 300; t += 10) at(t, VOLTS, volts(t))
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
  })

  it('a gate cycle while a projection holds with a level flat past its limit is not a clear', () => {
    const TEMP = 'propulsion.main.coolantTemperature'
    const rising = valid({
      name: 'Coolant heading high',
      slug: 'coolant-heading-high',
      message: 'Coolant is heading high',
      signal: { path: TEMP },
      detector: {
        type: 'projection',
        direction: 'rising',
        window: 60,
        horizon: 600,
        steps: [{ limit: 95, priority: 'warning' }]
      },
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const { at, evaluator } = setup(rising, { disabled: true })
    at(0, RPM, 30)
    for (let t = 0; t <= 60; t += 10) at(t, TEMP, 80 + t * 0.1)
    for (let t = 70; t <= 190; t += 10) at(t, TEMP, 100)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(200, RPM, 0)
    at(300, RPM, 30)
    for (let t = 300; t <= 450; t += 10) at(t, TEMP, 100)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
  })

  it('a gate cycle while a match condition holds is not a clear until a reading does not match', () => {
    const STATE = 'propulsion.main.state'
    const fault = valid({
      name: 'Engine fault',
      slug: 'engine-fault',
      message: 'Engine reports a fault',
      signal: { path: STATE },
      detector: {
        type: 'match',
        op: 'equals',
        steps: [{ value: 'fault', priority: 'alarm' }],
        duration: 5
      },
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const { at, evaluator } = setup(fault, { disabled: true })
    at(0, RPM, 30)
    at(0, STATE, 'fault')
    at(10)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(20, RPM, 0)
    at(100, RPM, 30)
    at(102)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    at(103, STATE, 'running')
    at(110)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 7
    })
  })

  it('a gate cycle while an absence condition holds is not a clear until an event arrives', () => {
    const ACK = 'navigation.watch.acknowledged'
    const watch = valid({
      name: 'Watch not acknowledged',
      slug: 'watch-not-acknowledged',
      message: 'Watch not acknowledged',
      signal: { path: ACK },
      detector: {
        type: 'absence',
        event: { op: 'changes' },
        steps: [{ within: 60, priority: 'alarm' }]
      },
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const { at, evaluator } = setup(watch, { disabled: true })
    at(0, RPM, 30)
    at(0, ACK, 1)
    at(61)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(70, RPM, 0)
    at(100, RPM, 30)
    at(120)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    at(130, ACK, 2)
    at(140)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 10
    })
  })

  it('a gate cycle while a count condition holds is not a clear until a full window has passed', () => {
    const PUMP = 'electrical.switches.bilgePump.state'
    const cycling = valid({
      name: 'Bilge pump cycling',
      slug: 'bilge-pump-cycling',
      message: 'Bilge pump is cycling',
      signal: { path: PUMP },
      detector: {
        type: 'count',
        event: { op: 'changesTo', value: true },
        window: 600,
        steps: [{ limit: 1, priority: 'alarm' }]
      },
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const { at, evaluator } = setup(cycling, { disabled: true })
    at(0, RPM, 30)
    at(0, PUMP, true)
    at(1, PUMP, false)
    at(2, PUMP, true)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
    at(10, RPM, 0)
    at(100, RPM, 30)
    at(110)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    // A full window after the restart without events is evidence the condition is gone.
    at(700)
    at(720)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 20
    })
  })

  it('a gate cycle while a sustained condition holds is not a clear while the input is unavailable', () => {
    const gated = valid({
      ...oilPressure,
      gates: [{ ...oilPressure.gates?.[0], duration: 0 }]
    })
    const { at, evaluator } = setup(gated, { disabled: true })
    at(0, RPM, 30)
    at(0, OIL, 0)
    at(5)
    at(10, RPM, 0)
    at(50, OIL, null)
    at(100, RPM, 30)
    at(110)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
  })

  it('a gate cycle while a sustained condition holds is not a clear on a reading inside its recovery margin', () => {
    const gated = valid({
      ...oilPressure,
      detector: { ...oilPressure.detector, hysteresis: 10000 },
      gates: [{ ...oilPressure.gates?.[0], duration: 0 }]
    })
    const { at, evaluator } = setup(gated, { disabled: true })
    at(0, RPM, 30)
    at(0, OIL, 0)
    at(5)
    at(10, RPM, 0)
    at(50, OIL, 105000)
    at(100, RPM, 30)
    at(110)
    expect(evaluator.status().instances[0]).toMatchObject({ inUse: true, conditionPresent: true })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
    // Neither present nor clear: the disabled view reads as an enabled rule's.
    expect(evaluator.status().instances[0]?.judgement).toMatchObject({
      present: false,
      undecided: true
    })
    at(120, OIL, 115000)
    at(130)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 10,
      judgement: { present: false, undecided: false }
    })
  })

  it('toggling a rule whose condition held across a gate cycle changes nothing, inside the recovery margin', () => {
    const gated = valid({
      ...oilPressure,
      detector: { ...oilPressure.detector, hysteresis: 10000 },
      gates: [{ ...oilPressure.gates?.[0], duration: 0 }]
    })
    const run = (toggle: boolean) => {
      const { at, log, setDisabled } = setup(gated)
      at(0, RPM, 30)
      at(0, OIL, 0)
      at(5)
      at(10, RPM, 0)
      at(50, OIL, 105000)
      at(100, RPM, 30)
      at(110)
      if (toggle) {
        setDisabled(111, true)
        setDisabled(111, false)
      }
      at(120)
      return log
    }
    const untouched = run(false)
    expect(untouched).toEqual([
      [5, 'raise', '', 'alarm'],
      [10, 'clear', '']
    ])
    expect(run(true)).toEqual(untouched)
  })

  it('toggling a rule whose condition held across a gate cycle changes nothing while a trend window refills', () => {
    const VOLTS = 'electrical.batteries.house.voltage'
    const rising = valid({
      name: 'Voltage rising',
      slug: 'voltage-rising',
      message: 'Voltage is rising fast',
      signal: { path: VOLTS },
      detector: {
        type: 'slope',
        direction: 'rising',
        window: 60,
        steps: [{ limit: 0.005, priority: 'warning' }]
      },
      gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
    })
    const volts = (t: number) => 12 + t * 0.01
    const run = (toggle: boolean) => {
      const { at, log, setDisabled } = setup(rising)
      at(0, RPM, 30)
      for (let t = 0; t <= 120; t += 10) at(t, VOLTS, volts(t))
      at(130, RPM, 0)
      at(200, RPM, 30)
      at(210, VOLTS, volts(210))
      if (toggle) {
        setDisabled(215, true)
        setDisabled(215, false)
      }
      for (let t = 220; t <= 300; t += 10) at(t, VOLTS, volts(t))
      return log
    }
    const untouched = run(false)
    expect(untouched.at(-1)).toEqual([260, 'raise', '', 'warning'])
    expect(run(true)).toEqual(untouched)
  })

  it('a condition that clears while its gate reopens is cleared from then', () => {
    const gated = valid({
      ...oilPressure,
      gates: [{ ...oilPressure.gates?.[0], duration: 0 }]
    })
    const { at, evaluator } = setup(gated, { disabled: true })
    at(0, RPM, 30)
    at(0, OIL, 0)
    at(5)
    at(10, RPM, 0)
    at(100, RPM, 30)
    at(102, OIL, 300000)
    at(110)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 8
    })
  })

  it('a condition never present since start has no clear time', () => {
    const { at, evaluator } = setup(portOil, { disabled: true })
    at(0, OIL, 300000)
    at(10)
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: false })
    expect(evaluator.status().instances[0]?.clearedFor).toBeUndefined()
  })

  it('an accumulator keeps accumulating while disabled, so its total includes that time', () => {
    const genset = valid({
      ...portOil,
      signal: { path: RPM },
      detector: { type: 'accumulator', measure: 'time', steps: [{ limit: 100, priority: 'alarm' }] }
    })
    const { at, log, evaluator, setDisabled } = setup(genset)
    at(0, RPM, 30)
    at(40)
    setDisabled(40, true)
    at(110)
    expect(log).toEqual([])
    expect(evaluator.accumulators()).toEqual(new Map([['', 110]]))
    setDisabled(120, false)
    expect(log).toEqual([[120, 'raise', '', 'alarm']])
  })

  it('a transition match raises nothing, and its clear time is the last transition', () => {
    const { at, log, evaluator } = setup(engineStopped, { disabled: true })
    at(0, 'propulsion.port.state', 'started')
    at(5, 'propulsion.port.state', 'stopped')
    at(10, 'propulsion.port.state', 'started')
    at(15, 'propulsion.port.state', 'stopped')
    at(40)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: false,
      clearedFor: 25
    })
  })

  it('clears an alert adopted at start rather than keep it', () => {
    const { log } = setup(portOil, { disabled: true, adopted: [{}] })
    expect(log).toEqual([[0, 'clear', '']])
  })

  it('an adopted condition is assumed until its input reports', () => {
    const { at, evaluator, setDisabled } = setup(portOil, { adopted: [{}] })
    at(50)
    setDisabled(100, true)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: true,
      conditionAssumed: true
    })
    at(110, OIL, 0)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: true,
      conditionAssumed: false
    })
  })

  it("a timeout rule's adopted condition is judged from its input's silence", () => {
    const { at, evaluator, setDisabled } = setup(depthTimeout, { adopted: [{}] })
    at(50)
    setDisabled(100, true)
    expect(evaluator.status().instances[0]).toMatchObject({
      conditionPresent: true,
      conditionAssumed: false
    })
  })

  it('an edit of a disabled rule, in place or structural, raises nothing', () => {
    const AUX_OIL = 'propulsion.aux.oilPressure'
    const { at, log, evaluator } = setup(portOil, { disabled: true })
    at(0, OIL, 0)
    at(10)
    evaluator.update(valid({ ...portOil, detector: { ...portOil.detector, duration: 1 } }))
    evaluator.update(
      valid({
        ...portOil,
        signal: { path: AUX_OIL },
        detector: { ...portOil.detector, duration: 1 }
      })
    )
    at(20, AUX_OIL, 0)
    at(30)
    expect(log).toEqual([])
    expect(evaluator.status().instances[0]).toMatchObject({ conditionPresent: true })
  })
})
