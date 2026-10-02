import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, TIMED_OUT, UNAVAILABLE, v } from './harness.js'

describe('match detector, transitions', () => {
  it('an uptime-style counter decrease is a momentary condition', () => {
    const { at, detector } = harness({ type: 'match', op: 'decreases', values: [] })
    expect(at(0, v(100))).toBeUndefined()
    expect(at(10, v(110))).toBeUndefined()
    expect(at(20, v(5))).toBe('pulse')
    expect(detector.active).toBe(false)
    expect(at(30, v(15))).toBeUndefined()
  })

  it('a replayed value is a baseline, not an event', () => {
    const { at } = harness({ type: 'match', op: 'decreases', values: [] })
    expect(at(0, v(100), true)).toBeUndefined()
    expect(at(1, v(5))).toBe('pulse')
  })

  it('changesTo fires once per change to the value', () => {
    const { at } = harness({ type: 'match', op: 'changesTo', values: ['stopped'] })
    expect(at(0, v('running'))).toBeUndefined()
    expect(at(5, v('stopped'))).toBe('pulse')
    expect(at(6, v('stopped'))).toBeUndefined()
  })

  it('a value appearing live for the first time is only a baseline', () => {
    // An engine controller powered on at key-on first reports 'stopped'.
    const { at } = harness({ type: 'match', op: 'changesTo', values: ['stopped'] })
    expect(at(0, v('stopped'))).toBeUndefined()
    at(10, v('running'))
    expect(at(20, v('stopped'))).toBe('pulse')
  })

  it('a replayed value equal to the target is not a change', () => {
    const { at } = harness({ type: 'match', op: 'changesTo', values: ['stopped'] })
    expect(at(0, v('stopped'), true)).toBeUndefined()
  })

  it('an unavailable gap between equal values is not a change', () => {
    const { at } = harness({ type: 'match', op: 'changesTo', values: ['stopped'] })
    at(0, v('stopped'), true)
    at(5, UNAVAILABLE)
    expect(at(10, v('stopped'))).toBeUndefined()
  })

  it('started condition-active clears on the first available sample', () => {
    const { at } = harness({ type: 'match', op: 'decreases', values: [] }, { active: true })
    expect(at(0, UNAVAILABLE)).toBeUndefined()
    expect(at(5)).toBeUndefined()
    expect(at(10, v(100))).toBe('clear')
  })
})

describe('match detector, states', () => {
  it('equals with a duration sets after the value has held for it and clears when it changes', () => {
    const { at } = harness({ type: 'match', op: 'equals', values: [true], duration: 10 })
    at(0, v(true))
    expect(at(9)).toBeUndefined()
    expect(at(10)).toBe('set')
    expect(at(11, v(false))).toBe('clear')
  })

  it('a replayed state value counts, so a stuck switch is seen after a restart', () => {
    const { at } = harness({ type: 'match', op: 'equals', values: [true] })
    expect(at(0, v(true), true)).toBe('set')
  })

  it('notEquals sets on any other value', () => {
    const { at } = harness({ type: 'match', op: 'notEquals', values: ['ok'] })
    expect(at(0, v('ok'))).toBeUndefined()
    expect(at(1, v('fault'))).toBe('set')
    expect(at(2, v('ok'))).toBe('clear')
  })

  it('unavailable input holds the state and pauses the timer', () => {
    const { at, detector } = harness({ type: 'match', op: 'equals', values: [true], duration: 10 })
    at(0, v(true))
    at(4, UNAVAILABLE)
    expect(at(100)).toBeUndefined()
    at(100, v(true))
    expect(at(105)).toBeUndefined()
    expect(at(106)).toBe('set')
    expect(at(107, UNAVAILABLE)).toBeUndefined()
    expect(detector.active).toBe(true)
  })
})

describe('match detector, timeout rules', () => {
  const timeout: DetectorSpec = { type: 'match', op: 'timedOut', values: [], duration: 30 }

  it('sets when the input has been timed out for the duration and clears when it reports', () => {
    const { at } = harness(timeout)
    at(0, v(4))
    at(10, TIMED_OUT)
    expect(at(39)).toBeUndefined()
    expect(at(40)).toBe('set')
    expect(at(41, v(4))).toBe('clear')
  })

  it('sets when the input has not been seen for the duration since start', () => {
    const { at } = harness(timeout)
    expect(at(29)).toBeUndefined()
    expect(at(30)).toBe('set')
  })

  it('never-seen time stops counting once the path reports anything', () => {
    const { at } = harness(timeout)
    at(25, UNAVAILABLE)
    at(100, TIMED_OUT)
    expect(at(129)).toBeUndefined()
    expect(at(130)).toBe('set')
  })

  it('a null without the timed-out flag pauses the timer', () => {
    const { at } = harness(timeout)
    at(0, v(4))
    at(10, TIMED_OUT)
    at(20, UNAVAILABLE)
    expect(at(100)).toBeUndefined()
    at(100, TIMED_OUT)
    expect(at(119)).toBeUndefined()
    expect(at(120)).toBe('set')
  })
})
