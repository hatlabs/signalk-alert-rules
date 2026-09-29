import { describe, it, expect } from 'vitest'
import type { DetectorSpec } from '../../../src/engine/detectors/index.js'
import { harness, UNAVAILABLE, v } from './harness.js'

const HOUR = 3600
const pumpStarts: DetectorSpec = {
  type: 'count',
  event: { op: 'changesTo', value: true },
  window: HOUR,
  limit: 5
}

function start(at: ReturnType<typeof harness>['at'], t: number) {
  const transition = at(t, v(true))
  at(t + 30, v(false))
  return transition
}

describe('count detector', () => {
  it('six starts within an hour exceed a limit of five, and the window slides', () => {
    const { at } = harness(pumpStarts)
    at(0, v(false), true)
    for (const t of [100, 700, 1300, 1900, 2500]) expect(start(at, t)).toBeUndefined()
    expect(start(at, 3000)).toBe('set')
    expect(at(3699)).toBeUndefined()
    expect(at(3700)).toBe('clear')
  })

  it('a replayed value is not an event', () => {
    const { at, log } = harness({ ...pumpStarts, limit: 1 })
    at(0, v(true), true)
    at(10, v(false))
    expect(log).toEqual([])
  })

  it('started condition-active does not clear before one full window has elapsed', () => {
    const { at } = harness(pumpStarts, { active: true })
    at(0, v(false), true)
    expect(at(HOUR - 1)).toBeUndefined()
    expect(at(HOUR)).toBe('clear')
  })

  it('unavailable input holds the state', () => {
    const { at, detector } = harness({ ...pumpStarts, limit: 1 })
    start(at, 0)
    expect(start(at, 100)).toBe('set')
    at(200, UNAVAILABLE)
    expect(at(10 * HOUR)).toBeUndefined()
    expect(detector.active).toBe(true)
    expect(at(10 * HOUR, v(false))).toBe('clear')
  })
})
