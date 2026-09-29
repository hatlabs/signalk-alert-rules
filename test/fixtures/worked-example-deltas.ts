// Recorded self-vessel values for each worked example, in publish order, and
// the last reading each of the rule's signals should report per instance.
// `signal` is the rule signal; `gate<N>` is the Nth gate's signal.

import type { PathValueState, Value } from '@signalk/server-api'
import type { PathMeta } from '../../src/engine/evaluator.js'
import type { Reading } from '../../src/engine/signals.js'

export interface Recorded {
  path: string
  source: string
  value: Value
  state?: PathValueState
}

export interface Expected {
  signal: string
  instance?: string
  reading: Reading
}

export interface WorkedExampleDeltas {
  /** Source ranking for the preferred-source filter, best first. */
  ranking?: string[]
  /** Path meta, such as zones, the server would hold. */
  meta?: Record<string, PathMeta>
  deltas: Recorded[]
  expected: Expected[]
}

const DEG = Math.PI / 180
const timedOut: PathValueState = { timedOut: true }

function value(v: Extract<Reading, { available: true }>['value']): Reading {
  return { available: true, value: v }
}

export const workedExampleDeltas: Record<string, WorkedExampleDeltas> = {
  batteryLowFromZones: {
    meta: {
      'electrical.batteries.house.voltage': {
        zones: [
          { upper: 11.5, state: 'alarm' },
          { lower: 11.5, upper: 12, state: 'warn' }
        ]
      }
    },
    deltas: [
      { path: 'electrical.batteries.house.voltage', source: 'bmv.0', value: 12.4 },
      { path: 'electrical.batteries.house.voltage', source: 'bmv.0', value: 11.8 }
    ],
    expected: [{ signal: 'signal', reading: value(11.8) }]
  },
  bilgePumpCyclesPerHour: {
    deltas: [
      { path: 'electrical.switches.bilgePump.state', source: 'relay.1', value: true },
      { path: 'electrical.switches.bilgePump.state', source: 'relay.1', value: false }
    ],
    expected: [{ signal: 'signal', reading: value(false) }]
  },
  engineHoursSinceService: {
    deltas: [{ path: 'propulsion.main.revolutions', source: 'n2k.10', value: 28.3 }],
    expected: [{ signal: 'signal', reading: value(28.3) }]
  },
  coolantTemperatureTrend: {
    deltas: [
      { path: 'propulsion.port.coolantTemperature', source: 'n2k.10', value: 350.1 },
      { path: 'propulsion.starboard.coolantTemperature', source: 'n2k.11', value: 351.4 },
      { path: 'propulsion.port.revolutions', source: 'n2k.10', value: 30 },
      { path: 'propulsion.starboard.revolutions', source: 'n2k.11', value: null, state: timedOut }
    ],
    expected: [
      { signal: 'signal', instance: 'port', reading: value(350.1) },
      { signal: 'signal', instance: 'starboard', reading: value(351.4) },
      { signal: 'gate0', instance: 'port', reading: value(30) },
      { signal: 'gate0', instance: 'starboard', reading: { available: false, timedOut: true } }
    ]
  },
  freshWaterProjectedEmpty: {
    deltas: [
      { path: 'tanks.freshWater.0.currentLevel', source: 'tank.0', value: 0.42 },
      { path: 'tanks.freshWater.0.currentLevel', source: 'tank.0', value: 0.41 }
    ],
    expected: [{ signal: 'signal', reading: value(0.41) }]
  },
  twinEngineRpmDifference: {
    deltas: [
      { path: 'propulsion.port.revolutions', source: 'n2k.10', value: 30 },
      { path: 'propulsion.starboard.revolutions', source: 'n2k.11', value: 26 }
    ],
    expected: [
      { signal: 'signal', reading: value(4) },
      { signal: 'gate0', reading: value(30) },
      { signal: 'gate1', reading: value(26) }
    ]
  },
  gnssPositionSpread: {
    ranking: ['gnss.mast', 'gnss.bow', 'gnss.stern'],
    deltas: [
      { path: 'navigation.position', source: 'gnss.bow', value: { latitude: 60, longitude: 25 } },
      {
        path: 'navigation.position',
        source: 'gnss.stern',
        value: { latitude: 60.0001, longitude: 25 }
      },
      {
        path: 'navigation.position',
        source: 'gnss.mast',
        value: { latitude: 60.0002, longitude: 25 }
      }
    ],
    // 0.0002° of latitude on the mean-radius sphere.
    expected: [{ signal: 'signal', reading: value((6371008.8 * 0.0002 * Math.PI) / 180) }]
  },
  watchAcknowledgementAbsent: {
    deltas: [{ path: 'navigation.watch.acknowledged', source: 'panel', value: true }],
    expected: [{ signal: 'signal', reading: value(true) }]
  },
  headingDifference: {
    ranking: ['compass.a', 'compass.b'],
    deltas: [
      { path: 'navigation.headingMagnetic', source: 'compass.a', value: 358 * DEG },
      { path: 'navigation.headingMagnetic', source: 'compass.b', value: 3 * DEG }
    ],
    expected: [{ signal: 'signal', reading: value(5 * DEG) }]
  },
  engineStateChange: {
    deltas: [
      { path: 'propulsion.port.state', source: 'n2k.10', value: 'started' },
      { path: 'propulsion.port.state', source: 'n2k.10', value: 'stopped' }
    ],
    expected: [{ signal: 'signal', instance: 'port', reading: value('stopped') }]
  },
  depthSensorTimeout: {
    deltas: [
      { path: 'environment.depth.belowTransducer', source: 'n2k.35', value: 7.3 },
      { path: 'environment.depth.belowTransducer', source: 'n2k.35', value: null, state: timedOut }
    ],
    expected: [{ signal: 'signal', reading: { available: false, timedOut: true } }]
  }
}
