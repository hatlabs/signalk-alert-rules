import { describe, expect, it } from 'vitest'
import type { Template } from '../../../src/model/template'
import {
  candidates,
  instanceError,
  pickKey,
  ruleWatching,
  templateTitle,
  typedCandidate,
  watchedPath
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
        signal: { paths: ['electrical.batteries.house.voltage'] },
        template: { set: 'builtin', id: lifepo4.id, pick: { instance: 'house' } }
      }
    })
    const otherSet = ruleEntry({
      slug: 'x',
      rule: {
        name: 'Other',
        signal: { paths: ['electrical.batteries.starter.voltage'] },
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

  it('names the rule by the path it watches now, not the pick it was made with', () => {
    const moved = ruleEntry({
      slug: 'battery-voltage-low-lifepo4-house',
      rule: {
        name: 'Starter voltage low',
        signal: { paths: ['electrical.batteries.starter.voltage'] },
        template: { set: 'builtin', id: lifepo4.id, pick: { instance: 'house' } }
      }
    })
    const found = candidates('builtin', lifepo4, boat, [moved])
    const named = found.filter((c) => c.ruleName !== undefined)
    expect(named.map((c) => [c.pick.instance, c.ruleName])).toEqual([
      ['starter', 'Starter voltage low']
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
    const pinned = ruleEntry({
      rule: {
        name: 'Heading from b.2',
        signal: { paths: ['navigation.headingMagnetic'] },
        source: 'b.2',
        template: { set: 'builtin', id: 'heading', pick: { source: 'a.1' } }
      }
    })
    expect(candidates('builtin', heading, paths, [pinned]).map((c) => c.ruleName)).toEqual([
      undefined,
      'Heading from b.2'
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
    expect(typedCandidate('builtin', lifepo4, 'windlass', boat, [])).toEqual({
      pick: { instance: 'windlass' },
      label: 'windlass',
      path: 'electrical.batteries.windlass.voltage',
      typed: true
    })
  })

  it('names the rule a typed instance already has from the template', () => {
    const made = ruleEntry({
      slug: 'battery-voltage-low-lifepo4-windlass',
      rule: {
        name: 'Windlass bank voltage low',
        signal: { paths: ['electrical.batteries.windlass.voltage'] },
        template: { set: 'builtin', id: lifepo4.id, pick: { instance: 'windlass' } }
      }
    })
    expect(typedCandidate('builtin', lifepo4, 'windlass', boat, [made]).ruleName).toBe(
      'Windlass bank voltage low'
    )
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

describe('a template with two slots', () => {
  const alternator: Template = {
    id: 'alternator-not-charging',
    slots: [
      { name: 'battery', label: 'Battery' },
      { name: 'engine', label: 'Engine' }
    ],
    condition: '${engine}AlternatorNotCharging',
    rule: {
      name: 'Engine ${engine} alternator not charging',
      message: 'Engine ${engine} is not charging battery ${battery}',
      signal: { path: 'electrical.batteries.${battery}.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 13, priority: 'warning' }]
      },
      gates: [
        {
          signal: { path: 'propulsion.${engine}.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 }
        }
      ]
    }
  }
  const madeFor = (pick: Record<string, string>, path = 'electrical.batteries.start.voltage') =>
    ruleEntry({
      slug: `made-${Object.values(pick).join('-')}`,
      rule: {
        name: `Made for ${Object.values(pick).join(' ')}`,
        signal: { paths: [path] },
        template: { set: 'builtin', id: alternator.id, pick }
      }
    })

  it('is titled by its rule name without any slot', () => {
    expect(templateTitle(alternator)).toBe('Engine alternator not charging')
  })

  it('watches its signal path with every slot filled in', () => {
    expect(watchedPath(alternator, { battery: 'start', engine: 'main' })).toBe(
      'electrical.batteries.start.voltage'
    )
  })

  it('tells picks apart by every slot, whatever the order of their keys', () => {
    expect(pickKey({ battery: 'start', engine: 'main' })).not.toBe(
      pickKey({ battery: 'start', engine: 'port' })
    )
    expect(pickKey({ battery: 'start', engine: 'main' })).toBe(
      pickKey({ engine: 'main', battery: 'start' })
    )
  })

  it('names the rule whose stored picks equal the row, all slots included', () => {
    const rules = [madeFor({ battery: 'start', engine: 'main' })]
    expect(ruleWatching('builtin', alternator, { battery: 'start', engine: 'main' }, rules)).toBe(
      'Made for start main'
    )
    expect(
      ruleWatching('builtin', alternator, { battery: 'start', engine: 'port' }, rules)
    ).toBeUndefined()
    expect(
      ruleWatching('extra', alternator, { battery: 'start', engine: 'main' }, rules)
    ).toBeUndefined()
  })

  it('matches on the stored picks even when the rule now watches another path', () => {
    const moved = madeFor(
      { battery: 'start', engine: 'main' },
      'electrical.batteries.house.voltage'
    )
    expect(ruleWatching('builtin', alternator, { battery: 'start', engine: 'main' }, [moved])).toBe(
      'Made for start main'
    )
  })

  it('never takes a rule made with a single instance as covering a row', () => {
    const old = madeFor({ instance: 'start' })
    expect(
      ruleWatching('builtin', alternator, { battery: 'start', engine: 'main' }, [old])
    ).toBeUndefined()
  })

  // Both sanitise to the same condition and alert path, which the server
  // refuses for the second rule; their stored picks still differ.
  it('counts picks that sanitise alike as different picks', () => {
    const rules = [madeFor({ battery: 'start', engine: 'port:1' })]
    expect(
      ruleWatching('builtin', alternator, { battery: 'start', engine: 'port_1' }, rules)
    ).toBeUndefined()
  })
})
