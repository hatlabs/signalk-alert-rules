import { describe, it, expect } from 'vitest'
import {
  alertParent,
  instanceAlertPath,
  alertPathOf,
  alertPathsOverlap,
  defaultCondition,
  deltaPath,
  matchAlertPath,
  sanitiseSegment
} from '../../src/alerts/paths.js'
import type { Detector } from '../../src/model/rule.js'

const fixed = { kind: 'fixed', value: 1 } as const
const event = { op: 'changes' } as const

describe('defaultCondition', () => {
  const cases: [Detector, string][] = [
    [{ type: 'sustained', direction: 'above', limit: fixed }, 'voltageHigh'],
    [{ type: 'sustained', direction: 'below', limit: fixed }, 'voltageLow'],
    [
      { type: 'projection', direction: 'rising', limit: fixed, window: 60, horizon: 600 },
      'voltageProjectedHigh'
    ],
    [
      { type: 'projection', direction: 'falling', limit: fixed, window: 60, horizon: 600 },
      'voltageProjectedLow'
    ],
    [{ type: 'slope', direction: 'rising', window: 60, limit: 1 }, 'voltageRising'],
    [{ type: 'slope', direction: 'falling', window: 60, limit: 1 }, 'voltageFalling'],
    [{ type: 'match', op: 'equals', value: 1 }, 'voltageMatch'],
    [{ type: 'match', op: 'notEquals', value: 1 }, 'voltageMismatch'],
    [{ type: 'match', op: 'changesTo', value: 1 }, 'voltageChanged'],
    [{ type: 'match', op: 'decreases' }, 'voltageDecreased'],
    [{ type: 'match', op: 'timedOut', duration: 10 }, 'voltageTimedOut'],
    [{ type: 'accumulator', measure: 'time', limit: 10 }, 'voltageAccumulated'],
    [{ type: 'count', event, window: 60, limit: 3 }, 'voltageFrequent'],
    [{ type: 'absence', event, within: 60 }, 'voltageMissing']
  ]

  it.each(cases)('names the condition of %o after the leaf', (detector, name) => {
    expect(defaultCondition({ path: 'electrical.batteries.house.voltage' }, detector)).toBe(name)
  })

  it('camel-cases a leaf with characters core refuses', () => {
    expect(defaultCondition({ path: 'tanks.fresh water.level:raw' }, cases[1][0])).toBe(
      'levelRawLow'
    )
  })

  it('names nothing for a combined signal or a wildcard leaf', () => {
    const combined = { combinator: 'difference', inputs: [{ path: 'a.b' }, { path: 'a.c' }] }
    expect(defaultCondition(combined, cases[1][0])).toBeUndefined()
    expect(defaultCondition({ path: 'electrical.batteries.*' }, cases[1][0])).toBeUndefined()
  })

  it('names nothing from a malformed document', () => {
    expect(defaultCondition({ path: 'a.b' }, { type: 'nonsense' })).toBeUndefined()
    expect(defaultCondition('a.b', cases[1][0])).toBeUndefined()
  })

  it('names nothing while the detector lacks the field its name comes from', () => {
    for (const detector of [
      { type: 'sustained' },
      { type: 'sustained', direction: '' },
      { type: 'slope', direction: '' },
      { type: 'projection', direction: 'sideways' },
      { type: 'match', op: '' }
    ]) {
      expect(defaultCondition({ path: 'a.b' }, detector)).toBeUndefined()
    }
  })
})

describe('alertParent', () => {
  it("is a single input's parent, its wildcard kept and other segments sanitised", () => {
    expect(alertParent({ path: 'electrical.batteries.*.voltage' })).toEqual([
      'electrical',
      'batteries',
      '*'
    ])
    expect(alertParent({ path: 'tanks.fresh water.level' })).toEqual(['tanks', 'fresh_water'])
  })

  it('is the whole input path when its leaf is the wildcard, so each instance has its own', () => {
    expect(alertParent({ path: 'electrical.batteries.*' })).toEqual([
      'electrical',
      'batteries',
      '*'
    ])
  })

  it("is the longest common prefix of a combined signal's input parents", () => {
    const inputs = [
      { path: 'propulsion.port.revolutions' },
      { path: 'propulsion.starboard.revolutions' }
    ]
    expect(alertParent({ combinator: 'difference', inputs })).toEqual(['propulsion'])
    const same = [{ path: 'navigation.headingMagnetic' }, { path: 'navigation.headingMagnetic' }]
    expect(alertParent({ combinator: 'spread', inputs: same })).toEqual(['navigation'])
  })

  it('is empty for a combined signal whose inputs share no parent', () => {
    const inputs = [{ path: 'environment.depth' }, { path: 'navigation.speedOverGround' }]
    expect(alertParent({ combinator: 'ratio', inputs })).toEqual([])
  })

  it('is undefined for a malformed signal', () => {
    expect(alertParent('a.b')).toBeUndefined()
    expect(alertParent({ combinator: 'difference', inputs: 'a' })).toBeUndefined()
  })
})

