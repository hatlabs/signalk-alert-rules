import { describe, it, expect } from 'vitest'
import {
  limitDirection,
  resolveLimit,
  severerLevels,
  zoneLimitLevels,
  zonePath,
  type Zone
} from '../../src/engine/limits.js'
import type { Signal } from '../../src/model/rule.js'

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
    expect(result).toEqual({ ok: false, missing: { level: 'alert' } })
  })

  it('no zones at all is missing', () => {
    for (const zones of [undefined, null, []]) {
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones).ok).toBe(false)
    }
  })

  it('a level whose zones are all on the other side is missing on the rule side', () => {
    const result = resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', coolant)
    expect(result.ok).toBe(false)
    expect(result).toEqual({ ok: false, missing: { level: 'alarm', side: 'low' } })
  })

  describe('on a path with zones on both sides', () => {
    const house: Zone[] = [
      { upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 14.8, state: 'normal' },
      { lower: 14.8, state: 'alarm' }
    ]

    it('takes only the zones on the rule side', () => {
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', house)).toEqual({
        ok: true,
        value: 11.5
      })
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', house)).toEqual({
        ok: true,
        value: 14.8
      })
    })

    it('needs no normal zone to tell the sides apart', () => {
      const bare: Zone[] = [
        { upper: 11.5, state: 'alarm' },
        { lower: 14.8, upper: 20, state: 'alarm' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', bare)).toEqual({
        ok: true,
        value: 11.5
      })
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', bare)).toEqual({
        ok: true,
        value: 14.8
      })
    })

    it('is not moved by a far-side zone overlapping the normal zone', () => {
      const zones: Zone[] = [
        { upper: 11.5, state: 'alarm' },
        { lower: 11.5, upper: 14.5, state: 'normal' },
        { lower: 14.4, upper: 20, state: 'emergency' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', zones)).toEqual({
        ok: true,
        value: 11.5
      })
    })

    it('a level defined only on the other side is missing', () => {
      const highWarn: Zone[] = [
        { upper: 11.5, state: 'alarm' },
        { lower: 11.5, upper: 14.4, state: 'normal' },
        { lower: 14.4, upper: 14.8, state: 'warn' },
        { lower: 14.8, state: 'alarm' }
      ]
      const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', highWarn)
      expect(result.ok).toBe(false)
      expect(result).toEqual({ ok: false, missing: { level: 'warn', side: 'low' } })
    })

    it('a low side lacking the level fails even when the high side is bounded', () => {
      const zones: Zone[] = [
        { upper: 11.5, state: 'alarm' },
        { lower: 14.8, upper: 20, state: 'warn' }
      ]
      const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones)
      expect(result.ok).toBe(false)
      expect(result).toEqual({ ok: false, missing: { level: 'warn', side: 'low' } })
    })
  })

  describe('on a path zoned only on one side, with every zone bounded', () => {
    it('an above limit is the bottom of the graded zones', () => {
      const rpm: Zone[] = [
        { lower: 3200, upper: 3600, state: 'warn' },
        { lower: 3600, upper: 4000, state: 'alarm' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'above', rpm)).toEqual({
        ok: true,
        value: 3200
      })
    })

    it('a below limit is the top of the graded zones', () => {
      const depth: Zone[] = [
        { lower: 0, upper: 2, state: 'alarm' },
        { lower: 2, upper: 3, state: 'warn' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', depth)).toEqual({
        ok: true,
        value: 3
      })
    })

    it('a single zone resolves on its own', () => {
      const zones: Zone[] = [{ lower: 0, upper: 5, state: 'alarm' }]
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', zones)).toEqual({
        ok: true,
        value: 5
      })
    })

    it('a below limit on a path zoned only above is missing on the low side', () => {
      const rpm: Zone[] = [
        { lower: 3200, upper: 3600, state: 'warn' },
        { lower: 3600, upper: 4000, state: 'alarm' }
      ]
      for (const zones of [rpm, [{ lower: 0, upper: 3200, state: 'normal' }, ...rpm]]) {
        const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones)
        expect(result.ok).toBe(false)
        expect(result).toEqual({ ok: false, missing: { level: 'warn', side: 'low' } })
      }
    })

    it('an above limit on a path zoned only below is missing on the high side', () => {
      const depth: Zone[] = [
        { lower: 0, upper: 2, state: 'alarm' },
        { lower: 2, upper: 3, state: 'warn' }
      ]
      const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'above', depth)
      expect(result.ok).toBe(false)
      expect(result).toEqual({ ok: false, missing: { level: 'warn', side: 'high' } })
    })

    it('a more severe band nested at the far end keeps the far edge from the rule', () => {
      const tank: Zone[] = [
        { lower: 0.8, upper: 1, state: 'warn' },
        { lower: 0.9, upper: 1, state: 'alarm' }
      ]
      const low = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', tank)
      expect(low.ok).toBe(false)
      expect(low).toEqual({ ok: false, missing: { level: 'warn', side: 'low' } })
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'above', tank)).toEqual({
        ok: true,
        value: 0.8
      })
      expect(severerLevels({ kind: 'zone', level: 'warn' }, 'above', tank)).toEqual([
        { level: 'alarm', value: 0.9 }
      ])
      const depth: Zone[] = [
        { lower: 0, upper: 3, state: 'warn' },
        { lower: 0, upper: 2, state: 'alarm' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'above', depth).ok).toBe(false)
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', depth)).toEqual({
        ok: true,
        value: 3
      })
    })

    it('resolves only on the side the zones are graded toward', () => {
      const waste: Zone[] = [
        { lower: 0, upper: 0.8, state: 'normal' },
        { lower: 0.8, upper: 0.9, state: 'warn' },
        { lower: 0.9, upper: 1, state: 'alarm' }
      ]
      const low = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', waste)
      expect(low.ok).toBe(false)
      expect(low).toEqual({ ok: false, missing: { level: 'warn', side: 'low' } })
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'above', waste)).toEqual({
        ok: true,
        value: 0.8
      })
      expect(severerLevels({ kind: 'zone', level: 'warn' }, 'above', waste)).toEqual([
        { level: 'alarm', value: 0.9 }
      ])
    })

    it('fails when a gap separates the named level from the outermost zones', () => {
      const gapped: Zone[] = [
        { lower: 3200, upper: 3600, state: 'warn' },
        { lower: 3800, upper: 4000, state: 'alarm' }
      ]
      const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'above', gapped)
      expect(result.ok).toBe(false)
      expect(result).toEqual({ ok: false, missing: { level: 'warn', side: 'high' } })
    })
  })

  describe('zones in states that are not alert levels', () => {
    it('play no part, even when a normal zone spans the whole range', () => {
      const alarm: Zone = { lower: 90, upper: 100, state: 'alarm' }
      for (const normal of [{ lower: 0, upper: 100, state: 'normal' }, { state: 'normal' }]) {
        expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', [normal, alarm])).toEqual({
          ok: true,
          value: 90
        })
      }
    })

    it('neither do zones below the named level', () => {
      const zones: Zone[] = [
        { upper: 11, state: 'alarm' },
        { lower: 11, upper: 14.8, state: 'normal' },
        { lower: 10, upper: 20, state: 'alert' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', zones)).toEqual({
        ok: true,
        value: 11
      })
    })
  })

  it('a zone with neither bound at or above the named level leaves no edge', () => {
    const zones: Zone[] = [...battery, { lower: null, upper: null, state: 'alarm' }]
    const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones)
    expect(result.ok).toBe(false)
    expect(result).toEqual({ ok: false, missing: { level: 'warn', side: 'low' } })
  })

  it('takes a null bound as missing', () => {
    const zones: Zone[] = [
      { lower: null, upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 14.8, state: 'normal' },
      { lower: 14.8, upper: null, state: 'alarm' }
    ]
    expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', zones)).toEqual({
      ok: true,
      value: 11.5
    })
  })
})

