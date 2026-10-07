import { describe, expect, it } from 'vitest'
import type { Template } from '../../../src/model/template'
import {
  candidates,
  instanceError,
  labelsJoined,
  openPattern,
  pickKey,
  pickReports,
  restoredPick,
  rowsProblem,
  ruleWatching,
  slotCandidates,
  slotPattern,
  templateTitle,
  typedCandidate,
  watchedPath,
  watchedSlots,
  withArticle,
  type SlotCandidate
} from '../../../src/panel/add/templatePicks'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { displayUnit } from '../../../src/panel/units'
import { BUILTIN_TEMPLATES, discoverTemplateSets } from '../../../src/templates/discovery'
import { INSTANCE_SLOT } from '../../../src/templates/instantiate'
import { ruleEntry } from '../fixtures'
import { reported } from '../reportedPaths'

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

describe('the built-in templates', () => {
  it('list the same picks, names, paths and values as before templates had slots', () => {
    const { sets } = discoverTemplateSets({ builtin: BUILTIN_TEMPLATES })
    const templates = sets.find((s) => s.set.id === 'builtin')?.set.templates ?? []
    const listed = Object.fromEntries(
      templates.map((t) => [
        t.id,
        candidates('builtin', t, reported, []).map((c) => [c.label, c.path, c.pick, c.entry?.value])
      ])
    )
    const batteries = [
      [
        'Bow thruster battery voltage',
        'electrical.batteries.bowThruster.voltage',
        { instance: 'bowThruster' },
        12.9
      ],
      ['House battery voltage', 'electrical.batteries.house.voltage', { instance: 'house' }, 13.31],
      ['start', 'electrical.batteries.start.voltage', { instance: 'start' }, 12.6]
    ]
    const bilgePump = [
      ['bilgePump', 'electrical.switches.bilgePump.state', { instance: 'bilgePump' }, false]
    ]
    expect(listed).toEqual({
      'battery-charge-low': [],
      'battery-charge-low-lifepo4': [],
      'battery-voltage-low': batteries,
      'battery-voltage-low-lifepo4': batteries,
      'battery-voltage-high': batteries,
      'battery-voltage-high-lifepo4': batteries,
      'engine-temperature-high': [],
      'engine-oil-pressure-low': [],
      'alternator-not-charging': [],
      'engine-service-due': [
        ['main', 'propulsion.main.revolutions', { instance: 'main' }, 0],
        ['port', 'propulsion.port.revolutions', { instance: 'port' }, 20],
        ['starboard', 'propulsion.starboard.revolutions', { instance: 'starboard' }, 20]
      ],
      'fuel-low': [],
      'holding-tank-full': [],
      'fresh-water-low': [['0', 'tanks.freshWater.0.currentLevel', { instance: '0' }, 0.6]],
      'bilge-pump-running-long': bilgePump,
      'bilge-pump-cycling': bilgePump,
      'depth-shallow': [['Shallow water', 'environment.depth.belowTransducer', {}, 4.2]],
      'wind-strong': [['Strong wind', 'environment.wind.speedApparent', {}, undefined]],
      'depth-not-reporting': [
        ['Depth sounder not reporting', 'environment.depth.belowTransducer', {}, 4.2]
      ],
      'position-not-reporting': [['Position not reporting', 'navigation.position', {}, undefined]]
    })
  })

  it('offer for the alternator an engine that reports only its revolutions', () => {
    const { sets } = discoverTemplateSets({ builtin: BUILTIN_TEMPLATES })
    const alternator = sets
      .find((s) => s.set.id === 'builtin')
      ?.set.templates.find((t) => t.id === 'alternator-not-charging')
    if (alternator === undefined) throw new Error('no built-in alternator template')
    const engineBoat: PathEntry[] = [
      voltage('start', 12.6),
      {
        path: 'propulsion.main.revolutions',
        units: 'Hz',
        unit: displayUnit({ units: 'Hz' }),
        value: 30
      }
    ]
    const offered = (slot: string) =>
      slotCandidates(alternator, slot, engineBoat).map((c) => c.instance)
    expect(offered('engine')).toEqual(['main'])
    expect(offered('battery')).toEqual(['start'])
  })
})

