// One scenario per worked example in examples/rules: self-vessel values over
// time, chosen so the rule raises and, where its condition can end, clears,
// and the alert sequence SKAR sends to core in response. docs/rules.md
// summarises these sequences under "Worked examples"; keep the two in sync.

import type { PathValueState, Value } from '@signalk/server-api'
import type { PathMeta } from '../../src/engine/evaluator.js'
import type { Priority } from '../../src/model/rule.js'

export interface Timed {
  /** Seconds since the plugin started. */
  t: number
  path: string
  source: string
  value: Value
  state?: PathValueState
}

/**
 * One alert emission as core receives it: a raise, a priority change of an
 * active alert, or the report that its condition ended. Heartbeats are left
 * out. The path is under `alerts.`.
 */
export type AlertStep =
  | [t: number, event: 'raise' | 'priority', path: string, priority: Priority]
  | [t: number, event: 'clear', path: string]

export interface Scenario {
  /** Source ranking for the preferred-source filter, best first. */
  ranking?: string[]
  /** Path meta, such as zones, the server holds. */
  meta?: Record<string, PathMeta>
  /** Seconds between evaluation ticks; transitions land on a tick or a sample. */
  tick: number
  /** Last tick, in seconds since start. */
  until: number
  deltas: Timed[]
  expected: AlertStep[]
}

const HOUR = 3600
const DEG = Math.PI / 180

function at(t: number, path: string, value: Value, source = 'sensor'): Timed {
  return { t, path, source, value }
}

function timedOut(t: number, path: string, source = 'sensor'): Timed {
  return { t, path, source, value: null, state: { timedOut: true } }
}

/** A sample every `step` seconds from `from` up to but not including `to`. */
function every(
  step: number,
  from: number,
  to: number,
  sample: (t: number) => Timed | Timed[]
): Timed[] {
  const samples: Timed[] = []
  for (let t = from; t < to; t += step) samples.push(...[sample(t)].flat())
  return samples
}

const VOLTAGE = 'electrical.batteries.house.voltage'
const PUMP = 'electrical.switches.bilgePump.state'
const RPM = 'propulsion.main.revolutions'
const PORT_RPM = 'propulsion.port.revolutions'
const STBD_RPM = 'propulsion.starboard.revolutions'
const PORT_COOLANT = 'propulsion.port.coolantTemperature'
const STBD_COOLANT = 'propulsion.starboard.coolantTemperature'
const FRESH_WATER = 'tanks.freshWater.0.currentLevel'
const POSITION = 'navigation.position'
const WATCH = 'navigation.watch.acknowledged'
const HEADING = 'navigation.headingMagnetic'
const DEPTH = 'environment.depth.belowTransducer'

/** The alert path, under `alerts.`, of a rule's alert. */
const alert = (slug: string, instance?: string) =>
  ['rules', slug, ...(instance === undefined ? [] : [instance])].join('.')

