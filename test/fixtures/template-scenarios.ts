// One scenario per template in templates/builtin.yaml, keyed by template id:
// the pick the template is used with, self-vessel values over time, and the
// alert sequence SKAR sends to core. Each sequence climbs through every step
// the template has, and clears where its condition can end. A worked
// example's values are reused where the template watches the same path the
// same way.

import type { TemplatePick } from '../../src/model/rule.js'
import { HOUR, at, every, timedOut, type Scenario } from '../helpers/scenario.js'
import { exampleScenarios } from './example-scenarios.js'

export interface TemplateScenario {
  pick: TemplatePick
  scenario: Scenario
}

const HOUSE_VOLTAGE = 'electrical.batteries.house.voltage'
const HOUSE_SOC = 'electrical.batteries.house.capacity.stateOfCharge'
const MAIN_RPM = 'propulsion.main.revolutions'
const PUMP = 'electrical.switches.bilgePump.state'
const DEPTH = 'environment.depth.belowTransducer'
const POSITION = 'navigation.position'

/** A value per sample time, all on one path, at one-second ticks. */
function series(path: string, until: number, samples: [t: number, value: number][]): Scenario {
  return {
    tick: 1,
    until,
    deltas: samples.map(([t, value]) => at(t, path, value)),
    expected: []
  }
}

/** An engine that is stopped at 0 s and runs at `hz` from 10 s on. */
function engineRunning(hz: number, until: number) {
  return [at(0, MAIN_RPM, 0), ...every(10, 10, until, (t) => at(t, MAIN_RPM, hz))]
}

