import { describe, expect, it } from 'vitest'
import { validateTemplateSet } from '../../src/model/template.js'
import type { ValidationError } from '../../src/model/validate.js'

const voltageLow = {
  id: 'voltage-low',
  description: 'House or start bank below a fixed voltage',
  open: ['instance'],
  rule: {
    name: 'Battery ${instance} voltage low',
    message: 'Battery voltage is low',
    signal: { path: 'electrical.batteries.${instance}.voltage' },
    detector: { type: 'sustained', direction: 'below', steps: [{ limit: 12, priority: 'warning' }] }
  }
}

const set = {
  name: 'Batteries',
  id: 'batteries',
  version: '1.0.0',
  description: 'Battery bank templates',
  templates: [voltageLow]
}

function errorsOf(input: unknown): ValidationError[] {
  const result = validateTemplateSet(input)
  return result.ok ? [] : result.errors
}

function withTemplate(template: Record<string, unknown>) {
  return { ...set, templates: [template] }
}

function withRule(rule: Record<string, unknown>) {
  return withTemplate({ ...voltageLow, rule: { ...voltageLow.rule, ...rule } })
}

describe('validateTemplateSet', () => {
  it('accepts a set of templates, open and fully bound', () => {
    const bound = {
      id: 'depth-shallow',
      rule: { ...voltageLow.rule, name: 'Shallow', signal: { path: 'environment.depth.belowKeel' } }
    }
    const result = validateTemplateSet({ ...set, templates: [voltageLow, bound] })
    expect(result).toEqual({ ok: true, value: { ...set, templates: [voltageLow, bound] } })
  })

  it("accepts a condition name, which names the alert under the input's parent", () => {
    expect(errorsOf(withTemplate({ ...voltageLow, condition: 'bankFlat' }))).toEqual([])
  })

  it('reports a condition name that is not one alert path segment', () => {
    for (const condition of ['bank flat', 'bank.flat', '*', 'constructor', '']) {
      expect(errorsOf(withTemplate({ ...voltageLow, condition })).map((e) => e.path)).toEqual([
        '/templates/0/condition'
      ])
    }
  })

  it("reports a name core forbids at the template's condition, as rule validation words it", () => {
    expect(errorsOf(withTemplate({ ...voltageLow, condition: 'constructor' }))).toEqual([
      { path: '/templates/0/condition', message: '"constructor" is not allowed in an alert path' }
    ])
  })

  it('needs a condition name for a combined signal, which has no default one', () => {
    const combined = {
      combinator: 'difference',
      inputs: [
        { path: 'electrical.batteries.${instance}.voltage' },
        { path: 'electrical.chargers.${instance}.voltage' }
      ]
    }
    const rule = { ...voltageLow.rule, signal: combined }
    expect(errorsOf(withTemplate({ ...voltageLow, condition: 'imbalance', rule }))).toEqual([])
    expect(errorsOf(withTemplate({ ...voltageLow, rule }))).toEqual([
      {
        path: '/templates/0/condition',
        message: 'is required: a rule over several paths has no default name'
      }
    ])
  })

  it("reports a condition name in the template's rule, as the template gives it", () => {
    const rule = { ...voltageLow.rule, condition: 'bankFlat' }
    expect(errorsOf(withTemplate({ ...voltageLow, rule }))).toEqual([
      { path: '/templates/0/rule/condition', message: "is given as the template's condition" }
    ])
  })

  it('reports a set that does not match the schema', () => {
    const { version: _version, ...unversioned } = set
    expect(errorsOf(unversioned)).toEqual([{ path: '/version', message: 'is required' }])
    expect(errorsOf({ ...set, id: 'Not A Slug' }).map((e) => e.path)).toEqual(['/id'])
    expect(
      errorsOf(withTemplate({ ...voltageLow, open: ['everything'] })).map((e) => e.path)
    ).toEqual(['/templates/0/open/0'])
  })

  it('reports a template whose rule does not validate, at its place in the set', () => {
    expect(errorsOf(withRule({ detector: { type: 'sustained', direction: 'sideways' } }))).toEqual([
      { path: '/templates/0/rule/detector/direction', message: 'must be one of: above, below' }
    ])
  })

  it('reports two templates with one id', () => {
    expect(errorsOf({ ...set, templates: [voltageLow, voltageLow] })).toEqual([
      { path: '/templates/1/id', message: 'voltage-low is used twice' }
    ])
  })

  it('reports an open instance with no placeholder in a path', () => {
    const named = withRule({ signal: { path: 'electrical.batteries.house.voltage' } })
    expect(errorsOf(named)).toEqual([
      { path: '/templates/0/open', message: 'an open instance needs ${instance} in a path' }
    ])
  })

  it('reports a placeholder the template does not leave open, or does not know', () => {
    const bound = withTemplate({ ...voltageLow, open: [] })
    expect(errorsOf(bound)).toEqual([
      { path: '/templates/0/rule/name', message: '${instance} needs instance in open' },
      { path: '/templates/0/rule/signal/path', message: '${instance} needs instance in open' }
    ])
    expect(errorsOf(withRule({ message: 'Low on ${bank}' }))).toEqual([
      {
        path: '/templates/0/rule/message',
        message: 'unknown placeholder ${bank}; only ${instance} is substituted'
      }
    ])
  })

  it('reports an open source on a combined signal', () => {
    const combined = withTemplate({
      ...voltageLow,
      open: ['instance', 'source'],
      rule: {
        ...voltageLow.rule,
        signal: {
          combinator: 'mean',
          inputs: [
            { path: 'electrical.batteries.${instance}.voltage' },
            { path: 'electrical.chargers.${instance}.voltage' }
          ]
        }
      }
    })
    expect(errorsOf(combined)).toEqual([
      { path: '/templates/0/open', message: 'an open source needs a signal with a single path' }
    ])
  })

  it('reports a part listed twice in open', () => {
    expect(errorsOf(withTemplate({ ...voltageLow, open: ['instance', 'instance'] }))).toEqual([
      { path: '/templates/0/open/1', message: 'instance is listed twice' }
    ])
  })

  it('reports a slug or template record, which using the template sets', () => {
    const record = { set: 'x', id: 'y', version: '1', pick: {} }
    expect(errorsOf(withRule({ slug: 'mine', template: record }))).toEqual([
      { path: '/templates/0/rule/slug', message: 'is chosen when the template is used' },
      { path: '/templates/0/rule/template', message: 'is recorded when the template is used' }
    ])
  })
})
