import { describe, it, expect } from 'vitest'
import type { PathValueState, Value } from '@signalk/server-api'
import {
  RuleEvaluator,
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
  /** Values already in the server's delta cache when the rule starts. */
  cached?: [string, Value][]
}

type Logged = [number, string, string, string?]

function setup(rule: Rule, options: Options = {}) {
  const sm = new FakeSubscriptionManager()
  const meta = new Map(Object.entries(options.meta ?? {}))
  let now = 0
  const log: Logged[] = []
  const events: RuleEvent[] = []
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
    options.adopted
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

  it('entering warn raises at warning, and entering alarm while active escalates the same alert', () => {
    const { at, log, events, evaluator } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.8)
    at(30)
    expect(evaluator.status().instances[0]).toMatchObject({ level: 'warn', priority: 'warning' })
    at(40, VOLTAGE, 11.3)
    at(69)
    at(70)
    expect(log).toEqual([
      [30, 'raise', '', 'warning'],
      [70, 'priority', '', 'alarm']
    ])
    expect(events.at(-1)?.instance).toBeUndefined()
    expect(evaluator.status().instances[0]).toMatchObject({ level: 'alarm', priority: 'alarm' })
  })

  it('falling from alarm back to warn reports warning, and the condition ends only when warn clears', () => {
    const { at, log, evaluator } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.3)
    at(30)
    at(40, VOLTAGE, 11.55)
    at(100)
    at(110, VOLTAGE, 11.8)
    at(120)
    expect(evaluator.status().instances[0]).toMatchObject({ active: true, level: 'warn' })
    at(130, VOLTAGE, 12.05)
    at(200)
    at(210, VOLTAGE, 12.2)
    at(220)
    expect(log).toEqual([
      [30, 'raise', '', 'alarm'],
      [120, 'priority', '', 'warning'],
      [220, 'clear', '']
    ])
    expect(evaluator.status().instances[0]).toMatchObject({ active: false })
    expect(evaluator.status().instances[0]?.level).toBeUndefined()
    expect(evaluator.status().instances[0]?.priority).toBeUndefined()
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
    expect(evaluator.status().instances[0]).toMatchObject({ level: 'alarm', priority: 'alarm' })
  })

  it('a fixed-limit rule reports its own priority and no level', () => {
    const { at, evaluator } = setup({ ...oilPressure, gates: undefined })
    at(0, OIL, 0)
    at(5)
    expect(evaluator.status().instances[0]).toMatchObject({ active: true, priority: 'alarm' })
    expect(evaluator.status().instances[0]?.level).toBeUndefined()
  })

  it('an adopted zone-limit alert holds its named level until a more severe one is entered', () => {
    const { at, log, evaluator } = setup(escalating, { ...zoned, adopted: [{}] })
    expect(evaluator.status().instances[0]).toMatchObject({ active: true, level: 'warn' })
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

  it('a zone edit that removes the held more severe level returns the alert to its named level', () => {
    const { at, log, meta, evaluator } = setup(escalating, zoned)
    at(0, VOLTAGE, 11.3)
    at(30)
    meta.set(VOLTAGE, { zones: [{ upper: 12, state: 'warn' }] })
    at(31)
    expect(log).toEqual([
      [30, 'raise', '', 'alarm'],
      [31, 'priority', '', 'warning']
    ])
    expect(evaluator.status().instances[0]).toMatchObject({ level: 'warn', priority: 'warning' })
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
    expect(evaluator.status().instances[0]?.inactive).toMatch(/no warn zone/)
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
    expect(evaluator.status().instances[0]).toMatchObject({ level: 'alarm', priority: 'alarm' })
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
    expect(evaluator.status().instances[0]).toMatchObject({ level: 'alert', priority: 'caution' })
  })
})

