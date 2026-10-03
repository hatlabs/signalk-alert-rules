import { describe, expect, it } from 'vitest'
import { formatDuration } from '../../../src/format'
import type { RuleInfo } from '../../../src/panel/api'
import { alertsWhen, discardedTotals, ruleDisplay } from '../../../src/panel/rules/describe'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { instance, ruleEntry } from '../fixtures'

describe('discardedTotals', () => {
  it('lists each instance total above zero, named for a wildcard rule', () => {
    const entry = ruleEntry({
      status: {
        instances: [
          instance({
            instance: { name: 'port', segment: 'port' },
            progress: { kind: 'total', total: 7200, limit: 9000 }
          }),
          instance({
            instance: { name: 'stbd', segment: 'stbd' },
            progress: { kind: 'total', total: 0, limit: 9000 }
          })
        ]
      }
    })
    expect(discardedTotals(entry, formatDuration)).toEqual([{ name: 'port', total: '2 h' }])
    const single = ruleEntry({
      status: { instances: [instance({ progress: { kind: 'total', total: 60, limit: 90 } })] }
    })
    expect(discardedTotals(single, formatDuration)).toEqual([{ name: '', total: '60 s' }])
  })
})

describe('alertsWhen', () => {
  const units = unitLookup(
    [
      {
        path: 'propulsion.port.coolantTemperature',
        units: 'K',
        unit: displayUnit({
          units: 'K',
          displayUnits: { formula: 'value - 273.15', symbol: '°C' }
        })
      }
    ],
    displayUnit({ units: 'm' })
  )
  const when = (rule: Partial<RuleInfo>) => {
    const info = ruleEntry({
      rule: { signal: { paths: ['propulsion.port.coolantTemperature'] }, ...rule }
    }).rule
    return alertsWhen(info, ruleDisplay(info, units))
  }

  it('words one step with its duration, in display units', () => {
    expect(
      when({
        detector: { type: 'sustained', direction: 'above' },
        steps: [{ limit: 368.15, priority: 'warning' }],
        duration: 30
      })
    ).toBe('above 95 °C for at least 30 s')
  })

  it('words each step with its priority, sharing the duration', () => {
    expect(
      when({
        detector: { type: 'sustained', direction: 'above' },
        steps: [
          { limit: 368.15, priority: 'warning' },
          { limit: 373.15, priority: 'alarm' }
        ],
        duration: 30
      })
    ).toBe('above 95 °C (warning), above 100 °C (alarm), each for at least 30 s')
  })

  it('words a zone limit, and a step without a duration', () => {
    expect(
      when({ detector: { type: 'sustained', direction: 'above', zoneLevel: 'warn' }, steps: [] })
    ).toBe('above the warn zone')
    expect(
      when({
        detector: { type: 'sustained', direction: 'below' },
        steps: [{ limit: 353.15, priority: 'caution' }]
      })
    ).toBe('below 80 °C')
  })

  it('words a projection to a zone, rising as above it and falling as below it', () => {
    const zone = (direction: 'rising' | 'falling') =>
      when({ detector: { type: 'projection', direction, zoneLevel: 'alarm' }, steps: [] })
    expect(zone('rising')).toBe('projected above the alarm zone')
    expect(zone('falling')).toBe('projected below the alarm zone')
  })

  it.each([
    [{ type: 'match', op: 'equals' }, { value: 'fault', priority: 'warning' }, 'equals fault'],
    [{ type: 'match', op: 'changesTo' }, { value: 'off', priority: 'warning' }, 'changes to off'],
    [{ type: 'count' }, { limit: 5, priority: 'warning' }, 'more than 5 events'],
    [{ type: 'absence' }, { within: 600, priority: 'warning' }, 'no event within 10 min'],
    [
      { type: 'accumulator', measure: 'time' },
      { limit: 7200, priority: 'caution' },
      'a total of 2 h'
    ],
    // A rate converts through the unit's scale alone: 0.5 K/s is 0.5 °C/s, not -272.65.
    [
      { type: 'slope', direction: 'rising' },
      { limit: 0.5, priority: 'warning' },
      'rising faster than 0.5 °C/s'
    ],
    [
      { type: 'projection', direction: 'rising' },
      { limit: 373.15, priority: 'warning' },
      'projected above 100 °C'
    ],
    [
      { type: 'projection', direction: 'falling' },
      { limit: 353.15, priority: 'warning' },
      'projected below 80 °C'
    ]
  ])('words a %o step', (detector, step, text) => {
    expect(when({ detector, steps: [step] })).toBe(text)
  })
})

describe('an outside rule', () => {
  const HEEL = 'navigation.heel'
  const units = unitLookup(
    [{ path: HEEL, units: '°', unit: displayUnit({ units: '°' }) }],
    displayUnit({ units: 'm' })
  )
  const outside = (steps: RuleInfo['steps'], duration?: number) => {
    const info = ruleEntry({
      rule: { signal: { paths: [HEEL] }, detector: { type: 'outside' }, steps, duration }
    }).rule
    return alertsWhen(info, ruleDisplay(info, units))
  }

  it('words each step’s range with the unit once, and its priority', () => {
    expect(
      outside(
        [
          { low: -25, high: 25, priority: 'warning' },
          { low: -35, high: 35, priority: 'alarm' }
        ],
        10
      )
    ).toBe('outside -25 to 25 ° (warning), outside -35 to 35 ° (alarm), each for at least 10 s')
  })

  it('words one step without its priority', () => {
    expect(outside([{ low: 49, high: 51, priority: 'warning' }])).toBe('outside 49 to 51 °')
  })
})
