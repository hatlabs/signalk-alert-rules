import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, v } from './harness.js'

const lowVoltage = {
  type: 'sustained',
  direction: 'below',
  limit: 12,
  duration: 60
} as const satisfies DetectorSpec

describe('reconfiguring a detector in place', () => {
  it('a new limit the value is still beyond keeps the running timer', () => {
    const { at, detector } = harness(lowVoltage)
    at(0, v(11.5))
    expect(detector.reconfigure({ ...lowVoltage, limit: 11.8 }, 30)).toBeUndefined()
    expect(at(59)).toBeUndefined()
    expect(at(60)).toBe('set')
  })

  it('a new limit the value is no longer beyond stops the timer at once', () => {
    const { at, detector, log } = harness(lowVoltage)
    at(0, v(11.9))
    detector.reconfigure({ ...lowVoltage, limit: 11.8 }, 30)
    at(1000)
    expect(log).toEqual([])
  })

  it('a shorter duration that has already elapsed sets on reconfigure', () => {
    const { at, detector } = harness(lowVoltage)
    at(0, v(11.5))
    expect(detector.reconfigure({ ...lowVoltage, duration: 20 }, 30)).toBe('set')
  })

  it('an active condition whose new limit the value is back past clears after the clear duration', () => {
    const { at, detector } = harness({ ...lowVoltage, clearDuration: 10 })
    at(0, v(11.9))
    at(60)
    detector.reconfigure({ ...lowVoltage, limit: 11.5, clearDuration: 10 }, 100)
    expect(at(109)).toBeUndefined()
    expect(at(110)).toBe('clear')
  })

  it('an edit checks the value against the new limit before the old timer', () => {
    const { at, detector } = harness({ ...lowVoltage, duration: 0, clearDuration: 60 })
    at(0, v(11))
    at(1, v(12.3))
    expect(
      detector.reconfigure({ ...lowVoltage, limit: 12.5, duration: 0, clearDuration: 20 }, 31)
    ).toBeUndefined()
    at(1000)
    expect(detector.active).toBe(true)
  })

  it('a count detector evaluates a lowered limit at once', () => {
    const { at, detector } = harness({
      type: 'count',
      event: { op: 'changes' },
      window: 3600,
      limit: 5
    })
    at(0, v(1), true)
    at(10, v(2))
    at(20, v(3))
    expect(
      detector.reconfigure({ type: 'count', event: { op: 'changes' }, window: 3600, limit: 1 }, 30)
    ).toBe('set')
  })

  it('a trend detector takes a new window', () => {
    const { at, detector } = harness({
      type: 'slope',
      direction: 'rising',
      window: 600,
      limit: 0.001
    })
    for (let t = 0; t <= 300; t += 10) at(t, v(t / 60))
    expect(detector.active).toBe(false)
    expect(
      detector.reconfigure({ type: 'slope', direction: 'rising', window: 300, limit: 0.001 }, 300)
    ).toBe('set')
  })

  it('a different detector type is refused', () => {
    const { detector } = harness(lowVoltage)
    expect(() =>
      detector.reconfigure({ type: 'absence', event: { op: 'changes' }, within: 60 }, 0)
    ).toThrow()
  })
})
