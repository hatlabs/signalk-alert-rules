import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import {
  emptyForm,
  emptyGate,
  emptyStep,
  fromRule,
  setCombinator,
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
    expect(byField.get('/detector/steps/0/limit')).toEqual([
      { text: 'must be a number', withheld: false }
    ])
    expect(byField.get('/name')).toEqual([{ text: 'odd', withheld: false }])
    expect(unattached).toEqual([])
  })

  it('attaches an error on a group to the first field in it', () => {
    const { byField } = attachErrors(
      [{ path: '/signal/inputs', message: 'difference needs exactly two inputs' }],
      fields
    )
    expect(byField.get('/signal/inputs/0/path')).toEqual([
      { text: 'difference needs exactly two inputs', withheld: false }
    ])
  })

  it('marks the text of an error withheld until Save as withheld on its field', () => {
    const { byField } = attachErrors(
      [{ path: '/name', message: 'is required', withheld: true }],
      fields
    )
    expect(byField.get('/name')).toEqual([{ text: 'is required', withheld: true }])
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
    // The zones checkbox stands for the detector's limit as a whole.
    expect(attached('/detector/limit', zones)).toEqual(['/detector/limit'])
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
    const errors = leafPointers(rule).map((path) => ({ path, message: 'x' }))
    expect(attachErrors(errors, fields).unattached).toEqual([])
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
      '/detector/limit',
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

  it.each([
    ['difference', true],
    ['absDifference', true],
    ['spread', true],
    ['mean', true],
    ['ratio', false],
    ['median', false],
    ['distance', false],
    ['positionSpread', false]
  ] as const)('lists the angular flag of a %s only where it can wrap angles', (kind, listed) => {
    const f = form((f) => {
      f.signal = setCombinator(setMode(f.signal, 'combine'), kind)
    })
    expect(fieldPointers(f, false).includes('/signal/angular')).toBe(listed)
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
        '/gates/0/duration'
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

  describe('clear margins a change of unit emptied', () => {
    const retype = 'must be typed again in the unit of the chosen path'
    const notes = [{ path: '/detector/hysteresis', message: retype }]

    it('names it after what else stops the save', () => {
      expect(saveHint([{ path: '/name', message: 'is required' }, ...notes], sustained)).toBe(
        'Fill in the name to save. The clear margin was emptied: type it again or leave it empty.'
      )
    })

    it('says the next Save leaves it empty once a footer named it and nothing else stops it', () => {
      expect(saveHint(notes, sustained, new Set(['/detector/hysteresis']))).toBe(
        'The clear margin was emptied: type it again, or Save leaves it empty.'
      )
      expect(saveHint(notes, sustained)).toBe(
        'The clear margin was emptied: type it again or leave it empty.'
      )
    })

    it('forgets a margin typed again', () => {
      const typed = form((f) => {
        f.detector.type = 'sustained'
        f.detector.hysteresis = '0.5'
      })
      expect(saveHint([notes[0] ?? { path: '', message: '' }], typed)).toBeUndefined()
    })
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
    ['/gates/0/signal', 'the path of Only while condition 1'],
    ['/gates/0/limit', 'the limit of Only while condition 1'],
    ['/gates/0', 'Only while condition 1'],
    ['/gates', 'the Only while conditions']
  ])('names %s, a part a stored rule can lack, by its field', (pointer, label) => {
    expect(fieldLabel(pointer, sustained)).toBe(label)
  })

  it('names the direction of a limit by Alert when, which chooses it', () => {
    expect(saveHint([{ path: '/detector/direction', message: 'is required' }], sustained)).toBe(
      'Fill in what should alert to save.'
    )
    const slope = form((f) => {
      f.detector.type = 'slope'
    })
    expect(fieldLabel('/detector/direction', slope)).toBe('the direction')
  })

  it('names a gate and a combined input by their numbers', () => {
    expect(fieldLabel('/gates/1/direction', sustained)).toBe(
      'the direction of Only while condition 2'
    )
    expect(fieldLabel('/signal/inputs/0/path', sustained)).toBe('path 1 to combine')
  })

  // The field reads "Count while the value is" whatever the total measures.
  it.each(['time', 'integral'] as const)(
    'names what a total of %s counts while as its field does',
    (measure) => {
      const f = form((f) => {
        f.detector.type = 'accumulator'
        f.detector.measure = measure
        f.detector.useWhile = true
      })
      for (const p of ['/detector/while', '/detector/while/op', '/detector/while/value']) {
        expect(fieldLabel(p, f)).toBe('what to count while')
      }
    }
  )

  it("names a detector limit's error by the field that shows it", () => {
    const zone = { kind: 'zone' as const, value: '', level: 'warn' as const, path: '' }
    const sustained = (limit: RuleForm['detector']['limit']) =>
      form((f) => {
        f.detector.type = 'sustained'
        f.detector.limit = limit
      })
    const zones = sustained(zone)
    const fixed = sustained({ ...zone, kind: 'fixed' })
    const count = form((f) => {
      f.detector.type = 'count'
    })
    expect(fieldLabel('/detector/limit/level', zones)).toBe('the zone to start at')
    expect(fieldLabel('/detector/limit/path', zones)).toBe('the path of the zones')
    expect(fieldLabel('/detector/limit/value', zones)).toBe("Use the value's zones")
    expect(fieldLabel('/detector/limit/level', fixed)).toBe("Use the value's zones")
    expect(fieldLabel('/detector/limit', count)).toBe('the zone limit')
    expect(saveHint([{ path: '/detector/limit/level', message: 'is required' }], fixed)).toBe(
      "Fix Use the value's zones to save."
    )
  })

  it("names a gate's limit and path within the gate", () => {
    const gates = form((f) => {
      f.gates = [emptyGate(), { ...emptyGate(), signal: setMode(emptyGate().signal, 'combine') }]
    })
    expect(fieldLabel('/gates/0/limit/value', gates)).toBe('the limit of Only while condition 1')
    expect(fieldLabel('/gates/0/limit/level', gates)).toBe('the limit of Only while condition 1')
    expect(fieldLabel('/gates/0/signal/path', gates)).toBe('the path of Only while condition 1')
    expect(fieldLabel('/gates/0/signal/source', gates)).toBe('Only while condition 1')
    expect(fieldLabel('/detector/limit/level', gates)).toBe('the zone limit')
    expect(fieldLabel('/detector/while/op', gates)).toBe('what to count while')
    expect(fieldLabel('/gates/1/signal', gates)).toBe('the paths of Only while condition 2')
    expect(fieldLabel('/gates/1/signal/inputs/1/path', gates)).toBe(
      'the paths of Only while condition 2'
    )
    expect(
      saveHint(
        [
          { path: '/gates/0/signal/path', message: 'is required' },
          { path: '/gates/0/limit/value', message: 'is required' }
        ],
        gates
      )
    ).toBe(
      'Fill in the path of Only while condition 1 and the limit of Only while condition 1 to save.'
    )
  })
})