describe('severerLevels', () => {
  const graded: Zone[] = [
    { lower: 340, upper: 358, state: 'alert' },
    ...coolant,
    { lower: 380, state: 'emergency' }
  ]

  it('gives every more severe level the zones define, each with its own threshold', () => {
    expect(severerLevels({ kind: 'zone', level: 'alert' }, 'above', graded)).toEqual([
      { level: 'warn', value: 358 },
      { level: 'alarm', value: 368 },
      { level: 'emergency', value: 380 }
    ])
  })

  it('skips a level the zones do not define', () => {
    const skipped: Zone[] = [
      { lower: 358, upper: 368, state: 'warn' },
      { lower: 368, state: 'emergency' }
    ]
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'above', skipped)).toEqual([
      { level: 'emergency', value: 368 }
    ])
  })

  it('grades a bounded one-sided path level by level', () => {
    const tank: Zone[] = [
      { lower: 0, upper: 0.02, state: 'emergency' },
      { lower: 0.02, upper: 0.05, state: 'alarm' },
      { lower: 0.05, upper: 0.1, state: 'warn' },
      { lower: 0.1, upper: 0.2, state: 'alert' }
    ]
    expect(resolveLimit({ kind: 'zone', level: 'alert' }, 'below', tank)).toEqual({
      ok: true,
      value: 0.2
    })
    expect(severerLevels({ kind: 'zone', level: 'alert' }, 'below', tank)).toEqual([
      { level: 'warn', value: 0.1 },
      { level: 'alarm', value: 0.05 },
      { level: 'emergency', value: 0.02 }
    ])
  })

  it('gives a bounded more severe zone above the named one', () => {
    const rpm: Zone[] = [
      { lower: 3200, upper: 3600, state: 'warn' },
      { lower: 3600, upper: 4000, state: 'alarm' }
    ]
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'above', rpm)).toEqual([
      { level: 'alarm', value: 3600 }
    ])
  })

  it('drops a more severe level that lies only on the far side', () => {
    const zones: Zone[] = [
      { upper: 12, state: 'warn' },
      { lower: 14.8, upper: 20, state: 'alarm' }
    ]
    expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones)).toEqual({
      ok: true,
      value: 12
    })
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'below', zones)).toEqual([])
    expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', zones)).toEqual({
      ok: true,
      value: 14.8
    })
  })

  it('ignores the zones on the other side', () => {
    const twoSided: Zone[] = [
      { upper: 10.5, state: 'emergency' },
      { lower: 10.5, upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 12, state: 'warn' },
      { lower: 12, upper: 14.4, state: 'normal' },
      { lower: 14.4, upper: 14.8, state: 'warn' },
      { lower: 14.8, state: 'alarm' }
    ]
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'below', twoSided)).toEqual([
      { level: 'alarm', value: 11.5 },
      { level: 'emergency', value: 10.5 }
    ])
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'above', twoSided)).toEqual([
      { level: 'alarm', value: 14.8 }
    ])
  })

  it('is empty when nothing more severe than the named level is defined', () => {
    expect(severerLevels({ kind: 'zone', level: 'alarm' }, 'below', battery)).toEqual([])
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'below', undefined)).toEqual([])
  })

  it('is empty when the named level itself does not resolve', () => {
    const zones: Zone[] = [
      { lower: 14.8, upper: 20, state: 'warn' },
      { upper: 11.5, state: 'alarm' }
    ]
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'below', zones)).toEqual([])
  })
})

