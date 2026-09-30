import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import {
  emptyForm,
  emptyGate,
  fromRule,
  setMode,
  type RuleForm
} from '../../../src/panel/editor/formModel'
import {
  attachErrors,
  fieldPointers,
  revealedSections,
  sectionApplies
} from '../../../src/panel/editor/sections'
import { NO_UNITS } from '../../../src/panel/signalUnits'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')

function examples(): [string, Rule][] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')) as Rule])
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

describe('revealedSections', () => {
  it('shows only the inputs of a new rule', () => {
    expect(revealedSections(form(), NO_UNITS)).toEqual(['inputs'])
  })

  it('reveals each section once the ones before it are complete', () => {
    const f = form((f) => {
      f.signal.slots[0].path = 'electrical.batteries.house.voltage'
    })
    expect(revealedSections(f, NO_UNITS)).toEqual(['inputs', 'detect'])
    f.detector.type = 'sustained'
    expect(revealedSections(f, NO_UNITS)).toEqual(['inputs', 'detect'])
    f.detector.direction = 'below'
    expect(revealedSections(f, NO_UNITS)).toEqual(['inputs', 'detect', 'limit'])
    f.detector.limit.value = '11.8'
    // Timing has only optional fields for a sustained rule, so it reveals what follows.
    expect(revealedSections(f, NO_UNITS)).toEqual([
      'inputs',
      'detect',
      'limit',
      'timing',
      'advanced',
      'message'
    ])
    f.message = 'Low'
    f.priority = 'warning'
    expect(revealedSections(f, NO_UNITS)).toEqual([
      'inputs',
      'detect',
      'limit',
      'timing',
      'advanced',
      'message',
      'gates',
      'name'
    ])
  })

  it('skips sections that do not apply to the detector', () => {
    const f = form((f) => {
      f.signal.slots[0].path = 'propulsion.*.state'
      f.detector.type = 'match'
      f.detector.matchOp = 'decreases'
    })
    expect(sectionApplies(f, 'limit')).toBe(false)
    expect(sectionApplies(f, 'timing')).toBe(false)
    expect(revealedSections(f, NO_UNITS)).toEqual(['inputs', 'detect', 'advanced', 'message'])
  })

  it('holds back at an incomplete combined input', () => {
    const f = form((f) => {
      f.signal = setMode(f.signal, 'combine')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
    })
    expect(revealedSections(f, NO_UNITS)).toEqual(['inputs'])
  })
})

describe('attachErrors', () => {
  const fields = ['/name', '/detector/limit/value', '/signal/inputs/0/path', '/signal/combinator']

  it('attaches an error to its field, or to the field it lies under', () => {
    const { byField, unattached } = attachErrors(
      [
        { path: '/detector/limit/value', message: 'must be a number' },
        { path: '/name/0', message: 'odd' }
      ],
      fields
    )
    expect(byField.get('/detector/limit/value')).toEqual(['must be a number'])
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

  it('keeps an error that no field shows', () => {
    const error = { path: '/gates/3/limit', message: 'x' }
    expect(attachErrors([error], fields).unattached).toEqual([error])
  })
})

describe('fieldPointers', () => {
  // A stored value with no field would take a server error the form cannot show on its field.
  it.each(examples())('has a field for every value of %s', (_, rule) => {
    const fields = fieldPointers(fromRule(rule, NO_UNITS))
    expect(leafPointers(rule).filter((p) => !fields.includes(p))).toEqual([])
  })

  it('lists the fields a sustained fixed-limit rule shows', () => {
    const f = form((f) => {
      f.detector.type = 'sustained'
    })
    expect(fieldPointers(f)).toEqual([
      '/signal/path',
      '/signal/source',
      '/detector/type',
      '/detector/direction',
      '/detector/limit/kind',
      '/detector/limit/value',
      '/detector/duration',
      '/detector/hysteresis',
      '/detector/clearDuration',
      '/message',
      '/priority',
      '/name',
      '/slug'
    ])
  })

  it('lists combinator inputs and gate fields', () => {
    const f = form((f) => {
      f.signal = setMode(f.signal, 'combine')
      f.detector.type = 'count'
      f.detector.event.op = 'changesTo'
      f.gates = [emptyGate()]
    })
    expect(fieldPointers(f)).toEqual(
      expect.arrayContaining([
        '/signal/combinator',
        '/signal/inputs/0/path',
        '/signal/inputs/1/source',
        '/detector/event/op',
        '/detector/event/value',
        '/detector/window',
        '/detector/limit',
        '/latching',
        '/gates/0/signal/path',
        '/gates/0/limit/value',
        '/gates/0/hysteresis'
      ])
    )
  })
})
