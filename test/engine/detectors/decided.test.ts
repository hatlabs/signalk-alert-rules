import { describe, it, expect } from 'vitest'
import { harness, UNAVAILABLE, v } from './harness.js'

describe('whether a detector has decided', () => {
  it('sustained: not while unavailable, inside the recovery margin or timing toward set', () => {
    const { at, detector } = harness({
      type: 'sustained',
      direction: 'below',
      limit: 12,
      duration: 60,
      hysteresis: 0.2
    })
    expect(detector.decided).toBe(false)
    at(0, UNAVAILABLE)
    at(10, v(12.1))
    expect(detector.decided).toBe(false)
    at(20, v(11.9))
    expect(detector.decided).toBe(false)
    at(80)
    expect(detector.decided).toBe(true)
  })

  it('sustained: once a reading is past the recovery margin', () => {
    const { at, detector } = harness({
      type: 'sustained',
      direction: 'below',
      limit: 12,
      hysteresis: 0.2
    })
    at(0, v(12.2))
    expect(detector.decided).toBe(true)
  })

  it('slope: once a full window is known', () => {
    const { at, detector } = harness({ type: 'slope', direction: 'rising', window: 60, limit: 1 })
    at(0, v(12))
    at(30, v(12))
    expect(detector.decided).toBe(false)
    at(60, v(12))
    expect(detector.decided).toBe(true)
  })

  it('projection: not on a flat value past the limit, once the projection is back on the safe side', () => {
    const { at, detector } = harness({
      type: 'projection',
      direction: 'rising',
      window: 60,
      horizon: 600,
      limit: 95
    })
    at(0, v(100))
    at(60, v(100))
    expect(detector.active).toBe(false)
    expect(detector.decided).toBe(false)
    at(70, v(90))
    at(130, v(90))
    expect(detector.decided).toBe(true)
  })

  it('count: a full window after it was created', () => {
    const { at, detector } = harness({
      type: 'count',
      event: { op: 'changesTo', value: true },
      window: 600,
      limit: 1
    })
    at(0, v(false))
    at(599)
    expect(detector.decided).toBe(false)
    at(600)
    expect(detector.decided).toBe(true)
  })

  it('match: once a reading does not match', () => {
    const { at, detector } = harness({ type: 'match', op: 'equals', values: ['off'], duration: 20 })
    at(0, v('off'))
    expect(detector.decided).toBe(false)
    at(10, v('on'))
    expect(detector.decided).toBe(true)
  })

  it('absence: once an event arrives', () => {
    const { at, detector } = harness({ type: 'absence', event: { op: 'changes' }, within: 60 })
    at(0, v(1), true)
    expect(detector.decided).toBe(false)
    at(10, v(2))
    expect(detector.decided).toBe(true)
  })

  it('accumulator: always, as its total carries over', () => {
    const { detector } = harness({ type: 'accumulator', measure: 'time', limit: 100 })
    expect(detector.decided).toBe(true)
  })
})
