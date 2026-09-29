import { afterEach, describe, it, expect, vi } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { monotonic, Stopwatch } from '../../../src/engine/clock.js'
import { harness, v } from './harness.js'

const HOUR = 3600

const specs: DetectorSpec[] = [
  { type: 'match', op: 'equals', value: 1, duration: 60 },
  { type: 'match', op: 'timedOut', duration: 60 },
  { type: 'sustained', direction: 'above', limit: 0, duration: 60 },
  { type: 'slope', direction: 'rising', window: 60, limit: 0.001 },
  { type: 'projection', direction: 'rising', limit: 10, window: 60, horizon: 60 },
  { type: 'accumulator', measure: 'time', limit: 60 },
  { type: 'count', event: { op: 'changes' }, window: 60, limit: 1 },
  { type: 'absence', event: { op: 'changes' }, within: 60 }
]

describe('detector time', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(specs.map((spec) => [spec.type, spec] as const))(
    '%s: a wall-clock jump of hours with no monotonic elapsed time fires nothing',
    (_type, spec) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { at, log } = harness(spec)
      at(0, v(1))
      vi.setSystemTime(Date.now() + 10 * HOUR * 1000)
      at(1)
      at(1, v(1))
      expect(log).toEqual([])
    }
  )
})

describe('monotonic clock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not follow a wall-clock jump', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const before = monotonic()
    vi.setSystemTime(Date.now() + 10 * HOUR * 1000)
    expect(monotonic() - before).toBeLessThan(1)
  })
})

describe('stopwatch', () => {
  it('counts only running time', () => {
    const s = new Stopwatch()
    s.start(10)
    s.stop(15)
    s.stop(20)
    s.start(100)
    expect(s.elapsed(103)).toBe(8)
    s.reset()
    expect(s.elapsed(200)).toBe(0)
    expect(s.running).toBe(false)
  })
})
