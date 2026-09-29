import { describe, it, expect } from 'vitest'
import { ACCUMULATOR_HOLD_S } from '../../../src/engine/detectors/accumulator.js'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, UNAVAILABLE, v } from './harness.js'

const engineHours = {
  type: 'accumulator',
  measure: 'time',
  while: { op: 'above', value: 0 },
  limit: 100
} satisfies DetectorSpec

describe('accumulator detector', () => {
  it('accumulates time only while the running condition holds', () => {
    const { at, detector } = harness(engineHours)
    at(0, v(0))
    at(10, v(20))
    at(60, v(0))
    at(100, v(20))
    expect(at(149)).toBeUndefined()
    expect(detector.accumulated).toBe(99)
    expect(at(150)).toBe('set')
  })

  it('unavailable input pauses accumulation', () => {
    const { at, detector } = harness(engineHours)
    at(0, v(20))
    at(10, UNAVAILABLE)
    at(500)
    at(500, v(20))
    at(520)
    expect(detector.accumulated).toBe(30)
  })

  it('reset zeroes the total and clears the condition', () => {
    const { at, detector, log } = harness(engineHours)
    for (let t = 0; t <= 100; t += 10) at(t, v(20))
    expect(log).toEqual([[100, 'set']])
    expect(detector.reset(101)).toBe('clear')
    expect(detector.accumulated).toBe(0)
    expect(at(150)).toBeUndefined()
    expect(detector.accumulated).toBe(49)
  })

  it('resetOn restarts the count on the signal event', () => {
    const { at, detector } = harness({
      type: 'accumulator',
      measure: 'time',
      resetOn: { op: 'changesTo', value: true },
      limit: 40
    })
    at(0, v(false))
    expect(at(40)).toBe('set')
    expect(at(50, v(true))).toBe('clear')
    expect(detector.accumulated).toBe(0)
    at(60)
    expect(detector.accumulated).toBe(10)
  })

  it('a first live value equal to the reset event does not wipe a restored total', () => {
    const { at, detector } = harness(
      {
        type: 'accumulator',
        measure: 'time',
        resetOn: { op: 'changesTo', value: 'done' },
        limit: 100
      },
      { accumulated: 90 }
    )
    expect(at(0, v('done'))).toBeUndefined()
    expect(detector.accumulated).toBe(90)
  })

  it('a while rule stops accumulating a hold time after the input goes silent', () => {
    const { at, detector } = harness({ ...engineHours, limit: 1e9 })
    for (let t = 0; t <= 3600; t += 10) at(t, v(20))
    at(3600 + 71 * 3600)
    expect(detector.accumulated).toBe(3600 + ACCUMULATOR_HOLD_S)
    at(80 * 3600, v(20))
    at(80 * 3600 + 10)
    expect(detector.accumulated).toBe(3600 + ACCUMULATOR_HOLD_S + 10)
  })

  it('a rule without while keeps counting without samples', () => {
    const { at, detector } = harness({ type: 'accumulator', measure: 'time', limit: 1e9 })
    at(0, v(false), true)
    at(10 * 3600)
    expect(detector.accumulated).toBe(10 * 3600)
  })

  it('a total taken from a running detector restores into a new one', () => {
    const first = harness(engineHours)
    first.at(0, v(20))
    first.at(40)
    const second = harness(engineHours, { accumulated: first.detector.accumulated })
    second.at(0, v(20))
    expect(second.at(59)).toBeUndefined()
    expect(second.at(60)).toBe('set')
  })

  it('integrates the value over time', () => {
    const { at } = harness({ type: 'accumulator', measure: 'integral', limit: 40 })
    at(0, v(2))
    at(10, v(4))
    expect(at(14)).toBeUndefined()
    expect(at(15)).toBe('set')
  })

  it('continues from a restored total', () => {
    const { at, detector } = harness(engineHours, { accumulated: 90 })
    at(0, v(20))
    expect(detector.accumulated).toBe(90)
    expect(at(10)).toBe('set')
  })

  it('started condition-active stays active until reset', () => {
    const { at, detector } = harness(engineHours, { active: true })
    at(0, v(0))
    at(1000)
    expect(detector.active).toBe(true)
    expect(detector.reset(1001)).toBe('clear')
  })
})