export const exampleScenarios: Record<string, Scenario> = {
  // Zones: warn below 12 V, alarm below 11.5 V. Each level must hold for 60 s,
  // and clears 30 s after the voltage is 0.2 V back above its threshold.
  'house-battery-low': {
    meta: {
      [VOLTAGE]: {
        zones: [
          { upper: 11.5, state: 'alarm' },
          { lower: 11.5, upper: 12, state: 'warn' }
        ]
      }
    },
    tick: 1,
    until: 400,
    deltas: [
      at(0, VOLTAGE, 12.6),
      at(10, VOLTAGE, 11.8),
      at(100, VOLTAGE, 11.3),
      at(200, VOLTAGE, 12.1),
      at(300, VOLTAGE, 12.4)
    ],
    expected: [
      [70, 'raise', alert('house-battery-low'), 'warning'],
      [160, 'priority', alert('house-battery-low'), 'alarm'],
      [230, 'priority', alert('house-battery-low'), 'warning'],
      [330, 'clear', alert('house-battery-low')]
    ]
  },

  // Five pump starts within an hour, one every ten minutes; then the pump stays off.
  'bilge-pump-cycling': {
    tick: 10,
    until: 2 * HOUR,
    deltas: every(600, 0, 3000, (t) => [at(t, PUMP, true), at(t + 60, PUMP, false)]),
    expected: [
      [2400, 'raise', alert('bilge-pump-cycling'), 'warning'],
      [3600, 'clear', alert('bilge-pump-cycling')]
    ]
  },

  // The engine runs 200 h, is stopped 10 h, and runs again; revolutions are
  // reported every minute. Only running time counts toward the 250 h.
  'engine-service-due': {
    tick: 60,
    until: 262 * HOUR,
    deltas: [
      ...every(60, 0, 200 * HOUR, (t) => at(t, RPM, 30)),
      ...every(60, 200 * HOUR, 210 * HOUR, (t) => at(t, RPM, 0)),
      ...every(60, 210 * HOUR, 262 * HOUR, (t) => at(t, RPM, 30))
    ],
    expected: [[260 * HOUR, 'raise', alert('engine-service-due'), 'caution']]
  },

  // Both engines run. Port coolant is steady for 5 min, then climbs 3 K per
  // minute up to 370 K; starboard stays steady. The port engine stops at
  // 600 s while its coolant is still climbing.
  'coolant-temperature-rising': {
    tick: 10,
    until: 1200,
    deltas: [
      ...every(10, 0, 600, (t) => [at(t, PORT_RPM, 30), at(t, STBD_RPM, 30)]),
      ...every(10, 600, 1200, (t) => [at(t, PORT_RPM, 0), at(t, STBD_RPM, 30)]),
      ...every(10, 0, 1200, (t) => [
        at(t, PORT_COOLANT, t < 300 ? 350 : Math.min(350 + 0.05 * (t - 300), 370)),
        at(t, STBD_COOLANT, 350)
      ])
    ],
    expected: [
      [440, 'raise', alert('coolant-temperature-rising', 'port'), 'warning'],
      [600, 'clear', alert('coolant-temperature-rising', 'port')]
    ]
  },

  // The tank holds steady for 30 min, drains at 0.36 per hour for 40 min, and
  // then holds steady again.
  'fresh-water-running-out': {
    tick: 60,
    until: 4 * HOUR,
    deltas: every(60, 0, 4 * HOUR, (t) => {
      const draining = Math.min(Math.max(t - 1800, 0), 2400)
      return at(t, FRESH_WATER, 0.6 - 0.0001 * draining)
    }),
    expected: [
      [2880, 'raise', alert('fresh-water-running-out'), 'caution'],
      [5220, 'clear', alert('fresh-water-running-out')]
    ]
  },

  // Both engines at 20 Hz; the starboard engine drops to 15 Hz at 60 s and
  // comes back to 19 Hz at 150 s.
  'engine-rpm-mismatch': {
    tick: 1,
    until: 200,
    deltas: [at(0, PORT_RPM, 20), at(0, STBD_RPM, 20), at(60, STBD_RPM, 15), at(150, STBD_RPM, 19)],
    expected: [
      [90, 'raise', alert('engine-rpm-mismatch'), 'caution'],
      [150, 'clear', alert('engine-rpm-mismatch')]
    ]
  },

  // Three receivers agree within about 20 m; the mast receiver jumps about
  // 110 m north at 30 s and returns at 100 s.
  'gnss-disagree': {
    ranking: ['gnss.mast', 'gnss.bow', 'gnss.stern'],
    tick: 1,
    until: 150,
    deltas: [
      at(0, POSITION, { latitude: 60, longitude: 25 }, 'gnss.bow'),
      at(0, POSITION, { latitude: 60.0001, longitude: 25 }, 'gnss.stern'),
      at(0, POSITION, { latitude: 60.0002, longitude: 25 }, 'gnss.mast'),
      at(30, POSITION, { latitude: 60.0012, longitude: 25 }, 'gnss.mast'),
      at(100, POSITION, { latitude: 60.0002, longitude: 25 }, 'gnss.mast')
    ],
    expected: [
      [50, 'raise', alert('gnss-disagree'), 'warning'],
      [100, 'clear', alert('gnss-disagree')]
    ]
  },

  // The watchkeeper acknowledges at 300 s and 600 s, then not until 1600 s.
  'watch-not-acknowledged': {
    tick: 10,
    until: 1800,
    deltas: [at(300, WATCH, true), at(600, WATCH, false), at(1600, WATCH, true)],
    expected: [
      [1500, 'raise', alert('watch-not-acknowledged'), 'alarm'],
      [1600, 'clear', alert('watch-not-acknowledged')]
    ]
  },

  // Headings 358° and 3° are 5° apart across north. Compass B drifts to 5°
  // (7° apart) at 30 s and back to 1° (3° apart) at 150 s.
  'compasses-disagree': {
    ranking: ['compass.a', 'compass.b'],
    tick: 1,
    until: 200,
    deltas: [
      at(0, HEADING, 358 * DEG, 'compass.a'),
      at(0, HEADING, 3 * DEG, 'compass.b'),
      at(30, HEADING, 5 * DEG, 'compass.b'),
      at(150, HEADING, 1 * DEG, 'compass.b')
    ],
    expected: [
      [90, 'raise', alert('compasses-disagree'), 'caution'],
      [150, 'clear', alert('compasses-disagree')]
    ]
  },

  // Port starts, starboard first reports that it is stopped, and port stops at 600 s.
  'engine-stopped': {
    tick: 10,
    until: 700,
    deltas: [
      at(0, 'propulsion.port.state', 'started'),
      at(0, 'propulsion.starboard.state', 'stopped'),
      at(600, 'propulsion.port.state', 'stopped')
    ],
    // A latching raise is the whole occurrence: nothing clears it.
    expected: [[600, 'raise', alert('engine-stopped', 'port'), 'warning']]
  },

  // Depth reports every 10 s until core marks it timed out at 30 s; it
  // reports again from 90 s.
  'depth-sensor-silent': {
    tick: 1,
    until: 120,
    deltas: [
      ...every(10, 0, 30, (t) => at(t, DEPTH, 7.3)),
      timedOut(30, DEPTH),
      ...every(10, 90, 120, (t) => at(t, DEPTH, 7.1))
    ],
    expected: [
      [60, 'raise', alert('depth-sensor-silent'), 'warning'],
      [90, 'clear', alert('depth-sensor-silent')]
    ]
  }
}
