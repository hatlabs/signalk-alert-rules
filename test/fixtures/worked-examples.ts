// The worked examples named in the MVP success criteria, one per detector,
// gate and combinator family. Later units evaluate the same rules.

const HOUR = 3600

export const workedExamples: Record<string, unknown> = {
  batteryLowFromZones: {
    name: 'House battery low',
    slug: 'house-battery-low',
    message: 'House battery voltage is low',
    priority: 'fromZone',
    signal: { path: 'electrical.batteries.house.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'zone', level: 'warn' },
      duration: 60,
      hysteresis: 0.2,
      clearDuration: 30
    }
  },
  bilgePumpCyclesPerHour: {
    name: 'Bilge pump cycling',
    slug: 'bilge-pump-cycling',
    message: 'Bilge pump is running often',
    priority: 'warning',
    signal: { path: 'electrical.switches.bilgePump.state' },
    detector: {
      type: 'count',
      event: { op: 'changesTo', value: true },
      window: HOUR,
      limit: 4
    }
  },
  engineHoursSinceService: {
    name: 'Engine service due',
    slug: 'engine-service-due',
    message: 'Engine service is due',
    priority: 'caution',
    signal: { path: 'propulsion.main.revolutions' },
    detector: {
      type: 'accumulator',
      measure: 'time',
      while: { op: 'above', value: 0 },
      limit: 250 * HOUR
    }
  },
  coolantTemperatureTrend: {
    name: 'Coolant temperature rising',
    slug: 'coolant-temperature-rising',
    message: 'Coolant temperature is rising fast on {instance}',
    priority: 'warning',
    signal: { path: 'propulsion.*.coolantTemperature' },
    detector: { type: 'slope', direction: 'rising', window: 300, limit: 0.02 },
    gates: [
      {
        signal: { path: 'propulsion.*.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 5 }
      }
    ]
  },
  freshWaterProjectedEmpty: {
    name: 'Fresh water running out',
    slug: 'fresh-water-running-out',
    message: 'Fresh water tank will be empty soon',
    priority: 'caution',
    signal: { path: 'tanks.freshWater.0.currentLevel' },
    detector: {
      type: 'projection',
      direction: 'falling',
      limit: { kind: 'fixed', value: 0.05 },
      window: 1800,
      horizon: 2 * HOUR
    }
  },
  twinEngineRpmDifference: {
    name: 'Engine RPM mismatch',
    slug: 'engine-rpm-mismatch',
    message: 'Port and starboard engine speeds differ',
    priority: 'caution',
    signal: {
      combinator: 'absDifference',
      inputs: [
        { path: 'propulsion.port.revolutions' },
        { path: 'propulsion.starboard.revolutions' }
      ]
    },
    detector: {
      type: 'sustained',
      direction: 'above',
      limit: { kind: 'fixed', value: 3 },
      duration: 30
    },
    gates: [
      {
        signal: { path: 'propulsion.port.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 8 },
        duration: 10
      },
      {
        signal: { path: 'propulsion.starboard.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 8 },
        duration: 10
      }
    ]
  },
  gnssPositionSpread: {
    name: 'GNSS receivers disagree',
    slug: 'gnss-disagree',
    message: 'GNSS positions disagree',
    priority: 'warning',
    signal: {
      combinator: 'positionSpread',
      inputs: [
        { path: 'navigation.position', source: 'gnss.bow' },
        { path: 'navigation.position', source: 'gnss.stern' },
        { path: 'navigation.position', source: 'gnss.mast' }
      ]
    },
    detector: {
      type: 'sustained',
      direction: 'above',
      limit: { kind: 'fixed', value: 50 },
      duration: 20
    }
  },
  watchAcknowledgementAbsent: {
    name: 'Watch not acknowledged',
    slug: 'watch-not-acknowledged',
    message: 'No watch acknowledgement received',
    priority: 'alarm',
    latching: true,
    signal: { path: 'navigation.watch.acknowledged' },
    detector: { type: 'absence', event: { op: 'changes' }, within: 900 }
  },
  headingDifference: {
    name: 'Compasses disagree',
    slug: 'compasses-disagree',
    message: 'Compass headings disagree',
    priority: 'caution',
    signal: {
      combinator: 'absDifference',
      angular: true,
      inputs: [
        { path: 'navigation.headingMagnetic', source: 'compass.a' },
        { path: 'navigation.headingMagnetic', source: 'compass.b' }
      ]
    },
    detector: {
      type: 'sustained',
      direction: 'above',
      limit: { kind: 'fixed', value: 0.1 },
      duration: 60
    }
  },
  engineStateChange: {
    name: 'Engine stopped',
    slug: 'engine-stopped',
    message: 'Engine {instance} stopped',
    priority: 'warning',
    signal: { path: 'propulsion.*.state' },
    detector: { type: 'match', op: 'changesTo', value: 'stopped' }
  },
  depthSensorTimeout: {
    name: 'Depth sensor silent',
    slug: 'depth-sensor-silent',
    message: 'No depth data',
    priority: 'warning',
    signal: { path: 'environment.depth.belowTransducer' },
    detector: { type: 'match', op: 'timedOut', duration: 30 }
  }
}
