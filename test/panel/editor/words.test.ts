import { describe, expect, it } from 'vitest'
import {
  emptySignal,
  emptyStep,
  hasWildcard,
  type SignalForm,
  type StepForm
} from '../../../src/panel/editor/formModel'
import { clearMarginText, pathName, subjectOf } from '../../../src/panel/editor/words'
import { unitLookup, type Measure } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'

const single = (path: string): SignalForm => ({ ...emptySignal(), slots: [{ path, source: '' }] })
const none = unitLookup([], displayUnit({ units: 'm' }))

describe('subjectOf', () => {
  it("names a field after its base path's words", () => {
    expect(subjectOf(single('navigation.attitude#/roll'), none)).toBe('Attitude roll')
    expect(subjectOf(single('navigation.attitude.roll'), none)).toBe('Attitude roll')
  })

  it('names a nested field and a field of an instance as the rule detail does', () => {
    expect(subjectOf(single('navigation.attitude#/a/b'), none)).toBe('Attitude a b')
    expect(pathName('navigation.attitude#/a/b')).toBe('Attitude a b')
    expect(subjectOf(single('electrical.batteries.house#/voltage'), none)).toBe('House voltage')
  })

  it("prefers the field's display name from metadata", () => {
    const named = unitLookup(
      [{ path: 'navigation.attitude#/roll', unit: displayUnit({}), displayName: 'Heel' }],
      displayUnit({ units: 'm' })
    )
    expect(subjectOf(single('navigation.attitude#/roll'), named)).toBe('Heel')
  })

  it('reads a wildcard directly before the pointer as the instance', () => {
    expect(subjectOf(single('electrical.batteries.*#/voltage'), none)).toBe('Voltage of {instance}')
    expect(subjectOf(single('propulsion.*.attitude#/roll'), none)).toBe(
      'Attitude roll of {instance}'
    )
    expect(hasWildcard(single('electrical.batteries.*#/voltage'))).toBe(true)
    expect(hasWildcard(single('navigation.attitude#/roll'))).toBe(false)
  })

  it('names a combination of fields by its inputs', () => {
    const combined: SignalForm = {
      ...emptySignal(),
      mode: 'combine',
      slots: [
        { path: 'navigation.attitude#/roll', source: '' },
        { path: 'navigation.attitude#/pitch', source: '' }
      ]
    }
    expect(subjectOf(combined, none)).toBe('Difference of attitude roll and attitude pitch')
  })
})

const DEGREES: Measure = {
  kind: 'absolute',
  unit: displayUnit({
    units: 'rad',
    displayUnits: { formula: 'value * 57.29577951308232', symbol: '°' }
  })
}

const range = (low: string, high: string, patch: Partial<StepForm> = {}): StepForm => ({
  ...emptyStep('warning'),
  low,
  high,
  ...patch
})

describe('clearMarginText', () => {
  it('names half the first range and the range, in display units', () => {
    expect(clearMarginText(range('-25', '25'), DEGREES)).toBe(
      "The hysteresis must be less than 25 °, half the warning's range -25 to 25 °."
    )
  })

  it('reads a decimal comma, and names a step with no priority by its place', () => {
    expect(clearMarginText(range('10,5', '12', { priority: '' }), DEGREES)).toBe(
      "The hysteresis must be less than 0.75 °, half the first step's range 10,5 to 12 °."
    )
  })

  it('says nothing while the range is not filled in', () => {
    expect(clearMarginText(range('-25', ''), DEGREES)).toBeUndefined()
  })
})
