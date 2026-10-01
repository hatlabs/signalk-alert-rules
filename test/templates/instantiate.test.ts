import { describe, expect, it } from 'vitest'
import {
  INSTANCE_PICK_MESSAGE as MODEL_INSTANCE_PICK_MESSAGE,
  INSTANCE_PICK_PATTERN as MODEL_INSTANCE_PICK_PATTERN,
  MAX_PICK_LENGTH,
  MAX_SLUG_LENGTH
} from '../../src/model/rule.js'
import { alertPathOf } from '../../src/alerts/paths.js'
import type { Template } from '../../src/model/template.js'
import { validateRule } from '../../src/model/validate.js'
import {
  INSTANCE_PICK_MESSAGE,
  INSTANCE_PICK_PATTERN,
  MAX_SLUG,
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
    priority: 'warning',
    signal: { path: 'electrical.batteries.${instance}.voltage' },
    detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 12 } }
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
      priority: 'warning',
      signal: { path: 'electrical.batteries.house.voltage' },
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 12 } },
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
      rule: {
        name: 'Charge imbalance',
        condition: 'chargeImbalance',
        message: 'Charge imbalance',
        priority: 'caution',
        signal: {
          combinator: 'absDifference',
          inputs: [
            { path: 'electrical.batteries.${instance}.voltage' },
            { path: 'electrical.chargers.${instance}.voltage' }
          ]
        },
        detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 0.5 } },
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

  it('gives each instantiation for the same pick its own slug', () => {
    const first = created(voltageLow, { instance: 'house' })
    const second = created(voltageLow, { instance: 'house' }, new Set([first.slug as string]))
    expect(first.slug).toBe('voltage-low-house')
    expect(second.slug).toBe('voltage-low-house-2')
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
    ['whitespace', 'house bank']
  ])('refuses an instance pick that is not one path segment: %s', (_, instance) => {
    expect(instantiate(SET, voltageLow, { instance })).toEqual({
      ok: false,
      errors: [{ path: '/instance', message: INSTANCE_PICK_MESSAGE }]
    })
  })

  it('leaves a pick that makes an invalid path for rule validation to refuse', () => {
    const rule = created(voltageLow, { instance: 'h'.repeat(MAX_PICK_LENGTH) })
    const result = validateRule(rule)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.map((e) => e.path)).toContain('/signal/path')
  })
})

describe('proposeSlug', () => {
  it('slugs the pick after the template id', () => {
    expect(proposeSlug('voltage-low', 'Start 1', new Set())).toBe('voltage-low-start-1')
    expect(proposeSlug('voltage-low', '***', new Set())).toBe('voltage-low')
  })

  it('numbers a slug that is taken, within the slug length', () => {
    const long = 'a'.repeat(MAX_SLUG)
    expect(proposeSlug(long, undefined, new Set())).toBe(long)
    const numbered = proposeSlug(long, undefined, new Set([long]))
    expect(numbered).toBe(`${'a'.repeat(MAX_SLUG - 2)}-2`)
    expect(proposeSlug('x', undefined, new Set(['x', 'x-2', 'x-3']))).toBe('x-4')
  })

  it('keeps the slug length the model allows', () => {
    expect(MAX_SLUG).toBe(MAX_SLUG_LENGTH)
    expect(INSTANCE_PICK_PATTERN).toBe(MODEL_INSTANCE_PICK_PATTERN)
    expect(INSTANCE_PICK_MESSAGE).toBe(MODEL_INSTANCE_PICK_MESSAGE)
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
        detector: { type: 'match', op: 'equals', value: '${instance}' },
        gates: [{ signal: { path: '${instance}.${other}' } }]
      },
      (use) => {
        uses.push(use)
        return use.name.toUpperCase()
      }
    )
    expect(out).toEqual({
      name: 'Bank INSTANCE',
      signal: { path: 'electrical.batteries.INSTANCE.voltage' },
      detector: { type: 'match', op: 'equals', value: '${instance}' },
      gates: [{ signal: { path: 'INSTANCE.OTHER' } }]
    })
    expect(uses).toEqual([
      { name: 'instance', key: 'name', at: '/name' },
      { name: 'instance', key: 'path', at: '/signal/path' },
      { name: 'instance', key: 'path', at: '/gates/0/signal/path' },
      { name: 'other', key: 'path', at: '/gates/0/signal/path' }
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