export const templateScenarios: Record<string, TemplateScenario> = {
  // Below 12.2 V from 10 s, below 11.8 V from 100 s. 12.25 V at 200 s is
  // within the 0.1 V the voltage must recover by, so only 12.4 V clears.
  'battery-voltage-low': {
    pick: { instance: 'house' },
    scenario: {
      ...series(HOUSE_VOLTAGE, 400, [
        [0, 12.6],
        [10, 12.0],
        [100, 11.6],
        [200, 12.25],
        [300, 12.4]
      ]),
      expected: [
        [70, 'raise', 'electrical.batteries.house.voltageLow', 'warning'],
        [160, 'priority', 'electrical.batteries.house.voltageLow', 'alarm'],
        [300, 'clear', 'electrical.batteries.house.voltageLow']
      ]
    }
  },

  'battery-voltage-low-lifepo4': {
    pick: { instance: 'house' },
    scenario: {
      ...series(HOUSE_VOLTAGE, 300, [
        [0, 13.2],
        [10, 12.7],
        [100, 11.9],
        [200, 13.3]
      ]),
      expected: [
        [70, 'raise', 'electrical.batteries.house.voltageLow', 'warning'],
        [160, 'priority', 'electrical.batteries.house.voltageLow', 'alarm'],
        [200, 'clear', 'electrical.batteries.house.voltageLow']
      ]
    }
  },

  'battery-voltage-high': {
    pick: { instance: 'house' },
    scenario: {
      ...series(HOUSE_VOLTAGE, 300, [
        [0, 13.8],
        [10, 15.2],
        [100, 15.7],
        [200, 14.2]
      ]),
      expected: [
        [40, 'raise', 'electrical.batteries.house.voltageHigh', 'warning'],
        [130, 'priority', 'electrical.batteries.house.voltageHigh', 'alarm'],
        [200, 'clear', 'electrical.batteries.house.voltageHigh']
      ]
    }
  },

  'battery-voltage-high-lifepo4': {
    pick: { instance: 'house' },
    scenario: {
      ...series(HOUSE_VOLTAGE, 200, [
        [0, 13.4],
        [10, 14.7],
        [50, 14.9],
        [100, 13.5]
      ]),
      expected: [
        [20, 'raise', 'electrical.batteries.house.voltageHigh', 'warning'],
        [60, 'priority', 'electrical.batteries.house.voltageHigh', 'alarm'],
        [100, 'clear', 'electrical.batteries.house.voltageHigh']
      ]
    }
  },

  'battery-charge-low': {
    pick: { instance: 'house' },
    scenario: {
      ...series(HOUSE_SOC, 300, [
        [0, 0.8],
        [10, 0.25],
        [100, 0.1],
        [200, 0.5]
      ]),
      expected: [
        [70, 'raise', 'electrical.batteries.house.capacity.stateOfChargeLow', 'warning'],
        [160, 'priority', 'electrical.batteries.house.capacity.stateOfChargeLow', 'alarm'],
        [200, 'clear', 'electrical.batteries.house.capacity.stateOfChargeLow']
      ]
    }
  },

  // 367 K at 200 s is within the 2 K the temperature must fall by, so the
  // alert holds until 360 K.
  'engine-temperature-high': {
    pick: { instance: 'main' },
    scenario: {
      ...series('propulsion.main.temperature', 400, [
        [0, 350],
        [10, 370],
        [100, 375],
        [200, 367],
        [300, 360]
      ]),
      expected: [
        [40, 'raise', 'propulsion.main.temperatureHigh', 'warning'],
        [130, 'priority', 'propulsion.main.temperatureHigh', 'alarm'],
        [300, 'clear', 'propulsion.main.temperatureHigh']
      ]
    }
  },

  // No oil pressure while the engine is stopped at the start and at the end
  // raises nothing; only the drops while it runs do.
  'engine-oil-pressure-low': {
    pick: { instance: 'main' },
    scenario: {
      tick: 1,
      until: 500,
      deltas: [
        ...engineRunning(12, 400),
        at(400, MAIN_RPM, 0),
        at(0, 'propulsion.main.oilPressure', 0),
        at(10, 'propulsion.main.oilPressure', 300000),
        at(100, 'propulsion.main.oilPressure', 80000),
        at(200, 'propulsion.main.oilPressure', 40000),
        at(300, 'propulsion.main.oilPressure', 300000),
        at(400, 'propulsion.main.oilPressure', 0)
      ],
      expected: [
        [110, 'raise', 'propulsion.main.oilPressureLow', 'warning'],
        [210, 'priority', 'propulsion.main.oilPressureLow', 'alarm'],
        [300, 'clear', 'propulsion.main.oilPressureLow']
      ]
    }
  },

  // The engine stops at 700 s and the battery rests at 12.6 V for five
  // minutes, well past the two-minute duration, which raises nothing; only
  // the drop while it runs does.
  'alternator-not-charging': {
    pick: { instance: 'main' },
    scenario: {
      tick: 1,
      until: 1000,
      deltas: [
        ...engineRunning(15, 700),
        at(700, MAIN_RPM, 0),
        at(0, 'propulsion.main.alternatorVoltage', 12.6),
        at(20, 'propulsion.main.alternatorVoltage', 14.2),
        at(300, 'propulsion.main.alternatorVoltage', 12.7),
        at(600, 'propulsion.main.alternatorVoltage', 14.0),
        at(700, 'propulsion.main.alternatorVoltage', 12.6)
      ],
      expected: [
        [420, 'raise', 'propulsion.main.alternatorNotCharging', 'warning'],
        [600, 'clear', 'propulsion.main.alternatorNotCharging']
      ]
    }
  },

  // The worked example's engine, run on until the overdue step: 250 h of
  // running at 260 h, 275 h at 285 h. Running time never clears by itself.
  'engine-service-due': {
    pick: { instance: 'main' },
    scenario: {
      ...exampleScenarios['engine-service-due'],
      until: 290 * HOUR,
      deltas: [
        ...exampleScenarios['engine-service-due'].deltas,
        ...every(60, 262 * HOUR, 290 * HOUR, (t) => at(t, MAIN_RPM, 30))
      ],
      expected: [
        [260 * HOUR, 'raise', 'propulsion.main.serviceDue', 'caution'],
        [285 * HOUR, 'priority', 'propulsion.main.serviceDue', 'warning']
      ]
    }
  },

  // 0.26 at 200 s is within the 0.02 the level must recover by.
  'fuel-low': {
    pick: { instance: '0' },
    scenario: {
      ...series('tanks.fuel.0.currentLevel', 400, [
        [0, 0.5],
        [10, 0.2],
        [100, 0.05],
        [200, 0.26],
        [300, 0.4]
      ]),
      expected: [
        [70, 'raise', 'tanks.fuel.0.levelLow', 'caution'],
        [160, 'priority', 'tanks.fuel.0.levelLow', 'warning'],
        [300, 'clear', 'tanks.fuel.0.levelLow']
      ]
    }
  },

  'holding-tank-full': {
    pick: { instance: '0' },
    scenario: {
      ...series('tanks.blackWater.0.currentLevel', 300, [
        [0, 0.3],
        [10, 0.8],
        [100, 0.95],
        [200, 0.1]
      ]),
      expected: [
        [70, 'raise', 'tanks.blackWater.0.levelHigh', 'caution'],
        [160, 'priority', 'tanks.blackWater.0.levelHigh', 'warning'],
        [200, 'clear', 'tanks.blackWater.0.levelHigh']
      ]
    }
  },

  'fresh-water-low': {
    pick: { instance: '0' },
    scenario: {
      ...series('tanks.freshWater.0.currentLevel', 300, [
        [0, 0.6],
        [10, 0.2],
        [100, 0.05],
        [200, 0.8]
      ]),
      expected: [
        [70, 'raise', 'tanks.freshWater.0.levelLow', 'caution'],
        [160, 'priority', 'tanks.freshWater.0.levelLow', 'warning'],
        [200, 'clear', 'tanks.freshWater.0.levelLow']
      ]
    }
  },

  // A one-minute run raises nothing; the run from 600 s does once it has
  // lasted three minutes.
  'bilge-pump-running-long': {
    pick: { instance: 'bilgePump' },
    scenario: {
      tick: 10,
      until: 1000,
      deltas: [
        at(0, PUMP, false),
        at(60, PUMP, true),
        at(120, PUMP, false),
        at(600, PUMP, true),
        at(900, PUMP, false)
      ],
      expected: [
        [780, 'raise', 'electrical.switches.bilgePump.runningLong', 'alarm'],
        [900, 'clear', 'electrical.switches.bilgePump.runningLong']
      ]
    }
  },

  // The worked example's five starts within an hour, then, once they have
  // aged out, eleven starts two minutes apart from 6600 s: the fifth raises
  // the warning and the eleventh the alarm. It clears once the seventh,
  // at 7320 s, ages out and four starts are left in the hour.
  'bilge-pump-cycling': {
    pick: { instance: 'bilgePump' },
    scenario: {
      ...exampleScenarios['bilge-pump-cycling'],
      until: 4 * HOUR,
      deltas: [
        ...exampleScenarios['bilge-pump-cycling'].deltas,
        ...every(120, 6600, 7920, (t) => [at(t, PUMP, true), at(t + 60, PUMP, false)])
      ],
      expected: [
        [2400, 'raise', 'electrical.switches.bilgePump.cyclingOften', 'warning'],
        [3600, 'clear', 'electrical.switches.bilgePump.cyclingOften'],
        [7080, 'raise', 'electrical.switches.bilgePump.cyclingOften', 'warning'],
        [7800, 'priority', 'electrical.switches.bilgePump.cyclingOften', 'alarm'],
        [10920, 'clear', 'electrical.switches.bilgePump.cyclingOften']
      ]
    }
  },

  // 3.2 m at 40 s is within the 0.3 m the depth must recover by.
  'depth-shallow': {
    pick: {},
    scenario: {
      ...series(DEPTH, 100, [
        [0, 8],
        [10, 2.5],
        [20, 1.8],
        [30, 2.2],
        [40, 3.2],
        [50, 5]
      ]),
      expected: [
        [15, 'raise', 'environment.depth.belowTransducerLow', 'warning'],
        [25, 'priority', 'environment.depth.belowTransducerLow', 'alarm'],
        [50, 'clear', 'environment.depth.belowTransducerLow']
      ]
    }
  },

  // 12.3 m/s at 200 s is below the first step but within the 1 m/s the wind
  // must drop by, so only 11.5 m/s clears.
  'wind-strong': {
    pick: {},
    scenario: {
      ...series('environment.wind.speedApparent', 400, [
        [0, 5],
        [10, 14],
        [100, 18],
        [200, 12.3],
        [300, 11.5]
      ]),
      expected: [
        [70, 'raise', 'environment.wind.speedApparentHigh', 'caution'],
        [160, 'priority', 'environment.wind.speedApparentHigh', 'warning'],
        [300, 'clear', 'environment.wind.speedApparentHigh']
      ]
    }
  },

  'depth-not-reporting': {
    pick: {},
    scenario: {
      ...exampleScenarios['depth-sensor-silent'],
      expected: [
        [60, 'raise', 'environment.depth.belowTransducerNotReporting', 'warning'],
        [90, 'clear', 'environment.depth.belowTransducerNotReporting']
      ]
    }
  },

  // Position every 10 s until core marks it timed out at 30 s; it reports
  // again from 90 s.
  'position-not-reporting': {
    pick: {},
    scenario: {
      tick: 1,
      until: 120,
      deltas: [
        ...every(10, 0, 30, (t) => at(t, POSITION, { latitude: 60, longitude: 25 })),
        timedOut(30, POSITION),
        ...every(10, 90, 120, (t) => at(t, POSITION, { latitude: 60, longitude: 25 }))
      ],
      expected: [
        [60, 'raise', 'navigation.positionNotReporting', 'warning'],
        [90, 'clear', 'navigation.positionNotReporting']
      ]
    }
  }
}
