import { describe, expect, it } from 'vitest'
import { emptyStep, type StepForm } from '../../../src/panel/editor/formModel'
import { clearMarginText } from '../../../src/panel/editor/words'
import type { Measure } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'

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
      "The clear margin must be less than 25 °, half the warning's range -25 to 25 °."
    )
  })

  it('reads a decimal comma, and names a step with no priority by its place', () => {
    expect(clearMarginText(range('10,5', '12', { priority: '' }), DEGREES)).toBe(
      "The clear margin must be less than 0.75 °, half the first step's range 10,5 to 12 °."
    )
  })

  it('says nothing while the range is not filled in', () => {
    expect(clearMarginText(range('-25', ''), DEGREES)).toBeUndefined()
  })
})
