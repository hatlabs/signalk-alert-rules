import { describe, expect, it } from 'vitest'
import {
  SLOT_PICK_MESSAGE as MODEL_SLOT_PICK_MESSAGE,
  SLOT_NAME_PATTERN as MODEL_SLOT_NAME_PATTERN,
  SLOT_PICK_PATTERN as MODEL_SLOT_PICK_PATTERN,
  MAX_PICK_LENGTH,
  MAX_SLUG_LENGTH,
  SOURCE_PICK as MODEL_SOURCE_PICK
} from '../../src/model/rule.js'
import { alertPathOf } from '../../src/alerts/paths.js'
import type { Template } from '../../src/model/template.js'
import { validateRule } from '../../src/model/validate.js'
import {
  SLOT_PICK_MESSAGE,
  SLOT_NAME_PATTERN,
  SLOT_PICK_PATTERN,
  MAX_SLUG,
  SOURCE_PICK,
  instantiate,
  proposeSlug,
  slugify,
  substitutePlaceholders
} from '../../src/templates/instantiate.js'

const SET = { id: 'batteries', version: '1.2.0' }

const voltageLow: Template = {
  id: 'voltage-low',
  open: ['instance'],
  rule: {
    name: 'Battery ${instance} voltage low',
    message: 'Battery ${instance} voltage is low',
    signal: { path: 'electrical.batteries.${instance}.voltage' },
    detector: { type: 'sustained', direction: 'below', steps: [{ limit: 12, priority: 'warning' }] }
  }
}

function created(template: Template, pick: Record<string, string>, taken?: Set<string>) {
  const result = instantiate(SET, template, pick, taken)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('instantiate', () => {
  it('substitutes the instance into paths, name and message, and records the template', () => {
    const rule = created(voltageLow, { instance: 'house' })
    expect(rule).toEqual({
      name: 'Battery house voltage low',
      slug: 'voltage-low-house',
      message: 'Battery house voltage is low',
      signal: { path: 'electrical.batteries.house.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 12, priority: 'warning' }]
      },
      template: {
        set: 'batteries',
        id: 'voltage-low',
        version: '1.2.0',
        pick: { instance: 'house' }
      }
    })
    expect(validateRule(rule).ok).toBe(true)
  })

  it('substitutes one instance pick into every path of a combined signal and its gates', () => {
    const template: Template = {
      id: 'charge-imbalance',
      open: ['instance'],
      condition: 'chargeImbalance',
      rule: {
        name: 'Charge imbalance',
        message: 'Charge imbalance',
        signal: {
          combinator: 'absDifference',
          inputs: [
            { path: 'electrical.batteries.${instance}.voltage' },
            { path: 'electrical.chargers.${instance}.voltage' }
          ]
        },
        detector: {
          type: 'sustained',
          direction: 'above',
          steps: [{ limit: 0.5, priority: 'caution' }]
        },
        gates: [
          {
            signal: { path: 'electrical.batteries.${instance}.current' },
            direction: 'above',
            limit: { kind: 'fixed', value: 1 }
          }
        ]
      }
    }
    const rule = created(template, { instance: 'house' })
    expect(rule.signal).toEqual({
      combinator: 'absDifference',
      inputs: [
        { path: 'electrical.batteries.house.voltage' },
        { path: 'electrical.chargers.house.voltage' }
      ]
    })
    expect(rule.gates).toMatchObject([{ signal: { path: 'electrical.batteries.house.current' } }])
    // The inputs share only their first segment, so the name goes under it.
    expect(alertPathOf(rule)).toBe('electrical.chargeImbalance')
    expect(validateRule(rule).ok).toBe(true)
  })

  it("stores the template's condition name, which names the alert under the input's parent", () => {
    const rule = created({ ...voltageLow, condition: 'bankFlat' }, { instance: 'house' })
    expect(rule.condition).toBe('bankFlat')
    expect(alertPathOf(rule)).toBe('electrical.batteries.house.bankFlat')
    expect(validateRule(rule).ok).toBe(true)
  })

  it('stores no condition name for a template without one', () => {
    expect(created(voltageLow, { instance: 'house' })).not.toHaveProperty('condition')
  })

  it('stores a picked source on the input', () => {
    const template: Template = { ...voltageLow, open: ['instance', 'source'] }
    const rule = created(template, { instance: 'house', source: 'can0.12' })
    expect(rule.signal).toEqual({ path: 'electrical.batteries.house.voltage', source: 'can0.12' })
    expect(rule.template).toMatchObject({ pick: { instance: 'house', source: 'can0.12' } })
    expect(validateRule(rule).ok).toBe(true)
  })

  it('makes a fully bound template into a rule slugged after the template', () => {
    const template: Template = {
      id: 'depth-shallow',
      rule: { ...voltageLow.rule, name: 'Shallow', signal: { path: 'environment.depth.belowKeel' } }
    }
    const rule = created(template, {})
    expect(rule).toMatchObject({
      slug: 'depth-shallow',
      signal: { path: 'environment.depth.belowKeel' },
      template: { set: 'batteries', id: 'depth-shallow', version: '1.2.0', pick: {} }
    })
  })

  it('gives each instantiation for the same pick its own slug, but the same alert path', () => {
    const first = created(voltageLow, { instance: 'house' })
    const second = created(voltageLow, { instance: 'house' }, new Set([first.slug as string]))
    expect(first.slug).toBe('voltage-low-house')
    expect(second.slug).toBe('voltage-low-house-2')
    expect(alertPathOf(second)).toBe(alertPathOf(first))
  })

  it('requires a pick for every open part and refuses one for a bound part', () => {
    expect(instantiate(SET, voltageLow, {})).toEqual({
      ok: false,
      errors: [{ path: '/instance', message: 'is required: the template leaves it open' }]
    })
    expect(instantiate(SET, voltageLow, { instance: 'house', source: 'x' })).toEqual({
      ok: false,
      errors: [{ path: '/source', message: 'the template does not leave it open' }]
    })
  })

  it.each([
    ['a deeper path', 'house.port'],
    ['a wildcard', '*'],
    ['whitespace', 'house bank'],
    ['a field pointer', 'house#/voltage']
  ])('refuses an instance pick that is not one path segment: %s', (_, instance) => {
    expect(instantiate(SET, voltageLow, { instance })).toEqual({
      ok: false,
      errors: [{ path: '/instance', message: SLOT_PICK_MESSAGE }]
    })
  })

  it('leaves a pick that makes an invalid path for rule validation to refuse', () => {
    const rule = created(voltageLow, { instance: 'h'.repeat(MAX_PICK_LENGTH) })
    const result = validateRule(rule)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.map((e) => e.path)).toContain('/signal/path')
  })
})

