import { describe, expect, it } from 'vitest'
import { withKind } from '../../../src/panel/editor/conditionKinds'
import { emptyForm, emptyStep, type StepForm } from '../../../src/panel/editor/formModel'
import {
  hysteresisHint,
  ladderText,
  nowText,
  priorityMeaning
} from '../../../src/panel/editor/live'
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
      path: 'propulsion.main.temperature',
      units: 'K',
      unit: displayUnit({ units: 'K', displayUnits: { formula: 'value - 273.15', symbol: '°C' } })
    },
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

  it('says a value exactly on a limit is inside the range, as the detector judges', () => {
    const f = withKind(below(), 'outside')
    f.steps = [step({ low: '11.5', high: '14.8' })]
    expect(nowText(f, 14.8, units)).toBe('Now 14.8 V: would not alert.')
    expect(nowText(f, 11.5, units)).toBe('Now 11.5 V: would not alert.')
  })

  it('gives only the value while a limit of the range is not typed', () => {
    expect(nowText(outside(['-25', '']), 27 * DEGREE, units)).toBe('Now 27 °.')
  })

  it('says nothing without a value', () => {
    expect(nowText(below('12'), undefined, units)).toBeUndefined()
  })
})

describe('ladderText', () => {
  it('clears past the first step by the clear margin', () => {
    const f = below('12.2', '11.8')
    f.detector.hysteresis = '0.2'
    expect(ladderText(f, units)).toBe(
      'The alert is raised as a warning below 12.2 V and becomes an alarm below 11.8 V. It ends only once back above 12.4 V.'
    )
  })

  it('narrows the range it clears in by the clear margin', () => {
    const f = outside(['-25', '25'], ['-35', '35'])
    f.detector.hysteresis = '2'
    expect(ladderText(f, units)).toBe(
      'The alert is raised as a warning outside -25 to 25 ° and becomes an alarm outside -35 to 35 °. It ends only once back between -23 and 23 °.'
    )
  })

  it('clears below the first limit less the margin, for a rule above it', () => {
    const f = withKind(emptyForm(), 'above')
    f.signal.slots[0].path = 'electrical.batteries.house.voltage'
    f.steps = [step({ limit: '14.4' }), step({ limit: '14.8', priority: 'alarm' })]
    f.detector.hysteresis = '0.2'
    expect(ladderText(f, units)).toBe(
      'The alert is raised as a warning above 14.4 V and becomes an alarm above 14.8 V. It ends only once back below 14.2 V.'
    )
  })

  // An offset unit tells a margin converted as a difference from one converted as a temperature.
  it('moves the clear point by the margin as a difference, in an offset unit', () => {
    const f = withKind(emptyForm(), 'above')
    f.signal.slots[0].path = 'propulsion.main.temperature'
    f.steps = [step({ limit: '95' }), step({ limit: '100', priority: 'alarm' })]
    f.detector.hysteresis = '2'
    expect(ladderText(f, units)).toBe(
      'The alert is raised as a warning above 95 °C and becomes an alarm above 100 °C. It ends only once back below 93 °C.'
    )
  })

  it('words the climb and when it clears, for several steps', () => {
    expect(ladderText(below('12.2', '11.8'), units)).toBe(
      'The alert is raised as a warning below 12.2 V and becomes an alarm below 11.8 V. It ends once back above 12.2 V.'
    )
  })

  it('words the climb of ranges, clearing between the first range as typed', () => {
    expect(ladderText(outside(['-25', '25'], ['-35', '35']), units)).toBe(
      'The alert is raised as a warning outside -25 to 25 ° and becomes an alarm outside -35 to 35 °. It ends once back between -25 and 25 °.'
    )
  })

  it('holds the place of a range not fully typed, and says when it clears once it is', () => {
    expect(ladderText(outside(['-25', ''], ['-35', '35']), units)).toBe(
      'The alert is raised as a warning outside … and becomes an alarm outside -35 to 35 °.'
    )
    expect(ladderText(outside(['-25', '25'], ['-35', '35']), units)).toBe(
      'The alert is raised as a warning outside -25 to 25 ° and becomes an alarm outside -35 to 35 °. It ends once back between -25 and 25 °.'
    )
  })

  it('says nothing for a single step', () => {
    expect(ladderText(below('12.2'), units)).toBeUndefined()
  })
})

describe('hysteresisHint', () => {
  const DEFINED = 'How far past the limit the value must return before the alert ends.'
  const eased = (f: ReturnType<typeof below>, hysteresis: string) => {
    f.detector.hysteresis = hysteresis
    return f
  }

  it('gives the level past the first limit, which the summary ends at too', () => {
    const f = eased(below('12.2', '11.8'), '0.2')
    expect(hysteresisHint(f, units)).toBe('Alert ends at 12.4 V.')
    expect(ladderText(f, units)).toContain('It ends only once back above 12.4 V.')
  })

  it.each(['', '0', ' '])('gives the first limit itself for a hysteresis of %j', (typed) => {
    expect(hysteresisHint(eased(below('12.2'), typed), units)).toBe('Alert ends at 12.2 V.')
  })

  it('moves the level as a difference, in an offset unit', () => {
    const f = withKind(emptyForm(), 'above')
    f.signal.slots[0].path = 'propulsion.main.temperature'
    f.steps = [step({ limit: '95' })]
    expect(hysteresisHint(eased(f, '2'), units)).toBe('Alert ends at 93 °C.')
  })

  it('narrows a range from both sides', () => {
    expect(hysteresisHint(eased(outside(['-25', '25']), '2'), units)).toBe(
      'Alert ends inside -23–23 °.'
    )
    expect(hysteresisHint(outside(['-25', '25']), units)).toBe('Alert ends inside -25–25 °.')
  })

  it('defines the term for a hysteresis as wide as half the range', () => {
    expect(hysteresisHint(eased(outside(['-25', '25']), '25'), units)).toBe(DEFINED)
    const f = eased(outside(['-25', '25'], ['-35', '35']), '30')
    expect(ladderText(f, units)).not.toContain('It ends')
  })

  it('defines the term without a first limit, or for a hysteresis that is not a number', () => {
    expect(hysteresisHint(eased(below(''), '0.2'), units)).toBe(DEFINED)
    expect(hysteresisHint(eased(outside(['-25', '']), '2'), units)).toBe(DEFINED)
    const f = eased(below('12.2', '11.8'), 'abc')
    expect(hysteresisHint(f, units)).toBe(DEFINED)
    expect(ladderText(f, units)).not.toContain('It ends')
  })

  it('tells a zone limit’s level from the zone, on the side the value comes back to', () => {
    const zoned = (kind: 'below' | 'above', hysteresis: string) => {
      const f = eased(withKind(emptyForm(), kind), hysteresis)
      f.signal.slots[0].path = 'electrical.batteries.house.voltage'
      f.detector.limit = { ...f.detector.limit, kind: 'zone', level: 'warn' }
      f.steps = []
      return f
    }
    expect(hysteresisHint(zoned('below', '0.2'), units)).toBe(
      'Alert ends 0.2 V above the warn zone.'
    )
    expect(hysteresisHint(zoned('above', '0.2'), units)).toBe(
      'Alert ends 0.2 V below the warn zone.'
    )
    expect(hysteresisHint(zoned('below', ''), units)).toBe('Alert ends above the warn zone.')
    expect(hysteresisHint(zoned('below', '0'), units)).toBe('Alert ends above the warn zone.')
    const unchosen = zoned('below', '0.2')
    unchosen.detector.limit.level = ''
    expect(hysteresisHint(unchosen, units)).toBe(DEFINED)
  })
})