const RPM = 'propulsion.main.revolutions'
const OIL = 'propulsion.main.oilPressure'
const oilPressure = valid({
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
      priority: 'alarm',
      signal: { path: HIGH_WATER },
      detector: { type: 'match', op: 'equals', value: true },
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
      gateInputUnavailable: true
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
    expect(evaluator.status().instances[0]?.gateInputUnavailable).toBe(true)
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
      priority: 'caution',
      signal: { path: RPM },
      detector: { type: 'accumulator', measure: 'time', limit: 100 },
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
  priority: 'warning',
  signal: { path: DEPTH },
  detector: { type: 'match', op: 'timedOut', duration: 30 }
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
    [{ enforce: false, useDefaults: true }, {}, /does not enforce data timeouts/],
    [
      { enforce: true, useDefaults: false },
      {},
      /no timeout and the server's default timeouts are off/
    ],
    [ENFORCED, { updateContract: 'event' }, /update contract is event/],
    [ENFORCED, { timeout: 0 }, /meta.timeout/]
  ])(
    'are inactive when the server can never time the path out (%o, %o)',
    (settings, meta, reason) => {
      const { at, log, evaluator } = setup(depthTimeout, { settings, meta: { [DEPTH]: meta } })
      at(0, DEPTH, 7.3)
      at(1000)
      expect(log).toEqual([])
      expect(evaluator.status().instances[0]?.inactive).toMatch(reason)
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
    priority: 'warning',
    signal: { path: 'propulsion.*.coolantTemperature' },
    detector: {
      type: 'sustained',
      direction: 'above',
      limit: { kind: 'fixed', value: 368 }
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

describe('pulses', () => {
  it('a transition match raises and clears at once', () => {
    const rule = valid({
      name: 'Engine stopped',
      slug: 'engine-stopped',
      message: 'Engine {instance} stopped',
      priority: 'warning',
      signal: { path: 'propulsion.*.state' },
      detector: { type: 'match', op: 'changesTo', value: 'stopped' }
    })
    const { at, log } = setup(rule)
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
      (r) => ({ ...r, detector: { type: 'match', op: 'equals', value: 0 } }),
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
      priority: 'alarm',
      signal: { path: PUMP },
      detector: { type: 'count', event: { op: 'changesTo', value: true }, window: 600, limit: 1 }
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
      detector: { ...oilPressure.detector, limit: { kind: 'fixed', value: 50000 } }
    } as Rule)
    expect(log).toEqual([])
    at(31)
    evaluator.update({
      ...oilPressure,
      detector: { ...oilPressure.detector, limit: { kind: 'fixed', value: -1 } }
    } as Rule)
    expect(log).toEqual([[31, 'clear', '']])
  })

  it('a priority edit takes effect at the next raise', () => {
    const { evaluator, log, at } = raised()
    at(30)
    evaluator.update({ ...oilPressure, priority: 'emergency' })
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
      priority: 'warning',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 360 } },
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
    expect(of('port')).toMatchObject({ active: true, inUse: true })
    expect(of('starboard')).toMatchObject({ active: false, inUse: false })
  })

  it('a wildcard adopted instance is kept until its own gate input reports', () => {
    const rule = valid({
      name: 'Coolant temperature high',
      slug: 'coolant-high',
      message: 'Coolant temperature is high on {instance}',
      priority: 'warning',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } },
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
    priority: 'caution',
    signal: { path: RPM },
    detector: { type: 'accumulator', measure: 'time', limit: 100 }
  })

  const running = (rule: Rule) => {
    const s = setup(rule)
    for (let t = 0; t <= 60; t += 10) s.at(t, RPM, 30)
    return s
  }

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
      detector: { ...genset.detector, measure: 'integral', limit: 3000 }
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
      priority: 'alarm',
      signal: { path: 'propulsion.*.oilPressure' },
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 100000 } }
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
    expect(evaluator.status().instances[0]?.inactive).toMatch(/no alarm zone/)
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
    expect(evaluator.status().instances[0]?.active).toBe(false)
  })

  it('a gate reporting after its adopted alert cleared still waits for its duration', () => {
    const rule = valid({
      name: 'Coolant temperature high',
      slug: 'coolant-high',
      message: 'Coolant temperature is high on {instance}',
      priority: 'warning',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } },
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
      priority: 'warning',
      signal: { path: 'propulsion.*.coolantTemperature' },
      detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } },
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
    expect(evaluator.status().instances.find((i) => i.instance?.segment === 'port')?.active).toBe(
      true
    )
  })
})