describe('typed instances', () => {
  it('makes a pick for an instance nothing reports yet', () => {
    expect(typedCandidate('builtin', lifepo4, INSTANCE_SLOT, 'windlass', boat, [])).toEqual({
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
    expect(
      typedCandidate('builtin', lifepo4, INSTANCE_SLOT, 'windlass', boat, [made]).ruleName
    ).toBe('Windlass bank voltage low')
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

describe('a template on a field whose slot is directly before the pointer', () => {
  const fieldBoat: PathEntry[] = [
    { path: 'electrical.batteries.house#/voltage', unit: volts, value: 13.2 },
    { path: 'electrical.batteries.start#/voltage', unit: volts, value: 12.6 },
    { path: 'electrical.batteries.start#/current', unit: volts, value: 1 },
    voltage('aux', 12.1)
  ]
  const fieldLow: Template = {
    ...lifepo4,
    open: undefined,
    slots: [{ name: 'battery', label: 'Battery' }],
    rule: { ...lifepo4.rule, signal: { path: 'electrical.batteries.${battery}#/voltage' } }
  }

  it('lists the instances reporting the field, never the plain path', () => {
    expect(candidates('builtin', fieldLow, fieldBoat, []).map((c) => [c.path, c.pick])).toEqual([
      ['electrical.batteries.house#/voltage', { battery: 'house' }],
      ['electrical.batteries.start#/voltage', { battery: 'start' }]
    ])
    expect(slotCandidates(fieldLow, 'battery', fieldBoat).map((c) => c.instance)).toEqual([
      'house',
      'start'
    ])
  })
})

describe('a template with one slot named other than instance', () => {
  const batteryLow: Template = {
    ...lifepo4,
    open: undefined,
    slots: [{ name: 'battery', label: 'Battery' }],
    rule: {
      ...lifepo4.rule,
      name: 'Battery ${battery} voltage low',
      message: 'Battery ${battery} voltage below {limit}: {value}',
      signal: { path: 'electrical.batteries.${battery}.voltage' }
    }
  }

  it('lists the instances reporting under its path, picked by the slot’s name', () => {
    const found = candidates('builtin', batteryLow, boat, [])
    expect(found.map((c) => [c.label, c.path, c.pick])).toEqual([
      ['House bank', 'electrical.batteries.house.voltage', { battery: 'house' }],
      ['ruuvi-cockpit', 'electrical.batteries.ruuvi-cockpit.voltage', { battery: 'ruuvi-cockpit' }],
      [
        'Saloon RuuviTag battery',
        'electrical.batteries.ruuvi-saloon.voltage',
        { battery: 'ruuvi-saloon' }
      ],
      ['starter', 'electrical.batteries.starter.voltage', { battery: 'starter' }]
    ])
  })

  it('makes a pick by the slot’s name for a typed instance', () => {
    expect(
      typedCandidate(
        'builtin',
        batteryLow,
        { name: 'battery', label: 'Battery' },
        'windlass',
        boat,
        []
      )
    ).toEqual({
      pick: { battery: 'windlass' },
      label: 'windlass',
      path: 'electrical.batteries.windlass.voltage',
      typed: true
    })
  })

  it('shows its path with the slot as a name to fill in', () => {
    expect(openPattern(batteryLow)).toBe('electrical.batteries.<name>.voltage')
  })

  it('enumerates a combined signal by its input that carries the slot', () => {
    const combined: Template = {
      ...batteryLow,
      rule: {
        ...batteryLow.rule,
        signal: {
          combinator: 'difference',
          inputs: [
            { path: 'environment.outside.temperature' },
            { path: 'electrical.batteries.${battery}.voltage' }
          ]
        }
      }
    }
    expect(candidates('builtin', combined, boat, []).map((c) => c.pick)).toEqual([
      { battery: 'house' },
      { battery: 'ruuvi-cockpit' },
      { battery: 'ruuvi-saloon' },
      { battery: 'starter' }
    ])
  })

  describe('used only in a gate', () => {
    const whileRunning: Template = {
      ...batteryLow,
      slots: [{ name: 'engine', label: 'Engine' }],
      rule: {
        ...batteryLow.rule,
        name: 'Starter low while ${engine} runs',
        message: 'Starter low while ${engine} runs',
        signal: { path: 'electrical.batteries.starter.voltage' },
        gates: [
          {
            signal: { path: 'propulsion.${engine}.revolutions' },
            direction: 'above',
            limit: { kind: 'fixed', value: 8 }
          }
        ]
      }
    }
    const revolutions: PathEntry = {
      path: 'propulsion.main.revolutions',
      unit: displayUnit({ units: 'Hz' }),
      value: 30
    }
    const running = [...boat, revolutions]
    const madeFor = (engine: string) =>
      ruleEntry({
        slug: `made-${engine}`,
        rule: {
          name: `Made for ${engine}`,
          signal: { paths: ['electrical.batteries.starter.voltage'] },
          template: { set: 'builtin', id: whileRunning.id, pick: { engine } }
        }
      })

    it('lists the instances reporting the gate’s path, showing its value', () => {
      const found = candidates('builtin', whileRunning, running, [])
      expect(found.map((c) => [c.pick, c.path, c.entry?.path])).toEqual([
        [{ engine: 'main' }, 'electrical.batteries.starter.voltage', 'propulsion.main.revolutions']
      ])
    })

    it('offers the sources of the watched path, not of the gate', () => {
      const withSource: Template = { ...whileRunning, open: ['source'] }
      const sourced = running.map((p) =>
        p.path === 'electrical.batteries.starter.voltage'
          ? { ...p, sources: ['bmv.1'] }
          : p.path === revolutions.path
            ? { ...p, sources: ['n2k.engine'] }
            : p
      )
      expect(candidates('builtin', withSource, sourced, []).map((c) => c.pick)).toEqual([
        { engine: 'main', source: 'bmv.1' }
      ])
    })

    it('leaves a typed instance nothing reports without a value', () => {
      expect(
        typedCandidate(
          'builtin',
          whileRunning,
          { name: 'engine', label: 'Engine' },
          'port',
          running,
          []
        ).entry
      ).toBeUndefined()
    })

    it('matches a rule on its stored pick, as every choice watches the same path', () => {
      const rules = [madeFor('main')]
      expect(ruleWatching('builtin', whileRunning, { engine: 'main' }, rules)).toBe('Made for main')
      expect(ruleWatching('builtin', whileRunning, { engine: 'port' }, rules)).toBeUndefined()
    })
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

  it('tells a row with a source from the same row without one', () => {
    const withSource = [madeFor({ battery: 'start', engine: 'main', source: 'n2k.1' })]
    const without = [madeFor({ battery: 'start', engine: 'main' })]
    expect(
      ruleWatching('builtin', alternator, { battery: 'start', engine: 'main' }, withSource)
    ).toBeUndefined()
    expect(
      ruleWatching(
        'builtin',
        alternator,
        { battery: 'start', engine: 'main', source: 'n2k.1' },
        without
      )
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

  it('restores of a pick only its open slots, each one path segment, and an open source', () => {
    expect(
      restoredPick(alternator, { battery: 'house', engine: 'main', source: 'x', instance: 'y' })
    ).toEqual({ battery: 'house', engine: 'main' })
    expect(restoredPick(alternator, { battery: 'a.b', engine: 'port side' })).toEqual({})
    expect(
      restoredPick({ ...alternator, open: ['source'] }, { battery: 'house', source: 'can0.226' })
    ).toEqual({ battery: 'house', source: 'can0.226' })
  })

  it('decides the sources by the slots in its signal path alone', () => {
    expect(watchedSlots(alternator).map((s) => s.name)).toEqual(['battery'])
    const nested: Template = {
      ...alternator,
      rule: {
        ...alternator.rule,
        signal: { path: 'propulsion.${engine}.alternators.${battery}.voltage' }
      }
    }
    expect(watchedSlots(nested).map((s) => s.name)).toEqual(['battery', 'engine'])
  })

  it('shows each slot’s first path with every slot as <name>', () => {
    expect(slotPattern(alternator, 'battery')).toBe('electrical.batteries.<name>.voltage')
    expect(slotPattern(alternator, 'engine')).toBe('propulsion.<name>.revolutions')
  })

  describe('why the rows cannot continue', () => {
    it('names the first row missing a choice, a slot before the source, in rule order', () => {
      expect(rowsProblem(alternator, true, [{ engine: 'main' }])).toBe(
        'Choose a battery for rule 1'
      )
      expect(
        rowsProblem(alternator, true, [{ battery: 'start', engine: 'main' }, { engine: 'main' }])
      ).toBe('Choose a source for rule 1')
    })

    it('names a missing choice before rows that are the same', () => {
      const same = { battery: 'start', engine: 'main' }
      expect(rowsProblem(alternator, false, [same, same, { battery: 'start' }])).toBe(
        'Choose an engine for rule 3'
      )
      expect(
        rowsProblem(alternator, true, [
          { ...same, source: 'n2k.1' },
          { ...same, source: 'n2k.1' },
          same
        ])
      ).toBe('Choose a source for rule 3')
    })

    it('names the first two rows that are the same, else nothing', () => {
      const port = { battery: 'start', engine: 'port' }
      const starboard = { battery: 'start', engine: 'starboard' }
      expect(rowsProblem(alternator, false, [port, starboard, port])).toBe(
        'Rules 1 and 3 are the same'
      )
      expect(rowsProblem(alternator, false, [port, starboard])).toBeUndefined()
    })
  })

  it('joins one, two and three slots’ labels, each with its article', () => {
    const battery = { name: 'battery', label: 'Battery' }
    const charger = { name: 'charger', label: 'Charger' }
    const engine = { name: 'engine', label: 'Engine' }
    expect(withArticle('engine')).toBe('an engine')
    expect(withArticle('battery')).toBe('a battery')
    expect(labelsJoined([battery])).toBe('a battery')
    expect(labelsJoined([battery, engine])).toBe('a battery and an engine')
    expect(labelsJoined([battery, charger, engine])).toBe('a battery, a charger and an engine')
  })

  it('lists for no slot the picks of a single-slot template', () => {
    expect(candidates('builtin', alternator, boat, [])).toEqual([])
  })

  describe('candidates per slot', () => {
    const rpm = displayUnit({ units: 'Hz' })
    const revolutions = (engine: string, value: number): PathEntry => ({
      path: `propulsion.${engine}.revolutions`,
      units: 'Hz',
      unit: rpm,
      value
    })
    const listed = (found: SlotCandidate[]) =>
      found.map((c) => [c.instance, c.label, c.entry?.path, c.entry?.value, c.typed])

    it('lists each slot’s instances from the paths using it, each with its value', () => {
      const reported = [revolutions('main', 30), voltage('start', 12.6)]
      expect(listed(slotCandidates(alternator, 'engine', reported))).toEqual([
        ['main', 'main', 'propulsion.main.revolutions', 30, undefined]
      ])
      expect(listed(slotCandidates(alternator, 'battery', reported))).toEqual([
        ['start', 'start', 'electrical.batteries.start.voltage', 12.6, undefined]
      ])
    })

    it('names an instance by the name its group reports, else the path’s display name', () => {
      expect(listed(slotCandidates(alternator, 'battery', boat))).toEqual([
        ['house', 'House bank', 'electrical.batteries.house.voltage', 13.28, undefined],
        [
          'ruuvi-cockpit',
          'ruuvi-cockpit',
          'electrical.batteries.ruuvi-cockpit.voltage',
          2.98,
          undefined
        ],
        [
          'ruuvi-saloon',
          'Saloon RuuviTag battery',
          'electrical.batteries.ruuvi-saloon.voltage',
          3.01,
          undefined
        ],
        ['starter', 'starter', 'electrical.batteries.starter.voltage', 12.71, undefined]
      ])
    })

    it('lists nothing for a slot whose paths no instance reports', () => {
      expect(slotCandidates(alternator, 'engine', boat)).toEqual([])
      expect(slotCandidates(alternator, 'battery', [])).toEqual([])
    })

    it('lists an instance two paths report once, showing the signal’s value first', () => {
      // The gate is written before the signal: the signal's value still shows first.
      const { signal, ...rest } = alternator.rule
      const gatedOnCurrent: Template = {
        ...alternator,
        rule: {
          ...rest,
          gates: [
            {
              signal: { path: 'electrical.batteries.${battery}.current' },
              direction: 'above',
              limit: { kind: 'fixed', value: 0 }
            }
          ],
          signal
        }
      }
      expect(listed(slotCandidates(gatedOnCurrent, 'battery', boat)).slice(0, 1)).toEqual([
        ['house', 'House bank', 'electrical.batteries.house.voltage', 13.28, undefined]
      ])
      const currentOnly = boat.filter((p) => p.path.endsWith('.current'))
      expect(listed(slotCandidates(gatedOnCurrent, 'battery', currentOnly))).toEqual([
        ['house', 'house', 'electrical.batteries.house.current', 4, undefined]
      ])
    })

    it('lists the instances of every input of a combined signal and of a zone limit', () => {
      const combined: Template = {
        ...alternator,
        rule: {
          ...alternator.rule,
          signal: {
            combinator: 'difference',
            inputs: [
              { path: 'propulsion.${engine}.alternatorVoltage' },
              { path: 'electrical.batteries.${battery}.voltage' }
            ]
          },
          detector: {
            type: 'sustained',
            direction: 'above',
            limit: { kind: 'zone', level: 'warn', path: 'propulsion.${engine}.temperature' }
          },
          gates: []
        }
      }
      const reported: PathEntry[] = [
        { path: 'propulsion.port.alternatorVoltage', unit: volts, value: 14.1 },
        { path: 'propulsion.stbd.temperature', unit: displayUnit({}), value: 350 }
      ]
      expect(slotCandidates(combined, 'engine', reported).map((c) => c.instance)).toEqual([
        'port',
        'stbd'
      ])
    })

    it('finds a slot’s instance in a path that has another slot before it', () => {
      const nested: Template = {
        ...alternator,
        rule: {
          ...alternator.rule,
          signal: { path: 'propulsion.${engine}.alternators.${battery}.voltage' }
        }
      }
      const reported: PathEntry[] = [
        { path: 'propulsion.main.alternators.start.voltage', unit: volts, value: 14 }
      ]
      expect(slotCandidates(nested, 'battery', reported).map((c) => c.instance)).toEqual(['start'])
      expect(slotCandidates(nested, 'engine', reported).map((c) => c.instance)).toEqual(['main'])
    })

    it('adds each typed name nothing reports after the reporting ones, once', () => {
      const reported = [voltage('start', 12.6)]
      expect(
        listed(slotCandidates(alternator, 'battery', reported, ['windlass', 'start', 'windlass']))
      ).toEqual([
        ['start', 'start', 'electrical.batteries.start.voltage', 12.6, undefined],
        ['windlass', 'windlass', undefined, undefined, true]
      ])
    })
  })

  describe('whether a pick reports', () => {
    const revolutions = (engine: string): PathEntry => ({
      path: `propulsion.${engine}.revolutions`,
      unit: displayUnit({ units: 'Hz' }),
      value: 30
    })
    const reported = [voltage('start', 12.6), revolutions('main')]

    it('reports once every slot’s choice reports a path the slot is in', () => {
      expect(pickReports(alternator, { battery: 'start', engine: 'main' }, reported)).toBe(true)
    })

    it('waits for a slot only a gate uses, though the watched path reports', () => {
      expect(pickReports(alternator, { battery: 'start', engine: 'port' }, reported)).toBe(false)
    })

    it('waits for a choice of a slot that reports only under another slot', () => {
      expect(pickReports(alternator, { battery: 'main', engine: 'main' }, reported)).toBe(false)
    })

    it('finds a slot in any input of a combined signal, not only the first', () => {
      const combined: Template = {
        ...alternator,
        rule: {
          ...alternator.rule,
          signal: {
            combinator: 'difference',
            inputs: [
              { path: 'environment.outside.temperature' },
              { path: 'electrical.batteries.${battery}.voltage' }
            ]
          }
        }
      }
      expect(pickReports(combined, { battery: 'start', engine: 'main' }, reported)).toBe(true)
      expect(pickReports(combined, { battery: 'house', engine: 'main' }, reported)).toBe(false)
    })

    it('waits for a pair two slots of one path make, though each reports in another pair', () => {
      const tanks: Template = {
        ...alternator,
        slots: [
          { name: 'kind', label: 'Kind' },
          { name: 'id', label: 'Tank' }
        ],
        rule: {
          ...alternator.rule,
          signal: { path: 'tanks.${kind}.${id}.currentLevel' },
          gates: []
        }
      }
      const level = (path: string): PathEntry => ({ path, unit: displayUnit({}), value: 0.5 })
      const tanksReported = [
        level('tanks.fuel.0.currentLevel'),
        level('tanks.freshWater.1.currentLevel')
      ]
      expect(pickReports(tanks, { kind: 'fuel', id: '0' }, tanksReported)).toBe(true)
      expect(pickReports(tanks, { kind: 'fuel', id: '1' }, tanksReported)).toBe(false)
    })
  })
})