/** A template over two things: a battery it watches and an engine it gates on. */
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
      steps: [{ limit: 13, priority: 'warning' }],
      duration: 120
    },
    gates: [
      {
        signal: { path: 'propulsion.${engine}.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 8 },
        duration: 30
      }
    ]
  }
}

describe('instantiate with slots', () => {
  it('substitutes each slot into paths, name, message and condition, and records the pick', () => {
    const rule = created(alternator, { battery: 'start', engine: 'main' })
    expect(rule).toEqual({
      name: 'Engine main alternator not charging',
      slug: 'alternator-not-charging-start-main',
      condition: 'mainAlternatorNotCharging',
      message: 'Engine main is not charging battery start',
      signal: { path: 'electrical.batteries.start.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 13, priority: 'warning' }],
        duration: 120
      },
      gates: [
        {
          signal: { path: 'propulsion.main.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 },
          duration: 30
        }
      ],
      template: {
        set: 'batteries',
        id: 'alternator-not-charging',
        version: '1.2.0',
        pick: { battery: 'start', engine: 'main' }
      }
    })
    expect(alertPathOf(rule)).toBe('electrical.batteries.start.mainAlternatorNotCharging')
    expect(validateRule(rule).ok).toBe(true)
  })

  it('gives two engines charging one battery their own alerts', () => {
    const port = created(alternator, { battery: 'start', engine: 'port' })
    const starboard = created(alternator, { battery: 'start', engine: 'starboard' })
    expect(alertPathOf(port)).not.toBe(alertPathOf(starboard))
  })

  it('stores a picked source beside the slots', () => {
    const template: Template = { ...alternator, open: ['source'] }
    const rule = created(template, { battery: 'start', engine: 'main', source: 'can0.12' })
    expect(rule.signal).toEqual({ path: 'electrical.batteries.start.voltage', source: 'can0.12' })
    expect(rule.template).toMatchObject({
      pick: { battery: 'start', engine: 'main', source: 'can0.12' }
    })
  })

  it('requires a pick for every slot and refuses a key that is not one', () => {
    expect(instantiate(SET, alternator, { battery: 'start' })).toEqual({
      ok: false,
      errors: [{ path: '/engine', message: 'is required: the template leaves it open' }]
    })
    expect(instantiate(SET, alternator, { battery: 'start', engine: 'main', pump: 'x' })).toEqual({
      ok: false,
      errors: [{ path: '/pump', message: 'the template does not leave it open' }]
    })
    expect(
      instantiate(SET, alternator, { battery: 'start', engine: 'main', instance: 'house' })
    ).toEqual({
      ok: false,
      errors: [{ path: '/instance', message: 'the template does not leave it open' }]
    })
  })

  it.each([
    ['a deeper path', 'main.port'],
    ['a wildcard', '*'],
    ['a "#"', 'a#b']
  ])('refuses a slot pick that is not one path segment: %s', (_, engine) => {
    expect(instantiate(SET, alternator, { battery: 'start', engine })).toEqual({
      ok: false,
      errors: [{ path: '/engine', message: SLOT_PICK_MESSAGE }]
    })
  })

  it.each([
    ['a colon', 'port:1', 'port_1AlternatorNotCharging'],
    ['a non-ASCII letter', 'Mäin', 'M_inAlternatorNotCharging']
  ])(
    'makes a pick with %s into a condition name core accepts, as the alert parent does',
    (_, engine, condition) => {
      const rule = created(alternator, { battery: 'start', engine })
      expect(rule.condition).toBe(condition)
      expect(rule.name).toBe(`Engine ${engine} alternator not charging`)
      expect(rule.gates).toMatchObject([{ signal: { path: `propulsion.${engine}.revolutions` } }])
      expect(validateRule(rule).ok).toBe(true)
    }
  )

  it('leaves a pick that makes the condition a name core forbids for rule validation to refuse', () => {
    const template: Template = { ...voltageLow, condition: '${instance}' }
    const rule = created(template, { instance: 'constructor' })
    expect(rule.condition).toBe('constructor')
    const result = validateRule(rule)
    expect(!result.ok && result.errors).toContainEqual({
      path: '/condition',
      message: '"constructor" is not allowed in an alert path'
    })
  })

  it('leaves a pick in the condition that makes the alert path too long for rule validation to refuse', () => {
    // A name without the pick, so the pick is too long only for the alert path.
    const template: Template = {
      ...alternator,
      rule: { ...alternator.rule, name: 'Alternator not charging' }
    }
    const rule = created(template, { battery: 'start', engine: 'e'.repeat(230) })
    const result = validateRule(rule)
    expect(!result.ok && result.errors).toContainEqual({
      path: '/condition',
      message: 'makes the alert path longer than 255 characters'
    })
  })

  it('reads a pick by its own keys only, whatever a slot is named', () => {
    const template: Template = {
      ...voltageLow,
      open: undefined,
      slots: [{ name: 'constructor', label: 'Bank' }],
      rule: { ...voltageLow.rule, signal: { path: 'electrical.batteries.${constructor}.voltage' } }
    }
    expect(instantiate(SET, template, {})).toEqual({
      ok: false,
      errors: [{ path: '/constructor', message: 'is required: the template leaves it open' }]
    })
  })
})

describe('proposeSlug', () => {
  it('slugs the pick after the template id', () => {
    expect(proposeSlug(voltageLow, { instance: 'Start 1' }, new Set())).toBe('voltage-low-start-1')
    expect(proposeSlug(voltageLow, { instance: '***' }, new Set())).toBe('voltage-low')
  })

  it("joins the slots' picks in the order the template declares them", () => {
    const pick = { engine: 'main', battery: 'start' }
    expect(proposeSlug(alternator, pick, new Set())).toBe('alternator-not-charging-start-main')
  })

  it('numbers a slug that is taken, within the slug length', () => {
    const long: Template = { ...voltageLow, id: 'a'.repeat(MAX_SLUG), open: undefined }
    expect(proposeSlug(long, {}, new Set())).toBe(long.id)
    const numbered = proposeSlug(long, {}, new Set([long.id]))
    expect(numbered).toBe(`${'a'.repeat(MAX_SLUG - 2)}-2`)
    const x: Template = { ...long, id: 'x' }
    expect(proposeSlug(x, {}, new Set(['x', 'x-2', 'x-3']))).toBe('x-4')
  })

  it('fits long picks to the slug length, and their numbered retries too', () => {
    const pick = { battery: 'b'.repeat(40), engine: 'e'.repeat(40) }
    const slug = proposeSlug(alternator, pick, new Set())
    expect(slug).toHaveLength(MAX_SLUG)
    expect(slug).toBe(`alternator-not-charging-${'b'.repeat(40)}`)
    const numbered = proposeSlug(alternator, pick, new Set([slug]))
    expect(numbered).toHaveLength(MAX_SLUG)
    expect(numbered.endsWith('-2')).toBe(true)
  })

  it('keeps the slug length the model allows', () => {
    expect(MAX_SLUG).toBe(MAX_SLUG_LENGTH)
  })
})

describe("the model's constants copied here", () => {
  it("equal the model's", () => {
    expect(SLOT_PICK_PATTERN).toBe(MODEL_SLOT_PICK_PATTERN)
    expect(SLOT_PICK_MESSAGE).toBe(MODEL_SLOT_PICK_MESSAGE)
    expect(SOURCE_PICK).toBe(MODEL_SOURCE_PICK)
    expect(SLOT_NAME_PATTERN).toBe(MODEL_SLOT_NAME_PATTERN)
  })
})

describe('slugify', () => {
  it('makes lowercase ASCII words joined by single hyphens', () => {
    expect(slugify('Engine RPM mismatch')).toBe('engine-rpm-mismatch')
    expect(slugify('  Häälytys: öljy  ')).toBe('haalytys-oljy')
    expect(slugify('x'.repeat(80))).toHaveLength(MAX_SLUG)
    expect(slugify('!!!')).toBe('')
  })
})

describe('substitutePlaceholders', () => {
  it('replaces placeholders under the placeholder keys only, reporting where each is', () => {
    const uses: unknown[] = []
    const out = substitutePlaceholders(
      {
        name: 'Bank ${instance}',
        signal: { path: 'electrical.batteries.${instance}.voltage' },
        detector: { type: 'match', op: 'equals', steps: [{ value: '${instance}' }] },
        gates: [{ signal: { path: '${instance}.x${other}' } }],
        condition: '${instance}Low'
      },
      (use) => {
        uses.push(use)
        return use.name.toUpperCase()
      }
    )
    expect(out).toEqual({
      name: 'Bank INSTANCE',
      signal: { path: 'electrical.batteries.INSTANCE.voltage' },
      detector: { type: 'match', op: 'equals', steps: [{ value: '${instance}' }] },
      gates: [{ signal: { path: 'INSTANCE.xOTHER' } }],
      condition: 'INSTANCELow'
    })
    expect(uses).toEqual([
      { name: 'instance', key: 'name', at: '/name', segment: false },
      { name: 'instance', key: 'path', at: '/signal/path', segment: true },
      { name: 'instance', key: 'path', at: '/gates/0/signal/path', segment: true },
      { name: 'other', key: 'path', at: '/gates/0/signal/path', segment: false },
      { name: 'instance', key: 'condition', at: '/condition', segment: false }
    ])
  })

  it('returns fresh objects, so a shared value is never shared between copies', () => {
    const shared = { kind: 'fixed', value: 12 }
    const out = substitutePlaceholders({ a: shared, b: shared }, () => '') as Record<
      string,
      unknown
    >
    expect(out.a).toEqual(shared)
    expect(out.a).not.toBe(shared)
    expect(out.a).not.toBe(out.b)
  })
})
