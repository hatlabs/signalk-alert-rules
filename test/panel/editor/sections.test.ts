import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import {
  emptyForm,
  emptyGate,
  emptyStep,
  fromRule,
  setMode,
  type RuleForm
} from '../../../src/panel/editor/formModel'
import {
  attachErrors,
  fieldLabel,
  fieldPointers,
  saveHint,
  underMoreOptions
} from '../../../src/panel/editor/sections'
import { NO_UNITS } from '../../../src/panel/signalUnits'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')

function examples(): [string, Rule][] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.json'))
    .map((f): [string, Rule] => [f, JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')) as Rule])
}

/** The JSON pointer of every value in `value` that holds no other value. */
function leafPointers(value: unknown, at = ''): string[] {
  if (typeof value !== 'object' || value === null) return [at]
  return Object.entries(value).flatMap(([key, child]) => leafPointers(child, `${at}/${key}`))
}

function form(edit: (f: RuleForm) => void = () => undefined): RuleForm {
  const f = emptyForm()
  edit(f)
  return f
}

describe('attachErrors', () => {
  const fields = ['/name', '/detector/steps/0/limit', '/signal/inputs/0/path', '/signal/combinator']

  it('attaches an error to its field, or to the field it lies under', () => {
    const { byField, unattached } = attachErrors(
      [
        { path: '/detector/steps/0/limit', message: 'must be a number' },
        { path: '/name/0', message: 'odd' }
      ],
      fields
    )
    expect(byField.get('/detector/steps/0/limit')).toEqual(['must be a number'])
    expect(byField.get('/name')).toEqual(['odd'])
    expect(unattached).toEqual([])
  })

  it('attaches an error on a group to the first field in it', () => {
    const { byField } = attachErrors(
      [{ path: '/signal/inputs', message: 'difference needs exactly two inputs' }],
      fields
    )
    expect(byField.get('/signal/inputs/0/path')).toEqual(['difference needs exactly two inputs'])
  })

  it('attaches an error on a whole limit to what is left to fill in, not to its kind', () => {
    const attached = (pointer: string, f: RuleForm) => [
      ...attachErrors(
        [{ path: pointer, message: 'is required' }],
        fieldPointers(f, false)
      ).byField.keys()
    ]
    const zone = { ...emptyGate().limit, kind: 'zone' as const }
    const fixedGate = form((f) => {
      f.gates = [emptyGate()]
    })
    const zoneGate = form((f) => {
      f.gates = [{ ...emptyGate(), limit: zone }]
    })
    const zones = form((f) => {
      f.detector.type = 'sustained'
      f.detector.limit = zone
    })
    expect(attached('/gates/0/limit', fixedGate)).toEqual(['/gates/0/limit/value'])
    expect(attached('/gates/0/limit', zoneGate)).toEqual(['/gates/0/limit/level'])
    expect(attached('/detector/limit', zones)).toEqual(['/detector/limit/level'])
  })

  it('keeps an error on the gates as a whole off the first gate', () => {
    const error = { path: '/gates', message: 'must be an array' }
    const fields = fieldPointers(
      form((f) => {
        f.gates = [emptyGate()]
      }),
      false
    )
    expect(attachErrors([error], fields)).toEqual({ byField: new Map(), unattached: [error] })
  })

  it('keeps an error that no field shows', () => {
    const error = { path: '/gates/3/limit', message: 'x' }
    expect(attachErrors([error], fields).unattached).toEqual([error])
  })
})

describe('fieldPointers', () => {
  // A stored value with no field would take a server error the form cannot show on its field.
  it.each(examples())('has a field for every value of %s', (_, rule) => {
    const fields = fieldPointers(fromRule(rule, NO_UNITS), true)
    expect(leafPointers(rule).filter((p) => !fields.includes(p))).toEqual([])
  })

  it('lists a below-a-limit rule in the order the form shows it', () => {
    const f = form((f) => {
      f.detector.type = 'sustained'
      f.detector.direction = 'below'
    })
    expect(fieldPointers(f, true)).toEqual([
      '/name',
      '/signal/path',
      '/signal/source',
      '/detector/type',
      '/detector/direction',
      '/detector/steps/0/priority',
      '/detector/steps/0/limit',
      '/detector/duration',
      '/message',
      '/condition',
      '/detector/hysteresis',
      '/detector/clearDuration',
      '/detector/limit/kind',
      '/detector/limit/value',
      '/slug'
    ])
  })

  it('lists an outside rule with a low and a high limit per step, and no zones', () => {
    const f = form((f) => {
      f.detector.type = 'outside'
      f.steps = [emptyStep('warning'), emptyStep('alarm')]
    })
    expect(fieldPointers(f, false)).toEqual([
      '/name',
      '/signal/path',
      '/signal/source',
      '/detector/type',
      '/detector/steps/0/priority',
      '/detector/steps/0/low',
      '/detector/steps/0/high',
      '/detector/steps/1/priority',
      '/detector/steps/1/low',
      '/detector/steps/1/high',
      '/detector/duration',
      '/message',
      '/condition',
      '/detector/hysteresis',
      '/detector/clearDuration'
    ])
  })

  it('has a priority and a limit for every step', () => {
    const f = form((f) => {
      f.detector.type = 'sustained'
      f.steps = [emptyStep('warning'), emptyStep('alarm')]
    })
    expect(fieldPointers(f, false)).toEqual(
      expect.arrayContaining(['/detector/steps/1/priority', '/detector/steps/1/limit'])
    )
  })

  it('has no step fields while the zones set the limit', () => {
    const f = form((f) => {
      f.detector.type = 'sustained'
      f.detector.limit = { kind: 'zone', value: '', level: 'warn', path: '' }
    })
    expect(fieldPointers(f, false).filter((p) => p.includes('/steps/'))).toEqual([])
    expect(fieldPointers(f, false)).toContain('/detector/limit/level')
  })

  it('names the slug only for a new rule', () => {
    expect(fieldPointers(form(), true)).toContain('/slug')
    expect(fieldPointers(form(), false)).not.toContain('/slug')
  })

  it('lists combinator inputs and gate fields', () => {
    const f = form((f) => {
      f.signal = setMode(f.signal, 'combine')
      f.detector.type = 'count'
      f.detector.event.op = 'changesTo'
      f.gates = [emptyGate()]
    })
    expect(fieldPointers(f, true)).toEqual(
      expect.arrayContaining([
        '/signal/combinator',
        '/signal/inputs/0/path',
        '/signal/inputs/1/source',
        '/detector/event/op',
        '/detector/event/value',
        '/detector/window',
        '/detector/steps/0/limit',
        '/latching',
        '/gates/0/signal/path',
        '/gates/0/limit/value',
        '/gates/0/hysteresis'
      ])
    )
  })
})

describe('underMoreOptions', () => {
  const f = form((f) => {
    f.detector.type = 'sustained'
    f.gates = [emptyGate()]
  })

  it('places the clear margin, gates and a new slug under More options', () => {
    for (const p of ['/detector/hysteresis', '/gates/0/limit/value', '/slug']) {
      expect(underMoreOptions(f, true, p)).toBe(true)
    }
  })

  it('places the clear margin and delay of an outside rule under More options', () => {
    const outside = form((f) => {
      f.detector.type = 'outside'
    })
    for (const p of ['/detector/hysteresis', '/detector/clearDuration']) {
      expect(underMoreOptions(outside, false, p)).toBe(true)
    }
  })

  it('places latching under More options where the condition can latch', () => {
    const count = form((f) => {
      f.detector.type = 'count'
    })
    expect(underMoreOptions(count, false, '/latching')).toBe(true)
  })

  it('keeps the limit, message and name in the main form', () => {
    for (const p of ['/detector/steps/0/limit', '/message', '/name', '/condition']) {
      expect(underMoreOptions(f, true, p)).toBe(false)
    }
  })
})

describe('saveHint', () => {
  const sustained = form((f) => {
    f.detector.type = 'sustained'
  })

  it('says nothing while nothing stops the save', () => {
    expect(saveHint([], sustained)).toBeUndefined()
  })

  it('names the missing fields, then those to fix', () => {
    expect(
      saveHint(
        [
          { path: '/detector/steps/0/limit', message: 'is required' },
          { path: '/message', message: 'is required' },
          { path: '/condition', message: 'must not contain a dot' }
        ],
        sustained
      )
    ).toBe('Fill in the limit and the message and fix the condition name to save.')
  })

  it('names a missing group by its first field, as its error is shown there', () => {
    expect(saveHint([{ path: '/detector', message: 'is required' }], form())).toBe(
      'Fill in what should alert to save.'
    )
  })

  it('names an error on the steps as a whole by the first step, where it is shown', () => {
    const one = form((f) => {
      f.detector.type = 'sustained'
    })
    expect(
      saveHint([{ path: '/detector/steps', message: 'a rule needs at least one step' }], one)
    ).toBe('Fix the priority to save.')
    const two = form((f) => {
      f.detector.type = 'sustained'
      f.steps = [emptyStep('warning'), emptyStep('alarm')]
    })
    expect(
      saveHint([{ path: '/detector/steps', message: 'a rule needs at least one step' }], two)
    ).toBe('Fix step 1 to save.')
  })

  it('names a step by its number once there are several', () => {
    const f = form((f) => {
      f.detector.type = 'sustained'
      f.steps = [emptyStep('warning'), emptyStep('alarm')]
    })
    expect(fieldLabel('/detector/steps/1/limit', f)).toBe('step 2')
    expect(saveHint([{ path: '/detector/steps/1/limit', message: 'is required' }], f)).toBe(
      'Fill in step 2 to save.'
    )
  })

  it("names an outside rule's limits by their side", () => {
    const f = form((f) => {
      f.detector.type = 'outside'
    })
    expect(fieldLabel('/detector/steps/0/low', f)).toBe('the low limit')
    expect(fieldLabel('/detector/steps/0/high', f)).toBe('the high limit')
    expect(saveHint([{ path: '/detector/steps/0/high', message: 'is required' }], f)).toBe(
      'Fill in the high limit to save.'
    )
  })

  it.each([
    ['/signal', 'the value to watch'],
    ['/signal/inputs', 'the paths to combine'],
    ['/detector/event', 'the event'],
    ['/detector/event/op', 'the event'],
    ['/gates/0/signal', 'Only while condition 1'],
    ['/gates/0', 'Only while condition 1'],
    ['/gates', 'the Only while conditions']
  ])('names %s, a part a stored rule can lack, by its field', (pointer, label) => {
    expect(fieldLabel(pointer, sustained)).toBe(label)
  })

  it('names a gate and a combined input by their numbers', () => {
    expect(fieldLabel('/gates/1/limit/value', sustained)).toBe('Only while condition 2')
    expect(fieldLabel('/signal/inputs/0/path', sustained)).toBe('path 1 to combine')
  })
})
