import { describe, expect, it } from 'vitest'
import { withKind } from '../../../src/panel/editor/conditionKinds'
import { emptyForm, emptyStep, type StepForm } from '../../../src/panel/editor/formModel'
import { ladderText, nowText, priorityMeaning } from '../../../src/panel/editor/live'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'

const units = unitLookup(
  [
    {
      path: 'electrical.batteries.house.voltage',
      units: 'V',
      unit: displayUnit({ units: 'V', displayUnits: { formula: 'value', symbol: 'V' } })
    },
    { path: 'electrical.inverters.main.state', unit: displayUnit({}) },
    {
      path: 'environment.wind.angleApparent',
      units: 'rad',
      unit: displayUnit({
        units: 'rad',
        displayUnits: { formula: 'value * 57.29577951308232', symbol: '°' }
      })
    }
  ],
  displayUnit({ units: 'm' })
)

const step = (patch: Partial<StepForm>): StepForm => ({ ...emptyStep('warning'), ...patch })

function below(...limits: string[]) {
  const f = withKind(emptyForm(), 'below')
  f.signal.slots[0].path = 'electrical.batteries.house.voltage'
  f.steps = limits.map((limit, i) => step({ limit, priority: i === 0 ? 'warning' : 'alarm' }))
  return f
}

const DEGREE = Math.PI / 180

function outside(...ranges: [string, string][]) {
  const f = withKind(emptyForm(), 'outside')
  f.signal.slots[0].path = 'environment.wind.angleApparent'
  f.steps = ranges.map(([low, high], i) =>
    step({ low, high, priority: i === 0 ? 'warning' : 'alarm' })
  )
  return f
}

describe('priorityMeaning', () => {
  it('says what a caution means: no acknowledgement and no sound', () => {
    expect(priorityMeaning('caution')).toBe(
      'requires attention, not immediately hazardous. Needs no acknowledgement; makes no sound.'
    )
  })

  it('says a warning must be acknowledged', () => {
    expect(priorityMeaning('warning')).toMatch(/Must be acknowledged/)
  })
})

describe('nowText', () => {
  it('says the value would not alert while it is past no limit', () => {
    expect(nowText(below('12.8'), 13.31, units)).toBe('Now 13.31 V: would not alert.')
  })

  it('names the furthest step the value is past', () => {
    expect(nowText(below('12.2', '11.8'), 12, units)).toBe('Now 12 V: would alert as a warning.')
    expect(nowText(below('12.2', '11.8'), 11.6, units)).toBe('Now 11.6 V: would alert as an alarm.')
  })

  it('gives only the value while the limit is not typed or the condition is not a comparison', () => {
    expect(nowText(below(''), 13.31, units)).toBe('Now 13.31 V.')
    const rate = withKind(below('1'), 'rate')
    expect(nowText(rate, 13.31, units)).toBe('Now 13.31 V.')
  })

  it('compares a state with the values of its steps', () => {
    const f = withKind(emptyForm(), 'state')
    f.signal.slots[0].path = 'electrical.inverters.main.state'
    f.steps = [step({ value: { type: 'text', text: 'fault' } })]
    expect(nowText(f, 'inverting', units)).toBe('Now inverting: would not alert.')
    expect(nowText(f, 'fault', units)).toBe('Now fault: would alert as a warning.')
  })

  it('says outside a range would alert, naming the side and limit passed', () => {
    const f = outside(['-25', '25'], ['-35', '35'])
    expect(nowText(f, 27 * DEGREE, units)).toBe('Now 27 °: would alert as a warning (above 25 °).')
    expect(nowText(f, -37 * DEGREE, units)).toBe(
      'Now -37 °: would alert as an alarm (below -35 °).'
    )
    expect(nowText(f, 3 * DEGREE, units)).toBe('Now 3 °: would not alert.')
  })

  it('gives only the value while a limit of the range is not typed', () => {
    expect(nowText(outside(['-25', '']), 27 * DEGREE, units)).toBe('Now 27 °.')
  })

  it('says nothing without a value', () => {
    expect(nowText(below('12'), undefined, units)).toBeUndefined()
  })
})

describe('ladderText', () => {
  it('words the climb and when it clears, for several steps', () => {
    expect(ladderText(below('12.2', '11.8'), units)).toBe(
      'The alert is raised as a warning below 12.2 V and becomes an alarm below 11.8 V. It clears only above 12.2 V.'
    )
  })

  it('words the climb of ranges, clearing between the first range as typed', () => {
    expect(ladderText(outside(['-25', '25'], ['-35', '35']), units)).toBe(
      'The alert is raised as a warning outside -25 to 25 ° and becomes an alarm outside -35 to 35 °. It clears only between -25 and 25 °.'
    )
  })

  it('says nothing for a single step', () => {
    expect(ladderText(below('12.2'), units)).toBeUndefined()
  })
})
