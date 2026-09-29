import { describe, it, expect } from 'vitest'
import { combine } from '../../src/engine/combinators.js'
import type { Position, Reading } from '../../src/engine/signals.js'

const DEG = Math.PI / 180
// One minute of latitude on the mean-radius sphere.
const ARC_MINUTE_M = (6371008.8 * Math.PI) / (180 * 60)

function valueOf(reading: Reading): unknown {
  if (!reading.available) throw new Error('expected an available reading')
  return reading.value
}

function numberOf(reading: Reading): number {
  const value = valueOf(reading)
  if (typeof value !== 'number') throw new Error('expected a number')
  return value
}

const unavailable: Reading = { available: false, timedOut: false }

describe('numeric combinators', () => {
  it('difference subtracts the second input from the first', () => {
    expect(numberOf(combine('difference', [30, 32], false))).toBe(-2)
  })

  it('absDifference is the magnitude of the difference', () => {
    expect(numberOf(combine('absDifference', [30, 32], false))).toBe(2)
  })

  it('ratio divides the first input by the second', () => {
    expect(numberOf(combine('ratio', [3, 4], false))).toBe(0.75)
  })

  it('ratio with a zero denominator is unavailable, not infinity', () => {
    expect(combine('ratio', [3, 0], false)).toEqual(unavailable)
    expect(combine('ratio', [0, 0], false)).toEqual(unavailable)
  })

  it('spread is the largest minus the smallest input', () => {
    expect(numberOf(combine('spread', [12.1, 12.7, 12.4], false))).toBeCloseTo(0.6)
  })

  it('mean averages the inputs', () => {
    expect(numberOf(combine('mean', [1, 2, 6], false))).toBe(3)
  })

  it('median takes the middle input, or the mean of the middle two', () => {
    expect(numberOf(combine('median', [5, 1, 100], false))).toBe(5)
    expect(numberOf(combine('median', [4, 1, 100, 2], false))).toBe(3)
  })

  it('a non-numeric input makes a numeric combination unavailable', () => {
    expect(combine('difference', [1, 'stopped'], false)).toEqual(unavailable)
    expect(combine('mean', [1, true], false)).toEqual(unavailable)
  })
})

describe('angular combinators', () => {
  it('difference wraps across north (359° vs 1° is -2°, not 358°)', () => {
    expect(numberOf(combine('difference', [359 * DEG, 1 * DEG], true))).toBeCloseTo(-2 * DEG)
  })

  it('absDifference wraps across north', () => {
    expect(numberOf(combine('absDifference', [359 * DEG, 1 * DEG], true))).toBeCloseTo(2 * DEG)
    expect(numberOf(combine('absDifference', [1 * DEG, 359 * DEG], true))).toBeCloseTo(2 * DEG)
  })

  it('without the angular flag the same inputs do not wrap', () => {
    expect(numberOf(combine('absDifference', [359 * DEG, 1 * DEG], false))).toBeCloseTo(358 * DEG)
  })

  it('mean of headings either side of north is north', () => {
    const mean = numberOf(combine('mean', [350 * DEG, 10 * DEG], true))
    expect(Math.min(mean, 2 * Math.PI - mean)).toBeCloseTo(0)
  })

  it('mean is in [0, 2π)', () => {
    expect(numberOf(combine('mean', [340 * DEG, 350 * DEG], true))).toBeCloseTo(345 * DEG)
  })

  it('mean of opposite headings has no direction and is unavailable', () => {
    expect(combine('mean', [0, Math.PI], true)).toEqual(unavailable)
  })

  it('spread is the smallest arc holding every input', () => {
    expect(numberOf(combine('spread', [355 * DEG, 5 * DEG, 2 * DEG], true))).toBeCloseTo(10 * DEG)
    expect(numberOf(combine('spread', [10 * DEG, 100 * DEG, 50 * DEG], true))).toBeCloseTo(90 * DEG)
  })
})

describe('position combinators', () => {
  const origin: Position = { latitude: 60, longitude: 25 }
  const north: Position = { latitude: 60 + 1 / 60, longitude: 25 }

  it('distance is the great-circle distance in metres', () => {
    expect(numberOf(combine('distance', [origin, north], false))).toBeCloseTo(ARC_MINUTE_M, 3)
  })

  it('positionSpread is the largest pairwise distance', () => {
    const midway: Position = { latitude: 60 + 1 / 120, longitude: 25 }
    expect(numberOf(combine('positionSpread', [midway, origin, north], false))).toBeCloseTo(
      ARC_MINUTE_M,
      3
    )
  })

  it('a non-position input makes a position combination unavailable', () => {
    expect(combine('distance', [origin, 3], false)).toEqual(unavailable)
  })
})
