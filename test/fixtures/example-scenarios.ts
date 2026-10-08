// One scenario per worked example in examples/rules: self-vessel values over
// time, chosen so the rule raises and, where its condition can end, clears,
// and the alert sequence SKAR sends to core in response. docs/rules.md
// summarises these sequences under "Worked examples"; keep the two in sync.

import { HOUR, at, every, timedOut, type Scenario } from '../helpers/scenario.js'

const DEG = Math.PI / 180

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
const FREQUENCY = 'electrical.ac.shore.phase.single.frequency'

// Each example's alert path, the default its input and detector give unless
// the rule names one.
const ALERT_PATHS: Record<string, string> = {
  'bilge-pump-cycling': 'electrical.switches.bilgePump.stateFrequent',
  'compasses-disagree': 'navigation.compassesDisagree',
  'coolant-temperature-rising': 'propulsion.*.coolantTemperatureRising',
  'depth-sensor-silent': 'environment.depth.belowTransducerTimedOut',
  'engine-rpm-mismatch': 'propulsion.revolutionsMismatch',
  'engine-service-due': 'propulsion.main.revolutionsAccumulated',
  'engine-stopped': 'propulsion.*.stateChanged',
  'fresh-water-running-out': 'tanks.freshWater.0.currentLevelProjectedLow',
  'gnss-disagree': 'navigation.gnssDisagree',
  'house-battery-low': 'electrical.batteries.house.voltageLow',
  'shore-power-frequency': 'electrical.ac.shore.phase.single.frequencyOutOfRange',
  'watch-not-acknowledged': 'navigation.watch.acknowledgedMissing'
}

/** The alert path, under `alerts.`, of a rule's alert. */
const alert = (slug: string, instance?: string) =>
  (ALERT_PATHS[slug] ?? '').replace('*', instance ?? '*')

export const exampleScenarios: Record<string, Scenario> = {
  // Zones: warn below 12 V, alarm below 11.5 V. Each level must hold for 60 s,
  // and clears once the voltage is 0.2 V back above its threshold.
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
      [300, 'clear', alert('house-battery-low')]
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
  },

  // Warning outside 49-51 Hz, alarm outside 48-52 Hz, each held for 10 s;
  // clears once the frequency is 0.2 Hz inside 49-51 Hz. It goes high,
  // past the alarm range, to the low side, back to 50.9 Hz (inside the range
  // but within the hysteresis) and to 50.1 Hz.
  'shore-power-frequency': {
    tick: 1,
    until: 300,
    deltas: [
      at(0, FREQUENCY, 50),
      at(10, FREQUENCY, 51.4),
      at(60, FREQUENCY, 52.5),
      at(120, FREQUENCY, 47.6),
      at(180, FREQUENCY, 50.9),
      at(240, FREQUENCY, 50.1)
    ],
    // The move to the low side changes {limit} in the message but sends no event.
    expected: [
      [20, 'raise', alert('shore-power-frequency'), 'warning'],
      [70, 'priority', alert('shore-power-frequency'), 'alarm'],
      [240, 'clear', alert('shore-power-frequency')]
    ]
  }
}
