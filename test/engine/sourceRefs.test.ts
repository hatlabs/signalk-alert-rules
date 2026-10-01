import { describe, expect, it } from 'vitest'
import { canonicalSourceRef, canonicalSources } from '../../src/engine/sourceRefs.js'
import type { Rule } from '../../src/model/rule.js'

const CAN_NAME = 'c0ffee0123456789'

/** A sources tree as the server keeps it, for an NMEA 2000 provider with `useCanName` off. */
function sourcesTree(): Record<string, unknown> {
  return {
    can0: {
      label: 'can0',
      type: 'NMEA2000',
      '10': { n2k: { src: '10', canName: CAN_NAME, pgns: {} } },
      '22': { n2k: { src: '22', pgns: {} } }
    },
    nmea0183: { label: 'nmea0183', type: 'NMEA0183', GP: { talker: 'GP', sentences: {} } },
    'signalk-derived-data': { label: 'signalk-derived-data', type: 'signalk' }
  }
}

describe('canonicalSourceRef', () => {
  it('turns the address form of a device with a CAN name into its CAN name form', () => {
    expect(canonicalSourceRef(sourcesTree(), 'can0.10')).toBe(`can0.${CAN_NAME}`)
  })

  it('leaves a CAN name form ref as it is', () => {
    expect(canonicalSourceRef(sourcesTree(), `can0.${CAN_NAME}`)).toBe(`can0.${CAN_NAME}`)
  })

  it('leaves an NMEA 2000 device whose CAN name is not known as it is', () => {
    expect(canonicalSourceRef(sourcesTree(), 'can0.22')).toBe('can0.22')
  })

  it('leaves NMEA 0183, plugin and unknown sources as they are', () => {
    const sources = sourcesTree()
    expect(canonicalSourceRef(sources, 'nmea0183.GP')).toBe('nmea0183.GP')
    expect(canonicalSourceRef(sources, 'signalk-derived-data')).toBe('signalk-derived-data')
    expect(canonicalSourceRef(sources, 'gnss.bow')).toBe('gnss.bow')
  })

  it('never reads the connection fields as devices', () => {
    const sources = { can0: { label: 'can0', type: { n2k: { canName: CAN_NAME } } } }
    expect(canonicalSourceRef(sources, 'can0.type')).toBe('can0.type')
  })

  it('leaves the ref as it is without a sources tree', () => {
    expect(canonicalSourceRef(undefined, 'can0.10')).toBe('can0.10')
  })
})

describe('canonicalSources', () => {
  const canonical = (ref: string) => canonicalSourceRef(sourcesTree(), ref)
  const rule: Rule = {
    name: 'Headings disagree',
    slug: 'headings-disagree',
    message: 'Compasses disagree',
    priority: 'warning',
    signal: {
      combinator: 'absDifference',
      angular: true,
      inputs: [
        { path: 'navigation.headingMagnetic', source: 'can0.10' },
        { path: 'navigation.headingMagnetic', source: 'nmea0183.GP' }
      ]
    },
    detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 0.1 } },
    gates: [
      {
        signal: { path: 'navigation.speedOverGround', source: 'can0.10' },
        direction: 'above',
        limit: { kind: 'fixed', value: 1 }
      },
      {
        signal: { path: 'propulsion.main.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 1 }
      }
    ]
  }

  it('stores every pinned source of the signal and the gates in canonical form', () => {
    const result = canonicalSources(rule, canonical)
    expect(result.signal).toEqual({
      ...rule.signal,
      inputs: [
        { path: 'navigation.headingMagnetic', source: `can0.${CAN_NAME}` },
        { path: 'navigation.headingMagnetic', source: 'nmea0183.GP' }
      ]
    })
    expect(result.gates?.map((g) => g.signal)).toEqual([
      { path: 'navigation.speedOverGround', source: `can0.${CAN_NAME}` },
      { path: 'propulsion.main.revolutions' }
    ])
    expect({ ...result, signal: rule.signal, gates: rule.gates }).toEqual(rule)
  })

  it('leaves a rule without gates without gates', () => {
    const { gates: _gates, ...ungated } = rule
    expect('gates' in canonicalSources(ungated, canonical)).toBe(false)
  })
})
