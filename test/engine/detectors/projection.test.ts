import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, v } from './harness.js'

const MINUTE = 60
const batteryEmpty: DetectorSpec = {
  type: 'projection',
  direction: 'falling',
  limit: 11.8,
  window: 10 * MINUTE,
  horizon: 30 * MINUTE
}

type At = ReturnType<typeof harness>['at']

function feed(at: At, from: number, to: number, value: (t: number) => number) {
  for (let t = from; t <= to; t += 10) at(t, v(value(t)))
}

describe('projection detector', () => {
  it('battery voltage falling at the current rate reaches the limit in under 30 min', () => {
    const { at, log } = harness(batteryEmpty)
    // 12.0 V at 600 s, falling 0.06 V/min: 11.8 V is 200 s away.
    feed(at, 0, 600, (t) => 12.6 - 0.001 * t)
    expect(log).toEqual([[600, 'set']])
  })

  it('a slow fall that stays above the limit within the horizon does not set', () => {
    const { at, log } = harness(batteryEmpty)
    feed(at, 0, 1200, (t) => 12.6 - 0.0001 * t)
    expect(log).toEqual([])
  })

  it('a flat trend never sets, even beyond the limit', () => {
    for (const level of [11.9, 11.5]) {
      const { at, log } = harness(batteryEmpty)
      feed(at, 0, 1200, () => level)
      expect(log).toEqual([])
    }
  })

  it('an improving trend never sets, even beyond the limit', () => {
    const { at, log } = harness(batteryEmpty)
    feed(at, 0, 1200, (t) => 11.0 + 0.001 * t)
    expect(log).toEqual([])
  })

  it('clears when the fall stops', () => {
    const { at, detector } = harness(batteryEmpty)
    feed(at, 0, 600, (t) => 12.6 - 0.001 * t)
    feed(at, 610, 1800, () => 12.0)
    expect(detector.active).toBe(false)
  })

  it('once active it stays active while a noisy value sits past the limit', () => {
    const { at, detector, log } = harness(batteryEmpty)
    feed(at, 0, 600, (t) => 12.6 - 0.001 * t)
    feed(at, 610, 1200, (t) => 12.0 - 0.001 * (t - 600))
    let seed = 1
    const noise = () => {
      seed = (seed * 16807) % 2147483647
      return (seed / 2147483647 - 0.5) * 0.02
    }
    for (let t = 1210; t <= 12 * 3600; t += 1) at(t, v(11.4 + noise()))
    expect(log).toEqual([[600, 'set']])
    expect(detector.active).toBe(true)
  })

  it('a slowly falling tank reported only on change does not alarm when half full', () => {
    const { at, log } = harness({
      type: 'projection',
      direction: 'falling',
      limit: 0.05,
      window: 1800,
      horizon: 2 * 3600
    })
    for (let t = 0; t <= 24 * 3600; t++) {
      if (t % 3600 === 0) at(t, v(0.6 - 0.01 * (t / 3600)))
      else at(t)
    }
    expect(log).toEqual([])
  })

  it('a rising projection sets when the value will pass the limit upwards', () => {
    const { at, log } = harness({ ...batteryEmpty, direction: 'rising', limit: 14.8 })
    feed(at, 0, 600, (t) => 14.0 + 0.001 * t)
    expect(log).toEqual([[600, 'set']])
  })
})
