import { describe, expect, it } from 'vitest'
import { CONDITION_MESSAGE } from '../../src/model/rule.js'
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
        message:
          '${bank} is not a template parameter; ${instance} is the only one (message placeholders such as {value} are written without $)'
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

/** A template over two things: a battery it watches and an engine it gates on. */
const alternator = {
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

function withSlots(template: Record<string, unknown>) {
  return withTemplate({ ...alternator, ...template })
}

function withSlotRule(rule: Record<string, unknown>) {
  return withSlots({ rule: { ...alternator.rule, ...rule } })
}

const slot = (name: string, label = name.toUpperCase()) => ({ name, label })

describe('validateTemplateSet with slots', () => {
  it('accepts a template whose slots each appear in a path, and in its condition', () => {
    expect(errorsOf(withTemplate(alternator))).toEqual([])
  })

  it('accepts an open source beside slots', () => {
    expect(errorsOf(withSlots({ open: ['source'] }))).toEqual([])
  })

  it('accepts as many slots as the cap allows', () => {
    const slots = ['a', 'b', 'c', 'd'].map((name) => slot(name))
    const path = slots.map((s) => `\${${s.name}}`).join('.')
    const rule = { ...voltageLow.rule, name: 'Four', signal: { path } }
    expect(errorsOf(withSlots({ slots, condition: 'four', rule }))).toEqual([])
  })

  it('reports more slots than the cap', () => {
    const slots = ['a', 'b', 'c', 'd', 'e'].map((name) => slot(name))
    expect(errorsOf(withSlots({ slots }))).toEqual([
      { path: '/templates/0/slots', message: 'must have at most 4 items' }
    ])
  })

  it('reports a slot that appears in no path', () => {
    const rule = {
      message: 'Battery ${battery}',
      signal: { path: 'electrical.batteries.house.voltage' }
    }
    expect(errorsOf(withSlotRule(rule))).toEqual([
      { path: '/templates/0/slots/0', message: 'a slot needs ${battery} in a path' }
    ])
  })

  it('reports a slot placeholder inside a path segment', () => {
    const gate = alternator.rule.gates[0]
    const gates = [{ ...gate, signal: { path: 'propulsion.main${engine}.revolutions' } }]
    expect(errorsOf(withSlotRule({ gates }))).toEqual([
      {
        path: '/templates/0/rule/gates/0/signal/path',
        message: '${engine} must be a whole path segment'
      }
    ])
  })

  it('reports a slot name that is not a letter followed by letters and digits', () => {
    for (const name of ['2nd', 'main-engine', 'main_engine', '']) {
      const slots = [slot(name, 'Battery'), slot('engine')]
      expect(errorsOf(withSlots({ slots })), name).toEqual([
        {
          path: '/templates/0/slots/0/name',
          message: 'must be a letter followed by letters and digits'
        }
      ])
    }
  })

  it('reports a slot named source, which names the open source in a pick', () => {
    const slots = [slot('battery'), slot('source')]
    expect(errorsOf(withSlots({ slots }))).toContainEqual({
      path: '/templates/0/slots/1/name',
      message: 'source is reserved for the open source'
    })
  })

  it('reports a slot declared twice', () => {
    const slots = [slot('engine', 'Port'), slot('engine', 'Starboard')]
    expect(errorsOf(withSlots({ slots }))).toContainEqual({
      path: '/templates/0/slots/1/name',
      message: 'engine is declared twice'
    })
  })

  it('reports a label used twice, empty, or longer than 40 characters', () => {
    const twice = [slot('battery', 'Bank'), slot('engine', 'Bank')]
    expect(errorsOf(withSlots({ slots: twice }))).toEqual([
      { path: '/templates/0/slots/1/label', message: 'Bank labels another slot' }
    ])
    for (const label of ['', 'x'.repeat(41)]) {
      const slots = [slot('battery', label), slot('engine')]
      expect(errorsOf(withSlots({ slots })).map((e) => e.path)).toEqual([
        '/templates/0/slots/0/label'
      ])
    }
  })

  it('reports a slot without a label', () => {
    const slots = [{ name: 'battery' }, slot('engine')]
    expect(errorsOf(withSlots({ slots }))).toEqual([
      { path: '/templates/0/slots/0/label', message: 'is required' }
    ])
  })

  it('reports an open instance beside slots', () => {
    expect(errorsOf(withSlots({ open: ['source', 'instance'] }))).toEqual([
      {
        path: '/templates/0/open/1',
        message: 'an open instance cannot be combined with slots; declare it as a slot'
      }
    ])
  })

  it('reports a placeholder that is not a slot, naming the slots', () => {
    expect(errorsOf(withSlotRule({ message: 'Low on ${instance}' }))).toEqual([
      {
        path: '/templates/0/rule/message',
        message:
          '${instance} is not a template parameter; the slots are ${battery}, ${engine} (message placeholders such as {value} are written without $)'
      }
    ])
  })

  it('reports a placeholder in a template that declares no slots', () => {
    const { open: _open, ...bound } = voltageLow
    expect(errorsOf(withTemplate({ ...bound, slots: [] }))).toContainEqual({
      path: '/templates/0/rule/signal/path',
      message:
        '${instance} is not a template parameter; the template declares no slots (message placeholders such as {value} are written without $)'
    })
  })

  it('leaves a placeholder inside a segment to templates without slots', () => {
    const signal = { path: 'electrical.batteries.bank${instance}.voltage' }
    expect(errorsOf(withRule({ signal }))).toEqual([])
  })

  it('reports a placeholder in the condition that is not a slot', () => {
    expect(errorsOf(withSlots({ condition: '${pump}Off' })).map((e) => e.path)).toEqual([
      '/templates/0/condition'
    ])
  })

  it("reports a condition that makes the alert path too long at the template's condition", () => {
    const condition = `\${engine}${'x'.repeat(230)}`
    expect(errorsOf(withSlots({ condition }))).toEqual([
      { path: '/templates/0/condition', message: 'makes the alert path longer than 255 characters' }
    ])
  })

  it('reports a condition that is invalid once its slots are filled in', () => {
    expect(errorsOf(withSlots({ condition: '${engine} not charging' }))).toEqual([
      { path: '/templates/0/condition', message: CONDITION_MESSAGE }
    ])
  })
})
