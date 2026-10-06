import { describe, expect, it } from 'vitest'
import type { PathEntry } from '../../src/panel/paths/selfPaths'
import {
  instanceSegment,
  isWildcardPath,
  matchesPattern,
  matchedInstances,
  signalMeasure,
  unitLookup,
  withInstanceWildcard
} from '../../src/panel/signalUnits'
import { displayUnit } from '../../src/panel/units'

const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
const rpm = displayUnit({ units: 'Hz', displayUnits: { formula: 'value * 60', symbol: 'rpm' } })
const nmi = displayUnit({
  units: 'm',
  displayUnits: { formula: 'value * 0.0005399568034557236', symbol: 'nmi' }
})

const paths: PathEntry[] = [
  { path: 'propulsion.port.coolantTemperature', units: 'K', unit: celsius },
  { path: 'propulsion.port.revolutions', units: 'Hz', unit: rpm },
  { path: 'propulsion.starboard.revolutions', units: 'Hz', unit: rpm },
  { path: 'electrical.batteries.house.voltage', units: 'V', unit: displayUnit({ units: 'V' }) },
  { path: 'electrical.batteries.start.voltage', units: 'V', unit: displayUnit({ units: 'V' }) },
  { path: 'tanks.freshWater.0.currentLevel', units: 'ratio', unit: displayUnit({ units: 'ratio' }) }
]

const lookup = unitLookup(paths, nmi)

describe('signalMeasure', () => {
  it("measures a single path's value absolutely in its display unit", () => {
    expect(signalMeasure({ paths: ['propulsion.port.coolantTemperature'] }, lookup)).toEqual({
      kind: 'absolute',
      unit: celsius
    })
  })

  it('finds the unit of a wildcard path from any path it matches', () => {
    expect(signalMeasure({ paths: ['propulsion.*.revolutions'] }, lookup).unit).toEqual(rpm)
  })

  it('falls back to an unlabelled SI unit for a path not reported yet', () => {
    expect(signalMeasure({ paths: ['navigation.log'] }, lookup)).toEqual({
      kind: 'absolute',
      unit: { symbol: '', scale: 1, offset: 0, si: true }
    })
  })

  it('measures a difference or spread as an interval of its inputs', () => {
    for (const combinator of ['difference', 'absDifference', 'spread']) {
      const signal = {
        combinator,
        paths: ['propulsion.port.revolutions', 'propulsion.starboard.revolutions']
      }
      expect(signalMeasure(signal, lookup)).toEqual({ kind: 'interval', unit: rpm })
    }
  })

  it('measures a mean or median absolutely', () => {
    const signal = {
      combinator: 'median',
      paths: ['navigation.log', 'propulsion.port.revolutions']
    }
    expect(signalMeasure(signal, lookup)).toEqual({ kind: 'absolute', unit: rpm })
  })

  it('measures a ratio without a unit', () => {
    const signal = {
      combinator: 'ratio',
      paths: ['propulsion.port.revolutions', 'propulsion.starboard.revolutions']
    }
    expect(signalMeasure(signal, lookup).kind).toBe('ratio')
  })

  it("measures distances in the user's distance unit", () => {
    for (const combinator of ['distance', 'positionSpread']) {
      const signal = { combinator, paths: ['navigation.position', 'navigation.position'] }
      expect(signalMeasure(signal, lookup)).toEqual({ kind: 'absolute', unit: nmi })
    }
  })
})

describe('instances', () => {
  it('finds the instance segment of the Signal K groups that have instances', () => {
    expect(instanceSegment('propulsion.port.revolutions')).toBe(1)
    expect(instanceSegment('electrical.batteries.house.voltage')).toBe(2)
    expect(instanceSegment('tanks.freshWater.0.currentLevel')).toBe(2)
    expect(instanceSegment('navigation.speedOverGround')).toBeUndefined()
    expect(instanceSegment('propulsion.port')).toBeUndefined()
  })

  it('replaces the instance segment with a wildcard', () => {
    expect(withInstanceWildcard('electrical.batteries.house.voltage')).toBe(
      'electrical.batteries.*.voltage'
    )
    expect(withInstanceWildcard('navigation.speedOverGround')).toBeUndefined()
  })

  it('lists the instances a wildcard path matches now', () => {
    expect(matchedInstances('electrical.batteries.*.voltage', paths)).toEqual(['house', 'start'])
    expect(matchedInstances('propulsion.*.oilPressure', paths)).toEqual([])
    expect(matchedInstances('propulsion.port.revolutions', paths)).toEqual([])
  })

  describe('of a field path', () => {
    const fields: PathEntry[] = [
      ...paths,
      { path: 'electrical.batteries.house#/voltage', unit: displayUnit({ units: 'V' }) },
      { path: 'electrical.batteries.start#/voltage', unit: displayUnit({ units: 'V' }) },
      { path: 'electrical.batteries.start#/current', unit: displayUnit({ units: 'A' }) }
    ]

    it('reads a wildcard directly before the pointer as the instance', () => {
      expect(isWildcardPath('electrical.batteries.*#/voltage')).toBe(true)
      expect(isWildcardPath('propulsion.*.x#/y')).toBe(true)
      expect(isWildcardPath('navigation.attitude#/roll')).toBe(false)
      expect(matchedInstances('electrical.batteries.*#/voltage', fields)).toEqual([
        'house',
        'start'
      ])
    })

    it('matches only fields at the same pointer, never the plain path', () => {
      expect(
        matchesPattern('electrical.batteries.*#/voltage', 'electrical.batteries.house#/voltage')
      ).toBe(true)
      expect(
        matchesPattern('electrical.batteries.*#/voltage', 'electrical.batteries.start#/current')
      ).toBe(false)
      expect(
        matchesPattern('electrical.batteries.*.voltage', 'electrical.batteries.house#/voltage')
      ).toBe(false)
      expect(
        matchesPattern('electrical.batteries.*#/voltage', 'electrical.batteries.house.voltage')
      ).toBe(false)
    })

    it('finds the instance in the base path, the field standing for the leaf', () => {
      expect(instanceSegment('electrical.batteries.house#/voltage')).toBe(2)
      expect(instanceSegment('propulsion.port#/a/b')).toBe(1)
      expect(instanceSegment('electrical.batteries#/a/b')).toBeUndefined()
      expect(withInstanceWildcard('electrical.batteries.house#/voltage')).toBe(
        'electrical.batteries.*#/voltage'
      )
    })

    it("finds a wildcard field's unit from a field it matches", () => {
      expect(unitLookup(fields, nmi).entry('electrical.batteries.*#/current')?.unit.symbol).toBe(
        'A'
      )
    })
  })
})
