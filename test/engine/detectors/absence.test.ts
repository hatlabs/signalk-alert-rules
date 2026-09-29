import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, UNAVAILABLE, v } from './harness.js'

const watch: DetectorSpec = { type: 'absence', event: { op: 'changes' }, within: 900 }

describe('absence detector', () => {
  it('no event within the window sets the condition and an event clears it', () => {
    const { at } = harness(watch)
    expect(at(899)).toBeUndefined()
    expect(at(900)).toBe('set')
    expect(at(950, v(1))).toBe('clear')
    expect(at(1849)).toBeUndefined()
    expect(at(1850)).toBe('set')
  })

  it('an event restarts the window', () => {
    const { at } = harness(watch)
    at(0, v(1), true)
    at(600, v(2))
    expect(at(1499)).toBeUndefined()
    expect(at(1500)).toBe('set')
  })

  it('a replayed value is not an event', () => {
    const { at } = harness(watch)
    at(0, v(1), true)
    expect(at(900)).toBe('set')
  })

  it('started condition-active clears on an event before one window has elapsed', () => {
    const { at } = harness(watch, { active: true })
    at(0, v(1), true)
    expect(at(10, v(2))).toBe('clear')
  })

  it('unavailable input pauses the window', () => {
    const { at } = harness(watch)
    at(0, v(1), true)
    at(100, UNAVAILABLE)
    expect(at(1000)).toBeUndefined()
    at(1000, v(1))
    expect(at(1799)).toBeUndefined()
    expect(at(1800)).toBe('set')
  })
})