describe('alertPathOf', () => {
  const detector = { type: 'sustained', direction: 'below', limit: fixed }
  const combined = {
    combinator: 'difference',
    inputs: [{ path: 'propulsion.port.revolutions' }, { path: 'propulsion.starboard.revolutions' }]
  }

  it("puts the default condition name under the input's parent", () => {
    expect(alertPathOf({ signal: { path: 'electrical.batteries.*.voltage' }, detector })).toBe(
      'electrical.batteries.*.voltageLow'
    )
  })

  it('puts a stored condition name there instead', () => {
    const signal = { path: 'electrical.batteries.house.voltage' }
    expect(alertPathOf({ signal, detector, condition: 'flat' })).toBe(
      'electrical.batteries.house.flat'
    )
  })

  it("puts a combined signal's condition name under its common parent, or alone", () => {
    expect(alertPathOf({ signal: combined, detector, condition: 'revolutionsMismatch' })).toBe(
      'propulsion.revolutionsMismatch'
    )
    const apart = {
      combinator: 'ratio',
      inputs: [{ path: 'environment.depth' }, { path: 'navigation.speedOverGround' }]
    }
    expect(alertPathOf({ signal: apart, detector, condition: 'shoaling' })).toBe('shoaling')
  })

  it('is undefined without a condition name to use', () => {
    expect(alertPathOf({ signal: combined, detector })).toBeUndefined()
    expect(alertPathOf({ signal: { path: 'a.*' }, detector })).toBeUndefined()
  })
})

describe('instanceAlertPath', () => {
  it('fills the wildcard with the instance segment', () => {
    expect(instanceAlertPath('propulsion.*.coolantTemperatureHigh', 'port')).toEqual({
      ok: true,
      value: 'propulsion.port.coolantTemperatureHigh'
    })
    expect(instanceAlertPath('propulsion.main.oilPressureLow')).toEqual({
      ok: true,
      value: 'propulsion.main.oilPressureLow'
    })
  })

  it('refuses an instance that is not a valid segment, or one making the path too long', () => {
    expect(instanceAlertPath('a.*.b', 'port side').ok).toBe(false)
    expect(instanceAlertPath('a.*.b', 'x'.repeat(252)).ok).toBe(false)
  })
})

describe('sanitiseSegment', () => {
  it('keeps a name that is already a valid alert path segment', () => {
    expect(sanitiseSegment('port_1-a')).toBe('port_1-a')
  })

  it('replaces characters an alert path segment cannot hold', () => {
    expect(sanitiseSegment('house bank #2')).toBe('house_bank__2')
  })
})

describe('matchAlertPath', () => {
  it('matches a rule path, and a wildcard rule path with the instance segment', () => {
    expect(matchAlertPath('a.b.cLow', 'a.b.cLow')).toEqual({})
    expect(matchAlertPath('a.*.cLow', 'a.port.cLow')).toEqual({ segment: 'port' })
  })

  it('does not match another path', () => {
    for (const path of ['a.b.cHigh', 'a.b.cLow.x', 'a.cLow']) {
      expect(matchAlertPath('a.*.cLow', path)).toBeUndefined()
    }
  })
})

describe('alertPathsOverlap', () => {
  it('tells paths that could name one alert', () => {
    expect(alertPathsOverlap('a.b.cLow', 'a.b.cLow')).toBe(true)
    expect(alertPathsOverlap('a.*.cLow', 'a.house.cLow')).toBe(true)
    expect(alertPathsOverlap('a.*.cLow', 'a.house.cHigh')).toBe(false)
    expect(alertPathsOverlap('a.b.cLow', 'a.b.c.cLow')).toBe(false)
  })
})

describe('deltaPath', () => {
  it('puts the alerts prefix on the delta path', () => {
    expect(deltaPath('a.b')).toBe('alerts.a.b')
  })
})
