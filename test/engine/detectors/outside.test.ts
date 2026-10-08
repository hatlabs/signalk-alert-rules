import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, TIMED_OUT, UNAVAILABLE, v } from './harness.js'

const heel = {
  type: 'outside',
  low: -25,
  high: 25,
  duration: 10,
  hysteresis: 2
} satisfies DetectorSpec

describe('outside detector', () => {
  it('sets after the duration above the high limit and records the high side', () => {
    const { at, detector } = harness(heel)
    expect(detector.passed).toBeUndefined()
    expect(at(0, v(27))).toBeUndefined()
    expect(detector.passed).toBe('high')
    expect(at(9)).toBeUndefined()
    expect(at(10)).toBe('set')
  })

  it('sets after the duration below the low limit and records the low side', () => {
    const { at, detector } = harness(heel)
    at(0, v(-27))
    expect(at(10)).toBe('set')
    expect(detector.passed).toBe('low')
  })

  it('a limit itself is not beyond it', () => {
    const { at, log } = harness({ type: 'outside', low: -25, high: 25 })
    at(0, v(25))
    at(1, v(-25))
    expect(log).toEqual([])
  })

  it('clears as soon as the value is inside the range narrowed by the hysteresis', () => {
    const { at } = harness(heel)
    at(0, v(27))
    at(10)
    expect(at(11, v(24))).toBeUndefined()
    expect(at(100)).toBeUndefined()
    expect(at(101, v(23))).toBe('clear')
  })

  it('clears from the low side at the low limit plus the hysteresis', () => {
    const { at } = harness({ type: 'outside', low: -25, high: 25, hysteresis: 2 })
    expect(at(0, v(-26))).toBe('set')
    expect(at(1, v(-23.1))).toBeUndefined()
    expect(at(2, v(-23))).toBe('clear')
  })

  it('with a hysteresis just under half the range it still clears at the centre', () => {
    const { at } = harness({ type: 'outside', low: -25, high: 25, hysteresis: 24.9 })
    expect(at(0, v(26))).toBe('set')
    expect(at(1, v(0.2))).toBeUndefined()
    expect(at(2, v(0))).toBe('clear')
  })

  it('a jump from one side to the other keeps the timer running and records the new side', () => {
    const { at, detector } = harness(heel)
    at(0, v(-27))
    at(5, v(27))
    expect(detector.passed).toBe('high')
    expect(at(9)).toBeUndefined()
    expect(at(10)).toBe('set')
  })

  it('a value between the limits and the hysteresis band neither sets nor clears', () => {
    const { at, detector } = harness(heel, { active: true })
    at(0, v(24))
    at(10_000, v(-24))
    expect(at(20_000)).toBeUndefined()
    expect(detector.active).toBe(true)
  })

  it('a return inside the range before the duration resets the timer', () => {
    const { at, log } = harness(heel)
    at(0, v(27))
    at(5, v(0))
    at(6, v(27))
    at(15)
    expect(log).toEqual([])
    expect(at(16)).toBe('set')
  })

  it('unavailable input pauses the duration timer and resumes it', () => {
    const { at } = harness(heel)
    at(0, v(27))
    at(4, UNAVAILABLE)
    expect(at(500)).toBeUndefined()
    expect(at(500, v(27))).toBeUndefined()
    expect(at(505)).toBeUndefined()
    expect(at(506)).toBe('set')
  })

  it('a timed-out input holds an active condition', () => {
    const { at, detector } = harness(heel)
    at(0, v(27))
    at(10)
    expect(at(11, TIMED_OUT)).toBeUndefined()
    expect(at(10_000)).toBeUndefined()
    expect(detector.active).toBe(true)
  })

  it('keeps the side it last found while the value is back inside the range', () => {
    const { at, detector } = harness(heel)
    at(0, v(-27))
    at(10)
    at(11, v(0))
    expect(detector.active).toBe(false)
    expect(detector.passed).toBe('low')
  })

  it('a reconfigure that narrows the range checks the last value against it', () => {
    const { detector } = harness(heel)
    detector.sample(v(20), false, 0)
    expect(detector.reconfigure({ ...heel, low: -15, high: 15, duration: 0 }, 1)).toBe('set')
    expect(detector.passed).toBe('high')
  })
})
