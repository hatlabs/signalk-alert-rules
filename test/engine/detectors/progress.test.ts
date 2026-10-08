import { describe, it, expect } from 'vitest'
import { harness, TIMED_OUT, UNAVAILABLE, v } from './harness.js'

describe('detector progress', () => {
  it('sustained: the timer toward set, paused while unavailable, and none while active', () => {
    const { at, detector } = harness({
      type: 'sustained',
      direction: 'below',
      limit: 12,
      duration: 60,
      hysteresis: 0.2
    })
    at(0, v(12.5))
    expect(detector.progress(0)).toBeUndefined()
    at(10, v(11.9))
    expect(detector.progress(25)).toEqual({ kind: 'timer', elapsed: 15, target: 60 })
    at(30, UNAVAILABLE)
    expect(detector.progress(50)).toEqual({ kind: 'timer', elapsed: 20, target: 60 })
    at(50, v(11.9))
    at(90)
    expect(detector.active).toBe(true)
    expect(detector.progress(90)).toBeUndefined()
    at(100, v(12.1))
    expect(detector.progress(110)).toBeUndefined()
  })

  it('sustained without a duration reports no timer', () => {
    const { at, detector } = harness({ type: 'sustained', direction: 'above', limit: 1 })
    at(0, v(0))
    expect(detector.progress(0)).toBeUndefined()
  })

  it('match: the timer toward set while the value matches', () => {
    const { at, detector } = harness({ type: 'match', op: 'equals', values: ['off'], duration: 20 })
    at(0, v('on'))
    expect(detector.progress(5)).toBeUndefined()
    at(10, v('off'))
    expect(detector.progress(15)).toEqual({ kind: 'timer', elapsed: 5, target: 20 })
    at(30)
    expect(detector.progress(30)).toBeUndefined()
  })

  it('timeout: the timer runs from start while the path is never seen', () => {
    const { at, detector } = harness({ type: 'match', op: 'timedOut', values: [], duration: 30 })
    expect(detector.progress(10)).toEqual({ kind: 'timer', elapsed: 10, target: 30 })
    at(12, v(3))
    expect(detector.progress(12)).toBeUndefined()
    at(20, TIMED_OUT)
    expect(detector.progress(25)).toEqual({ kind: 'timer', elapsed: 5, target: 30 })
  })

  it('a transition match has no progress', () => {
    const { at, detector } = harness({ type: 'match', op: 'changesTo', values: ['stopped'] })
    at(0, v('started'))
    expect(detector.progress(0)).toBeUndefined()
  })

  it('absence: time since the last event toward the window', () => {
    const { at, detector } = harness({ type: 'absence', event: { op: 'changes' }, within: 900 })
    expect(detector.progress(100)).toEqual({
      kind: 'timer',
      elapsed: 100,
      target: 900
    })
    at(300, v(1))
    expect(detector.progress(400)).toEqual({
      kind: 'timer',
      elapsed: 100,
      target: 900
    })
  })

  it('count: the events in the window and the limit', () => {
    const { at, detector } = harness({
      type: 'count',
      event: { op: 'changesTo', value: true },
      window: 60,
      limit: 3
    })
    at(0, v(true))
    at(10, v(false))
    at(20, v(true))
    expect(detector.progress(20)).toEqual({ kind: 'events', count: 2, limit: 3 })
    expect(detector.progress(65)).toEqual({ kind: 'events', count: 1, limit: 3 })
  })

  it('accumulator: the total up to now and the limit', () => {
    const { at, detector } = harness({ type: 'accumulator', measure: 'time', limit: 100 })
    at(0, v(30))
    expect(detector.progress(40)).toEqual({ kind: 'total', total: 40, limit: 100 })
  })

  it('slope and projection have no progress', () => {
    const slope = harness({ type: 'slope', direction: 'rising', window: 60, limit: 0.1 })
    slope.at(0, v(1))
    expect(slope.detector.progress(10)).toBeUndefined()
  })
})
