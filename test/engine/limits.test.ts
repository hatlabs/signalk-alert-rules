import { describe, it, expect } from 'vitest'
import { resolveLimit, severerLevels, type Zone } from '../../src/engine/limits.js'

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

  it('a level whose zones are all on the other side is missing on the rule side', () => {
    const result = resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', coolant)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/no alarm zone on the low side/)
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

    it('places a zone bounded on both sides by where it lies against the normal zones', () => {
      const capped: Zone[] = [...house.slice(0, 2), { lower: 14.8, upper: 20, state: 'alarm' }]
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', capped)).toEqual({
        ok: true,
        value: 11.5
      })
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', capped)).toEqual({
        ok: true,
        value: 14.8
      })
    })

    it('measures against the outer edges of all normal and nominal zones together', () => {
      const split: Zone[] = [
        { lower: 10, upper: 11, state: 'alarm' },
        { lower: 11, upper: 12.5, state: 'nominal' },
        { lower: 12.5, upper: 14, state: 'normal' },
        { lower: 14, upper: 16, state: 'alarm' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', split)).toEqual({
        ok: true,
        value: 11
      })
      expect(resolveLimit({ kind: 'zone', level: 'alarm' }, 'above', split)).toEqual({
        ok: true,
        value: 14
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
      expect(!result.ok && result.reason).toMatch(/no warn zone on the low side/)
    })
  })

  describe('a zone bounded on both sides whose side cannot be told', () => {
    it('fails when it overlaps the normal zones', () => {
      const zones: Zone[] = [
        { upper: 11.5, state: 'alarm' },
        { lower: 11.5, upper: 14.8, state: 'normal' },
        { lower: 14, upper: 15, state: 'warn' }
      ]
      const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'above', zones)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.reason).toMatch(
        /side of the warn zone from 14 to 15 cannot be told/
      )
      expect(!result.ok && result.reason).toMatch(/add a normal zone/)
    })

    it('fails when there is no normal zone and one-sided zones lie on both sides', () => {
      const zones: Zone[] = [
        { upper: 11.5, state: 'alarm' },
        { lower: 11.5, upper: 12, state: 'warn' },
        { lower: 14.8, state: 'alarm' }
      ]
      const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.reason).toMatch(
        /side of the warn zone from 11.5 to 12 cannot be told/
      )
    })

    it('fails when nothing on the path is one-sided', () => {
      const zones: Zone[] = [{ lower: 0, upper: 5, state: 'alarm' }]
      const result = resolveLimit({ kind: 'zone', level: 'alarm' }, 'below', zones)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.reason).toMatch(
        /side of the alarm zone from 0 to 5 cannot be told/
      )
    })

    it('blocks a less severe level too, since its edge could move', () => {
      const zones: Zone[] = [
        { upper: 11, state: 'warn' },
        { lower: 11, upper: 14.8, state: 'normal' },
        { lower: 10, upper: 20, state: 'alarm' }
      ]
      expect(resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones).ok).toBe(false)
    })

    it('does not matter below the named level', () => {
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

  it('a zone with neither bound fails when it is at or above the named level', () => {
    const zones: Zone[] = [...battery, { lower: null, upper: null, state: 'alarm' }]
    const result = resolveLimit({ kind: 'zone', level: 'warn' }, 'below', zones)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/alarm zone has neither bound/)
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
    const gapped = graded.filter((z) => z.state !== 'alarm')
    expect(severerLevels({ kind: 'zone', level: 'warn' }, 'above', gapped)).toEqual([
      { level: 'emergency', value: 380 }
    ])
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
})