describe('zonePath', () => {
  const warn = { kind: 'zone', level: 'warn' } as const
  const mean: Signal = {
    combinator: 'mean',
    inputs: [{ path: 'a.voltage' }, { path: 'b.voltage' }]
  }

  it("reads the signal path's zones when the limit names no path", () => {
    expect(zonePath(warn, { path: 'a.voltage' })).toBe('a.voltage')
  })

  it("reads the limit's own path over the signal's", () => {
    expect(zonePath({ ...warn, path: 'b.voltage' }, { path: 'a.voltage' })).toBe('b.voltage')
  })

  it('has no path for a combined signal unless the limit names one', () => {
    expect(zonePath(warn, mean)).toBeUndefined()
    expect(zonePath({ ...warn, path: 'b.voltage' }, mean)).toBe('b.voltage')
  })
})

describe('limitDirection', () => {
  const limit = { kind: 'zone', level: 'warn' } as const
  const projection = { type: 'projection', limit, window: 300, horizon: 600 } as const

  it.each(['above', 'below'] as const)('takes a sustained %s as it is', (direction) => {
    expect(limitDirection({ type: 'sustained', direction, limit })).toBe(direction)
  })

  it('compares a rising projection above its limit and a falling one below', () => {
    expect(limitDirection({ ...projection, direction: 'rising' })).toBe('above')
    expect(limitDirection({ ...projection, direction: 'falling' })).toBe('below')
  })
})

describe('zoneLimitLevels', () => {
  const warn = { kind: 'zone', level: 'warn' } as const
  const sustained = (direction: 'above' | 'below') =>
    ({ type: 'sustained', direction, limit: warn }) as const
  const projection = (direction: 'rising' | 'falling') =>
    ({ type: 'projection', direction, limit: warn, window: 300, horizon: 600 }) as const

  it('gives a sustained detector the named level and every more severe one', () => {
    expect(zoneLimitLevels(sustained('below'), warn, battery)).toEqual({
      ok: true,
      levels: [
        { level: 'warn', value: 12 },
        { level: 'alarm', value: 11.5 }
      ]
    })
    expect(zoneLimitLevels(sustained('above'), warn, coolant)).toEqual({
      ok: true,
      levels: [
        { level: 'warn', value: 358 },
        { level: 'alarm', value: 368 }
      ]
    })
  })

  it('gives a projection the named level only, on the side its trend heads', () => {
    expect(zoneLimitLevels(projection('falling'), warn, battery)).toEqual({
      ok: true,
      levels: [{ level: 'warn', value: 12 }]
    })
    expect(zoneLimitLevels(projection('rising'), warn, coolant)).toEqual({
      ok: true,
      levels: [{ level: 'warn', value: 358 }]
    })
  })

  it('fails as the named level fails to resolve', () => {
    const emergency = { kind: 'zone', level: 'emergency' } as const
    expect(zoneLimitLevels(sustained('below'), emergency, battery)).toEqual({
      ok: false,
      missing: { level: 'emergency' }
    })
    expect(zoneLimitLevels(sustained('above'), warn, battery)).toEqual({
      ok: false,
      missing: { level: 'warn', side: 'high' }
    })
  })
})
