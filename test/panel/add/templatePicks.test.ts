import { describe, expect, it } from 'vitest'
import type { Template } from '../../../src/model/template'
import {
  candidates,
  instanceError,
  pickKey,
  templateTitle,
  typedCandidate
} from '../../../src/panel/add/templatePicks'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { displayUnit } from '../../../src/panel/units'
import { ruleEntry } from '../fixtures'

const volts = displayUnit({ units: 'V' })
const voltage = (instance: string, value: number, extra: Partial<PathEntry> = {}): PathEntry => ({
  path: `electrical.batteries.${instance}.voltage`,
  units: 'V',
  unit: volts,
  value,
  ...extra
})

/** A house bank, a starter battery and two Ruuvitags reporting their coin cells. */
const boat: PathEntry[] = [
  voltage('house', 13.28),
  { path: 'electrical.batteries.house.name', unit: displayUnit({}), value: 'House bank' },
  voltage('starter', 12.71),
  voltage('ruuvi-saloon', 3.01, { displayName: 'Saloon RuuviTag battery' }),
  voltage('ruuvi-cockpit', 2.98),
  { path: 'electrical.batteries.house.current', units: 'A', unit: displayUnit({}), value: 4 }
]

const lifepo4: Template = {
  id: 'battery-voltage-low-lifepo4',
  open: ['instance'],
  condition: 'voltageLow',
  rule: {
    name: 'Battery ${instance} voltage low (LiFePO4)',
    message: 'Battery ${instance} voltage below {limit}: {value}',
    signal: { path: 'electrical.batteries.${instance}.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [{ limit: 12.8, priority: 'warning' }]
    }
  }
}

describe('templateTitle', () => {
  it('is the rule name without its instance', () => {
    expect(templateTitle(lifepo4)).toBe('Battery voltage low (LiFePO4)')
  })

  it('is the rule name of a template with nothing open', () => {
    expect(
      templateTitle({ ...lifepo4, open: [], rule: { ...lifepo4.rule, name: 'Shallow water' } })
    ).toBe('Shallow water')
  })
})

describe('candidates', () => {
  it('lists every instance reporting under the open path, with its name, path and value', () => {
    const found = candidates('builtin', lifepo4, boat, [])
    expect(found.map((c) => [c.label, c.path, c.entry?.value])).toEqual([
      ['House bank', 'electrical.batteries.house.voltage', 13.28],
      ['ruuvi-cockpit', 'electrical.batteries.ruuvi-cockpit.voltage', 2.98],
      ['Saloon RuuviTag battery', 'electrical.batteries.ruuvi-saloon.voltage', 3.01],
      ['starter', 'electrical.batteries.starter.voltage', 12.71]
    ])
    expect(found.map((c) => c.pick)).toEqual([
      { instance: 'house' },
      { instance: 'ruuvi-cockpit' },
      { instance: 'ruuvi-saloon' },
      { instance: 'starter' }
    ])
  })

  it('names the rule an instance already has from the same template', () => {
    const made = ruleEntry({
      slug: 'battery-voltage-low-lifepo4-house',
      rule: {
        name: 'House bank voltage low',
        template: { set: 'builtin', id: lifepo4.id, pick: { instance: 'house' } }
      }
    })
    const otherSet = ruleEntry({
      slug: 'x',
      rule: {
        name: 'Other',
        template: { set: 'extra', id: lifepo4.id, pick: { instance: 'starter' } }
      }
    })
    const found = candidates('builtin', lifepo4, boat, [made, otherSet])
    expect(found.map((c) => c.ruleName)).toEqual([
      'House bank voltage low',
      undefined,
      undefined,
      undefined
    ])
  })

  it('lists nothing when nothing reports under the open path', () => {
    expect(candidates('builtin', lifepo4, [], [])).toEqual([])
  })

  it('lists each source of the path for a template whose source is open', () => {
    const heading: Template = {
      id: 'heading',
      open: ['source'],
      rule: {
        name: 'Heading',
        message: 'm',
        signal: { path: 'navigation.headingMagnetic' },
        detector: {}
      }
    }
    const paths: PathEntry[] = [
      {
        path: 'navigation.headingMagnetic',
        unit: displayUnit({}),
        value: 1,
        sources: ['a.1', 'b.2']
      }
    ]
    expect(candidates('builtin', heading, paths, []).map((c) => [c.label, c.pick])).toEqual([
      ['a.1', { source: 'a.1' }],
      ['b.2', { source: 'b.2' }]
    ])
  })

  it('pairs each instance with each of its sources when both are open', () => {
    const both: Template = { ...lifepo4, open: ['instance', 'source'] }
    const paths = [
      voltage('house', 13, { sources: ['shunt.1', 'cerbo.2'] }),
      voltage('starter', 12)
    ]
    expect(candidates('builtin', both, paths, []).map((c) => [c.label, c.pick])).toEqual([
      ['house · shunt.1', { instance: 'house', source: 'shunt.1' }],
      ['house · cerbo.2', { instance: 'house', source: 'cerbo.2' }]
    ])
  })

  it('offers the one rule of a template with nothing open, reported or not', () => {
    const depth: Template = {
      id: 'depth-shallow',
      rule: {
        name: 'Shallow water',
        message: 'm',
        signal: { path: 'environment.depth.belowTransducer' },
        detector: {}
      }
    }
    expect(candidates('builtin', depth, [], [])).toEqual([
      { pick: {}, label: 'Shallow water', path: 'environment.depth.belowTransducer' }
    ])
  })

  it('enumerates a combined signal by its input that carries the instance', () => {
    const combined: Template = {
      ...lifepo4,
      rule: {
        ...lifepo4.rule,
        signal: {
          combinator: 'difference',
          inputs: [
            { path: 'environment.outside.temperature' },
            { path: 'electrical.batteries.${instance}.voltage' }
          ]
        }
      }
    }
    expect(candidates('builtin', combined, boat, []).map((c) => c.pick.instance)).toEqual([
      'house',
      'ruuvi-cockpit',
      'ruuvi-saloon',
      'starter'
    ])
  })
})

describe('typed instances', () => {
  it('makes a pick for an instance nothing reports yet', () => {
    expect(typedCandidate(lifepo4, 'windlass', boat)).toEqual({
      pick: { instance: 'windlass' },
      label: 'windlass',
      path: 'electrical.batteries.windlass.voltage',
      typed: true
    })
  })

  it('refuses what is not one path segment', () => {
    expect(instanceError('wind lass')).toMatch(/one path segment/)
    expect(instanceError('a.b')).toMatch(/one path segment/)
    expect(instanceError('*')).toMatch(/one path segment/)
    expect(instanceError('')).toBe('Type the name used in the path.')
    expect(instanceError('windlass')).toBeUndefined()
  })

  it('tells picks apart by instance and source', () => {
    expect(pickKey({ instance: 'a' })).not.toBe(pickKey({ source: 'a' }))
    expect(pickKey({ instance: 'a', source: 'b' })).toBe(pickKey({ source: 'b', instance: 'a' }))
  })
})
