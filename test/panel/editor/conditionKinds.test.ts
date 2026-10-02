import { describe, expect, it } from 'vitest'
import {
  CONDITION_KINDS,
  kindOf,
  kindsFor,
  withKind,
  type ConditionKind
} from '../../../src/panel/editor/conditionKinds'
import { emptyForm, emptyStep, type RuleForm } from '../../../src/panel/editor/formModel'

const DETECTORS: [ConditionKind, Partial<RuleForm['detector']>][] = [
  ['below', { type: 'sustained', direction: 'below' }],
  ['above', { type: 'sustained', direction: 'above' }],
  ['rate', { type: 'slope' }],
  ['projection', { type: 'projection' }],
  ['silent', { type: 'match', matchOp: 'timedOut' }],
  ['state', { type: 'match', matchOp: 'equals' }],
  ['often', { type: 'count' }],
  ['total', { type: 'accumulator', measure: 'time' }],
  ['missing', { type: 'absence' }]
]

describe('condition kinds', () => {
  it.each(DETECTORS)('maps %s onto its detector, and back', (kind, detector) => {
    const form = withKind(emptyForm(), kind)
    expect(form.detector).toMatchObject(detector)
    expect(kindOf(form.detector)).toBe(kind)
  })

  it('reads any match other than a timeout as a given state', () => {
    for (const matchOp of ['notEquals', 'changesTo', 'decreases'] as const) {
      expect(kindOf({ ...emptyForm().detector, type: 'match', matchOp })).toBe('state')
    }
  })

  it('has no kind until a detector is chosen', () => {
    expect(kindOf(emptyForm().detector)).toBeUndefined()
  })

  it('keeps the trend chosen for a rate when switching to a projection', () => {
    const rate = withKind(emptyForm(), 'rate')
    rate.detector.trend = 'falling'
    expect(withKind(rate, 'projection').detector.trend).toBe('falling')
  })

  it('keeps a typed limit from below to above a limit, and drops it for a count', () => {
    const below = withKind(emptyForm(), 'below')
    below.steps = [{ ...emptyStep('warning'), limit: '12' }]
    expect(withKind(below, 'above').steps).toEqual(below.steps)
    expect(withKind(below, 'often').steps).toEqual([emptyStep('warning')])
  })

  it('offers every kind for a number, and those that need no number otherwise', () => {
    expect(kindsFor(12.4).map((k) => k.kind)).toEqual(CONDITION_KINDS.map((k) => k.kind))
    expect(kindsFor(undefined)).toHaveLength(CONDITION_KINDS.length)
    expect(kindsFor('inverting').map((k) => k.kind)).toEqual([
      'silent',
      'state',
      'often',
      'total',
      'missing'
    ])
  })

  it('gives each kind a label and a real example', () => {
    for (const k of CONDITION_KINDS) {
      expect(k.label).not.toBe('')
      expect(k.example).toMatch(/^e\.g\. /)
    }
  })
})
