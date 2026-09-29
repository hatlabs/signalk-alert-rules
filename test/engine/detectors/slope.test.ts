import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, UNAVAILABLE, v } from './harness.js'

const MINUTE = 60
// 0.5 °C/min in K/s
const coolantRise: DetectorSpec = {
  type: 'slope',
  direction: 'rising',
  window: 5 * MINUTE,
  limit: 0.5 / MINUTE
}

type At = ReturnType<typeof harness>['at']

function feed(at: At, from: number, to: number, value: (t: number) => number) {
  for (let t = from; t <= to; t += 10) at(t, v(value(t)))
}

const rising = (t: number) => 350 + t / MINUTE

describe('slope detector', () => {
  it('coolant rising 1 °C/min over a 5 min window exceeds a 0.5 °C/min limit', () => {
    const { at, log } = harness(coolantRise)
    feed(at, 0, 290, rising)
    expect(log).toEqual([])
    feed(at, 300, 300, rising)
    expect(log).toEqual([[300, 'set']])
  })

  it('clears when the temperature levels off', () => {
    const { at, detector } = harness(coolantRise)
    feed(at, 0, 300, rising)
    feed(at, 310, 900, () => rising(300))
    expect(detector.active).toBe(false)
  })

  it('a falling detector ignores a rising trend', () => {
    const { at, log } = harness({ ...coolantRise, direction: 'falling' })
    feed(at, 0, 900, rising)
    expect(log).toEqual([])
  })

  it('a slower rise stays below the limit', () => {
    const { at, log } = harness(coolantRise)
    feed(at, 0, 900, (t) => 350 + (0.4 * t) / MINUTE)
    expect(log).toEqual([])
  })

  it('started condition-active does not clear before one full window has elapsed', () => {
    const { at } = harness(coolantRise, { active: true })
    for (let t = 0; t < 300; t += 10) expect(at(t, v(350))).toBeUndefined()
    expect(at(300, v(350))).toBe('clear')
  })

  it('unavailable input holds the state, and the window keeps the samples from before', () => {
    const { at, detector } = harness(coolantRise)
    feed(at, 0, 300, rising)
    expect(detector.active).toBe(true)
    at(310, UNAVAILABLE)
    expect(at(2000)).toBeUndefined()
    expect(detector.active).toBe(true)
    // The rise before the gap still counts, so the alarm holds until level data fills the window.
    expect(at(2000, v(rising(310)))).toBeUndefined()
    feed(at, 2010, 2400, () => rising(310))
    expect(detector.active).toBe(false)
  })

  it('a single unavailable sample during a rise does not delay the alarm', () => {
    const { at, log } = harness(coolantRise)
    feed(at, 0, 140, rising)
    at(150, UNAVAILABLE)
    feed(at, 151, 311, rising)
    expect(log[0]?.[1]).toBe('set')
    expect(log[0]?.[0]).toBeLessThanOrEqual(311)
  })

  it('a single step on a change-only input raises nothing as it leaves the window', () => {
    const { at, log } = harness({ ...coolantRise, limit: 0.02 })
    at(0, v(353.15))
    at(1000, v(353.65))
    for (let t = 1001; t <= 2000; t++) at(t)
    expect(log).toEqual([])
  })

  it('time passing without samples re-evaluates the window', () => {
    const { at } = harness(coolantRise)
    feed(at, 0, 300, rising)
    at(310, v(rising(310)))
    // Nothing new arrives; the last value is taken to hold, so the trend flattens.
    expect(at(1000)).toBe('clear')
  })
})
