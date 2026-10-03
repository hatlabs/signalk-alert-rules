import { describe, expect, it } from 'vitest'
import {
  CONDITION_KINDS,
  kindOf,
  kindsFor,
  withKind,
  type ConditionKind
} from '../../../src/panel/editor/conditionKinds'
import {
  emptyForm,
  emptyStep,
  isZoneLimited,
  type RuleForm
} from '../../../src/panel/editor/formModel'

const DETECTORS: [ConditionKind, Partial<RuleForm['detector']>][] = [
  ['below', { type: 'sustained', direction: 'below' }],
  ['above', { type: 'sustained', direction: 'above' }],
  ['outside', { type: 'outside' }],
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

  it('offers outside a range among the main kinds, after above a limit', () => {
    const main = CONDITION_KINDS.filter((k) => k.main).map((k) => k.kind)
    expect(main.slice(0, 3)).toEqual(['below', 'above', 'outside'])
    expect(CONDITION_KINDS.find((k) => k.kind === 'outside')).toMatchObject({
      label: 'Outside a range',
      example: 'e.g. heel more than 25° either way',
      numeric: true
    })
  })

  it('starts outside a range afresh with one empty step, and below again', () => {
    const below = withKind(emptyForm(), 'below')
    below.steps = [
      { ...emptyStep('warning'), limit: '12.2' },
      { ...emptyStep('alarm'), limit: '11.8' }
    ]
    const outside = withKind(below, 'outside')
    expect(outside.steps).toEqual([emptyStep('warning')])
    outside.steps = [{ ...emptyStep('warning'), low: '11', high: '15' }]
    expect(withKind(outside, 'below').steps).toEqual([emptyStep('warning')])
  })

  it('turns the zones off for outside a range, so below comes back typed', () => {
    const below = withKind(emptyForm(), 'below')
    below.detector.limit = { ...below.detector.limit, kind: 'zone' }
    expect(isZoneLimited(below.detector)).toBe(true)
    const outside = withKind(below, 'outside')
    expect(outside.detector.limit.kind).toBe('fixed')
    expect(isZoneLimited(outside.detector)).toBe(false)
    expect(isZoneLimited(withKind(outside, 'below').detector)).toBe(false)
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
