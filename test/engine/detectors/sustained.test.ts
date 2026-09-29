import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, TIMED_OUT, UNAVAILABLE, v } from './harness.js'

const lowVoltage: DetectorSpec = {
  type: 'sustained',
  direction: 'below',
  limit: 12,
  duration: 60,
  hysteresis: 0.2,
  clearDuration: 30
}

describe('sustained detector', () => {
  it('sets after the duration, holds inside the hysteresis band, clears after the clear duration', () => {
    const { at, detector } = harness(lowVoltage)
    expect(at(0, v(11.9))).toBeUndefined()
    expect(at(59)).toBeUndefined()
    expect(at(60)).toBe('set')
    expect(detector.active).toBe(true)

    expect(at(61, v(12.1))).toBeUndefined()
    expect(at(500)).toBeUndefined()
    expect(detector.active).toBe(true)

    expect(at(501, v(12.3))).toBeUndefined()
    expect(at(530)).toBeUndefined()
    expect(at(531)).toBe('clear')
    expect(detector.active).toBe(false)
  })

  it('a dip shorter than the duration never sets, and a later dip restarts the timer', () => {
    const { at, log } = harness(lowVoltage)
    at(0, v(11.9))
    at(30, v(12.5))
    at(100)
    expect(log).toEqual([])
    at(110, v(11.9))
    at(169)
    expect(log).toEqual([])
    expect(at(170)).toBe('set')
  })

  it('a return inside the hysteresis band during the clear duration restarts the clear timer', () => {
    const { at } = harness(lowVoltage, { active: true })
    at(0, v(12.3))
    at(20, v(12.1))
    at(40, v(12.3))
    expect(at(69)).toBeUndefined()
    expect(at(70)).toBe('clear')
  })

  it('started condition-active with the value inside the hysteresis band stays active', () => {
    const { at, detector, log } = harness(lowVoltage, { active: true })
    at(0, v(12.1))
    at(10_000)
    expect(log).toEqual([])
    expect(detector.active).toBe(true)
  })

  it('unavailable input pauses the duration timer and resumes it', () => {
    const { at } = harness(lowVoltage)
    at(0, v(11.9))
    at(40, UNAVAILABLE)
    expect(at(500)).toBeUndefined()
    expect(at(500, v(11.9))).toBeUndefined()
    expect(at(519)).toBeUndefined()
    expect(at(520)).toBe('set')
  })

  it('a timed-out input holds an active condition instead of clearing it', () => {
    const { at, detector } = harness(lowVoltage)
    at(0, v(11.9))
    at(60)
    expect(at(61, TIMED_OUT)).toBeUndefined()
    expect(at(10_000)).toBeUndefined()
    expect(detector.active).toBe(true)
  })

  it('without duration or hysteresis it sets and clears at the limit', () => {
    const { at } = harness({ type: 'sustained', direction: 'above', limit: 3 })
    expect(at(0, v(3))).toBeUndefined()
    expect(at(1, v(3.5))).toBe('set')
    expect(at(2, v(3))).toBe('clear')
  })

  it('with a duration but no clear duration it clears as soon as the value is back', () => {
    const { at } = harness({ type: 'sustained', direction: 'above', limit: 3, duration: 30 })
    at(0, v(4))
    expect(at(30)).toBe('set')
    expect(at(31, v(3))).toBe('clear')
  })

  it('above with hysteresis clears only below the limit minus the margin', () => {
    const { at } = harness({ type: 'sustained', direction: 'above', limit: 3, hysteresis: 0.5 })
    expect(at(0, v(3.1))).toBe('set')
    expect(at(1, v(2.6))).toBeUndefined()
    expect(at(2, v(2.5))).toBe('clear')
  })

  it('never seen input does nothing', () => {
    const { at, log } = harness(lowVoltage)
    at(10_000)
    expect(log).toEqual([])
  })

  it('a non-numeric value is treated as unavailable', () => {
    const { at, detector } = harness(lowVoltage)
    at(0, v(11.9))
    at(60)
    expect(at(61, v('broken'))).toBeUndefined()
    expect(detector.active).toBe(true)
  })
})
