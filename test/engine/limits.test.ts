import { describe, it, expect } from 'vitest'
import { bandOf, higherPriority, resolveLimit, type Zone } from '../../src/engine/limits.js'

const battery: Zone[] = [
  { upper: 11.5, state: 'alarm' },
  { lower: 11.5, upper: 12, state: 'warn' },
  { lower: 12, upper: 15, state: 'normal' }
]

const coolant: Zone[] = [
  { lower: 358, upper: 368, state: 'warn' },
  { lower: 368, state: 'alarm' }
]

describe('resolveLimit', () => {
  it('takes a fixed limit as it is', () => {
    expect(resolveLimit({ kind: 'fixed', value: 3 }, 'above', undefined)).toEqual({
      ok: true,
      value: 3
    })
  })

  it('a below limit is the top of the named level and everything more severe', () => {
    expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', battery)).toEqual({
      ok: true,
      value: 12
    })
    expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', battery)).toEqual({
      ok: true,
      value: 11.5
    })
  })

  it('an above limit is the bottom of the named level and everything more severe', () => {
    expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'above', coolant)).toEqual({
      ok: true,
      value: 358
    })
    expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', coolant)).toEqual({
      ok: true,
      value: 368
    })
  })

  it('a level with no zone of its own is missing, even when a more severe one exists', () => {
    const result = resolveLimit({ kind: 'zone', level: 'alert' }, 'above', coolant)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/no alert zone/)
  })

  it('no zones at all is missing', () => {
    for (const zones of [undefined, null, []]) {
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones).ok).toBe(false)
    }
  })

  it('a zone open on the side the condition enters from gives no limit', () => {
    const result = resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', coolant)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/no upper bound/)
  })
})

describe('bandOf', () => {
  it('lower bounds are inclusive, upper bounds exclusive, missing bounds unbounded', () => {
    expect(bandOf(11.5, battery)).toBe('warn')
    expect(bandOf(11.49, battery)).toBe('alarm')
    expect(bandOf(-100, battery)).toBe('alarm')
    expect(bandOf(12, battery)).toBeUndefined()
    expect(bandOf(1000, coolant)).toBe('alarm')
  })

  it('the most severe of overlapping zones wins', () => {
    expect(
      bandOf(5, [
        { lower: 0, upper: 10, state: 'warn' },
        { lower: 4, upper: 6, state: 'emergency' }
      ])
    ).toBe('emergency')
  })

  it('treats null bounds as missing, as JSON meta carries them', () => {
    expect(bandOf(1, [{ lower: null, upper: 2, state: 'alert' }])).toBe('alert')
  })

  it('ignores normal and nominal zones', () => {
    expect(bandOf(13, battery)).toBeUndefined()
  })
})

describe('higherPriority', () => {
  it('orders caution < warning < alarm < emergency', () => {
    expect(higherPriority('caution', 'warning')).toBe('warning')
    expect(higherPriority('emergency', 'alarm')).toBe('emergency')
    expect(higherPriority('alarm', undefined)).toBe('alarm')
  })
})
