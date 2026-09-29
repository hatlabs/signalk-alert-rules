import { describe, it, expect } from 'vitest'
import { resolveLimit, type Zone } from '../../src/engine/limits.js'

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
