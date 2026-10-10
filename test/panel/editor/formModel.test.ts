import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMBINATORS,
  MAX_COMBINATOR_INPUTS,
  MAX_GATES as MODEL_MAX_GATES,
  MAX_SLUG_LENGTH,
  PRIORITIES,
  type Detector,
  type Event,
  type Rule
} from '../../../src/model/rule'
import {
  ANGULAR_COMBINATORS,
  POSITION_COMBINATORS,
  TWO_INPUTS,
  validateRule
} from '../../../src/model/validate'
import { defaultCondition } from '../../../src/alerts/paths'
import {
  ANGULAR_KINDS,
  COMBINATOR_KINDS,
  defaultFormCondition,
  emptyForm,
  emptyGate,
  emptyStep,
  forgetEdited,
  formAlertPrefix,
  fromBody,
  fromRule,
  holdsFor,
  maxSteps,
  MAX_GATES,
  MAX_INPUTS,
  MAX_SLUG,
  PRIORITY_LEVELS,
  setCombinator,
  setMode,
  slugify,
  toRule,
  TWO_INPUT_KINDS,
  withDetector,
  revealed,
  withNumbersInUnit,
  withoutGate,
  withUnitErrors,
  type RuleForm
} from '../../../src/panel/editor/formModel'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import {
  NO_UNITS,
  POSITION_KINDS,
  unitLookup,
  type UnitLookup
} from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')

function examples(): [string, Rule][] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.json'))
    .map((f): [string, Rule] => [f, JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')) as Rule])
}

function example(slug: string): Rule {
  return JSON.parse(readFileSync(join(EXAMPLES, `${slug}.json`), 'utf8')) as Rule
}

/** The first step's limit of a rule whose detector has numeric steps. */
function firstLimit(rule: Rule): number | undefined {
  const step = rule.detector.steps?.[0]
  return step !== undefined && 'limit' in step ? step.limit : undefined
}

const unit = (units: string, formula: string, symbol: string) =>
  displayUnit({ units, displayUnits: { formula, symbol } })

const shown: PathEntry[] = [
  {
    path: 'propulsion.port.coolantTemperature',
    units: 'K',
    unit: unit('K', 'value - 273.15', '°C')
  },
  { path: 'propulsion.port.revolutions', units: 'Hz', unit: unit('Hz', 'value * 60', 'rpm') },
  {
    path: 'propulsion.starboard.revolutions',
    units: 'Hz',
    unit: unit('Hz', 'value * 60', 'rpm')
  },
  { path: 'propulsion.main.revolutions', units: 'Hz', unit: unit('Hz', 'value * 60', 'rpm') },
  {
    path: 'electrical.batteries.house.voltage',
    units: 'V',
    unit: unit('V', 'value * 1', 'V')
  },
  {
    path: 'tanks.freshWater.0.currentLevel',
    units: 'ratio',
    unit: unit('ratio', 'value * 100', '%')
  },
  {
    path: 'navigation.headingMagnetic',
    units: 'rad',
    unit: unit('rad', 'value * 57.29577951308232', '°')
  },
  {
    path: 'environment.outside.temperature',
    units: 'K',
    unit: unit('K', '(value - 273.15) * 9 / 5 + 32', '°F')
  }
]
const displayed = unitLookup(shown, unit('m', 'value * 0.0005399568034557236', 'nmi'))

/** A form after the user has done what `edit` does to a fresh one. */
function authored(edit: (form: RuleForm) => void): RuleForm {
  const form = emptyForm()
  edit(form)
  return form
}

/** A stored body as the form opens it. */
const bodyForm = (body: unknown, units: UnitLookup): RuleForm => fromBody(body, units).form

function saved(form: RuleForm, units = displayed): Rule {
  const result = toRule(form, units)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.rule
}

describe('the form model mirrors the rule model', () => {
  it('offers exactly the combinators and priorities the model has', () => {
    expect([...COMBINATOR_KINDS]).toEqual([...COMBINATORS])
    expect([...PRIORITY_LEVELS]).toEqual([...PRIORITIES])
  })

  it('bounds inputs, slugs and gates as the model does', () => {
    expect(MAX_INPUTS).toBe(MAX_COMBINATOR_INPUTS)
    expect(MAX_SLUG).toBe(MAX_SLUG_LENGTH)
    expect(MAX_GATES).toBe(MODEL_MAX_GATES)
  })

  it('groups the combinators as the model does', () => {
    expect([...TWO_INPUT_KINDS].sort()).toEqual([...TWO_INPUTS].sort())
    expect([...POSITION_KINDS].sort()).toEqual([...POSITION_COMBINATORS].sort())
    expect([...ANGULAR_KINDS].sort()).toEqual([...ANGULAR_COMBINATORS].sort())
  })
})

describe('the condition name of a form', () => {
  const INPUT = 'electrical.batteries.house.voltage'
  const one = [{ limit: 1, priority: 'warning' }] as const
  const warning = { priority: 'warning' } as const
  const event = { op: 'changes' } as const
  const states: [Detector, string][] = [
    [{ type: 'sustained', direction: 'above', steps: [...one] }, 'voltageHigh'],
    [{ type: 'sustained', direction: 'below', steps: [...one] }, 'voltageLow'],
    [{ type: 'slope', direction: 'rising', window: 60, steps: [...one] }, 'voltageRising'],
    [{ type: 'slope', direction: 'falling', window: 60, steps: [...one] }, 'voltageFalling'],
    [
      { type: 'projection', direction: 'rising', steps: [...one], window: 60, horizon: 600 },
      'voltageProjectedHigh'
    ],
    [
      { type: 'projection', direction: 'falling', steps: [...one], window: 60, horizon: 600 },
      'voltageProjectedLow'
    ],
    [{ type: 'match', op: 'equals', steps: [{ ...warning, value: 1 }] }, 'voltageMatch'],
    [{ type: 'match', op: 'notEquals', steps: [{ ...warning, value: 1 }] }, 'voltageMismatch'],
    [{ type: 'match', op: 'changesTo', steps: [{ ...warning, value: 1 }] }, 'voltageChanged'],
    [{ type: 'match', op: 'decreases', steps: [warning] }, 'voltageDecreased'],
    [{ type: 'match', op: 'timedOut', steps: [warning], duration: 60 }, 'voltageTimedOut'],
    [
      { type: 'accumulator', measure: 'time', steps: [{ ...warning, limit: 3600 }] },
      'voltageAccumulated'
    ],
    [{ type: 'count', event, window: 60, steps: [{ ...warning, limit: 3 }] }, 'voltageFrequent'],
    [{ type: 'absence', event, steps: [{ ...warning, within: 60 }] }, 'voltageMissing'],
    [{ type: 'outside', steps: [{ ...warning, low: 11, high: 15 }] }, 'voltageOutOfRange']
  ]

  it.each(states)('is the default of the detector the form saves: %j', (detector, condition) => {
    const base = { name: 'r', slug: 'r', message: 'm' }
    const result = validateRule({ ...base, signal: { path: INPUT }, detector })
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const rule = result.value
    const form = fromRule(rule, NO_UNITS)
    expect(defaultCondition(rule.signal, saved(form, NO_UNITS).detector)).toBe(condition)
    expect(defaultFormCondition(form)).toBe(condition)
  })

  it('is undefined until the direction, trend or match operator is chosen', () => {
    for (const type of ['sustained', 'slope', 'projection', 'match'] as const) {
      const form = authored((f) => {
        f.signal.slots = [{ path: INPUT, source: '' }]
        f.detector.type = type
      })
      expect(defaultFormCondition(form)).toBeUndefined()
    }
  })

  it("saves only a typed name, the default staying the input and detector's", () => {
    const form = authored((f) => {
      Object.assign(f, { name: 'r', slug: 'r', message: 'm' })
      f.steps[0].priority = 'warning'
      f.signal.slots = [{ path: INPUT, source: '' }]
      f.detector.type = 'sustained'
      f.detector.direction = 'below'
      f.steps[0].limit = '12'
    })
    expect(defaultFormCondition(form)).toBe('voltageLow')
    expect(saved(form, NO_UNITS)).not.toHaveProperty('condition')
    const typed = { ...form, condition: 'flat' }
    expect(defaultFormCondition(typed)).toBe('voltageLow')
    expect(saved(typed, NO_UNITS)).toMatchObject({ condition: 'flat' })
  })

  it('loads a stored name, and none for a rule that stores none', () => {
    const base = { name: 'r', slug: 'r', message: 'm' }
    const detector = states[1][0]
    const rule: Rule = { ...base, signal: { path: INPUT }, detector }
    expect(fromRule(rule, NO_UNITS).condition).toBe('')
    expect(fromRule({ ...rule, condition: 'voltageLow' }, NO_UNITS).condition).toBe('voltageLow')
  })
})

describe('the alert path prefix of a form', () => {
  const prefix = (edit: (f: RuleForm) => void) => formAlertPrefix(authored(edit))

  it("is the input's parent under alerts., its wildcard kept", () => {
    expect(
      prefix((f) => {
        f.signal.slots = [{ path: 'electrical.batteries.*.voltage', source: '' }]
      })
    ).toBe('alerts.electrical.batteries.*.')
  })

  it("is the common parent of a combined signal's inputs, or alerts. alone", () => {
    const combined = (paths: string[]) =>
      prefix((f) => {
        f.signal = setCombinator(setMode(f.signal, 'combine'), 'absDifference')
        f.signal.slots = paths.map((path) => ({ path, source: '' }))
      })
    expect(combined(['propulsion.port.revolutions', 'propulsion.starboard.revolutions'])).toBe(
      'alerts.propulsion.'
    )
    expect(combined(['environment.depth.belowKeel', 'navigation.speedThroughWater'])).toBe(
      'alerts.'
    )
  })

  it('is alerts. alone until an input is chosen', () => {
    expect(prefix(() => undefined)).toBe('alerts.')
  })
})

describe('worked examples round-trip through the form', () => {
  it.each(examples())('%s, in SI', (_, rule) => {
    expect(saved(fromRule(rule, NO_UNITS), NO_UNITS)).toEqual(rule)
  })

  it.each(examples())('%s, in display units', (_, rule) => {
    expect(saved(fromRule(rule, displayed))).toEqual(rule)
  })
})

describe('every event op round-trips through the form', () => {
  const ops = ['changes', 'decreases'] as const
  it.each(ops)('a count event that %s', (op) => {
    const bilge = example('bilge-pump-cycling')
    const rule = { ...bilge, detector: { ...bilge.detector, event: { op } } } as Rule
    expect(saved(fromRule(rule, NO_UNITS), NO_UNITS)).toEqual(rule)
  })

  it.each(ops)('an accumulator reset when its event %s', (op) => {
    const engine = example('engine-service-due')
    const rule = {
      ...engine,
      detector: { ...engine.detector, resetOn: { op } }
    } as Rule
    expect(saved(fromRule(rule, NO_UNITS), NO_UNITS)).toEqual(rule)
  })
})

describe('every stored choice round-trips through the form', () => {
  const roundTrips = (rule: Rule) => {
    expect(saved(fromRule(rule, NO_UNITS), NO_UNITS)).toEqual(rule)
  }

  it.each(['equals', 'notEquals', 'changesTo'] as const)('a match that %s a state', (op) => {
    // Only a change to a state can latch.
    const { latching: _latching, ...engine } = example('engine-stopped')
    roundTrips({ ...engine, detector: { ...engine.detector, op } } as Rule)
  })

  it.each(['time', 'integral'] as const)('an accumulator totalling %s', (measure) => {
    const engine = example('engine-service-due')
    roundTrips({ ...engine, detector: { ...engine.detector, measure } } as Rule)
  })

  it.each(['above', 'below', 'equals', 'notEquals'] as const)(
    'an accumulator counting while the value is %s',
    (op) => {
      const engine = example('engine-service-due')
      const detector = engine.detector as Extract<Rule['detector'], { type: 'accumulator' }>
      roundTrips({ ...engine, detector: { ...detector, while: { op, value: 0 } } })
    }
  )
})

describe('a rule made from a template', () => {
  it('keeps the template it records through an edit', () => {
    const template = {
      set: 'builtin',
      id: 'battery-voltage-low',
      version: '1.0.0',
      pick: { instance: 'house' }
    }
    const rule = { ...example('house-battery-low'), template }
    const form = fromRule(rule, NO_UNITS)
    form.name = 'House bank low'
    expect(saved(form, NO_UNITS)).toEqual({ ...rule, name: 'House bank low' })
  })

  it('records no template on a new rule', () => {
    expect(emptyForm().template).toBeUndefined()
  })
})

describe('a rule with escalation steps', () => {
  const stepped: Rule = {
    name: 'House voltage low',
    slug: 'house-voltage-low',
    message: 'House voltage is low',
    signal: { path: 'electrical.batteries.house.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [
        { limit: 12.2, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ],
      duration: 60
    }
  }
  const matching: Rule = {
    name: 'Inverter fault',
    slug: 'inverter-fault',
    message: 'Inverter fault',
    signal: { path: 'electrical.inverters.main.state' },
    detector: {
      type: 'match',
      op: 'equals',
      steps: [
        { value: 'fault', priority: 'warning' },
        { value: 'critical', priority: 'alarm' }
      ]
    }
  }

  it.each([
    ['a value limit', stepped],
    ['a match', matching]
  ])('round-trips %s with every step', (_, rule) => {
    expect(saved(fromRule(rule, displayed))).toEqual(rule)
  })

  it('shows every step and saves an edit to any of them', () => {
    const form = fromRule(stepped, displayed)
    expect(form.steps.map((step) => [step.limit, step.priority])).toEqual([
      ['12.2', 'warning'],
      ['11.8', 'alarm']
    ])
    form.steps[1].limit = '11.5'
    form.steps[0].priority = 'caution'
    expect(saved(form).detector.steps).toEqual([
      { limit: 12.2, priority: 'caution' },
      { limit: 11.5, priority: 'alarm' }
    ])
  })

  it('saves a step added after the first', () => {
    const form = fromRule(stepped, displayed)
    form.steps.push({ ...emptyStep('emergency'), limit: '11' })
    expect(saved(form).detector.steps).toHaveLength(3)
  })

  it('keeps the steps through a change of detector whose limits mean the same', () => {
    const form = withDetector(fromRule(stepped, displayed), {
      type: 'projection',
      trend: 'falling',
      window: { amount: '10', unit: 'min' },
      horizon: { amount: '1', unit: 'h' }
    })
    expect(saved(form).detector.steps).toEqual(stepped.detector.steps)
  })

  it('starts the steps afresh, keeping the first priority, when their limits change meaning', () => {
    const form = withDetector(fromRule(stepped, displayed), {
      type: 'count',
      window: { amount: '1', unit: 'h' }
    })
    expect(form.steps).toEqual([emptyStep('warning')])
  })

  it('keeps one step for a match that takes no value', () => {
    const form = withDetector(fromRule(matching, displayed), { matchOp: 'notEquals' })
    expect(saved(form).detector.steps).toEqual([{ value: 'fault', priority: 'warning' }])
    expect(maxSteps(form.detector)).toBe(1)
  })

  it('keeps the typed steps while zones stand in for them', () => {
    const form = fromRule(stepped, displayed)
    const zoned = withDetector(form, { limit: { ...form.detector.limit, kind: 'zone' } })
    const back = withDetector(zoned, { limit: { ...form.detector.limit, kind: 'fixed' } })
    expect(back.steps).toEqual(form.steps)
  })

  it('saves no steps for a zone limit', () => {
    const form = fromRule(stepped, displayed)
    form.detector.limit.kind = 'zone'
    const detector = saved(form).detector
    expect(detector.steps).toBeUndefined()
    expect(detector).toMatchObject({ limit: { kind: 'zone', level: 'warn' } })
    expect(maxSteps(form.detector)).toBe(0)
  })

  it('names a missing limit by its step', () => {
    const form = fromRule(stepped, displayed)
    form.steps[1].limit = ''
    const result = toRule(form, displayed)
    expect(!result.ok && result.errors).toEqual([
      { path: '/detector/steps/1/limit', message: 'is required' }
    ])
  })
})

describe('an outside rule', () => {
  const heel: Rule = {
    name: 'Heading off course',
    slug: 'heading-off-course',
    message: 'Heading off course',
    signal: { path: 'navigation.headingMagnetic' },
    detector: {
      type: 'outside',
      steps: [
        { low: -0.4363323129985824, high: 0.4363323129985824, priority: 'warning' },
        { low: -0.6108652381980153, high: 0.6108652381980153, priority: 'alarm' }
      ],
      duration: 10,
      hysteresis: 0.03490658503988659
    }
  }

  function outside(low: string, high: string, path = 'environment.outside.temperature') {
    return authored((f) => {
      Object.assign(f, { name: 'r', slug: 'r', message: 'm' })
      f.signal.slots[0].path = path
      f.detector.type = 'outside'
      f.steps = [{ ...emptyStep('warning'), low, high }]
    })
  }

  it('shows each step as typed low and high limits in the display unit', () => {
    const form = fromRule(heel, displayed)
    expect(form.detector.type).toBe('outside')
    expect(form.steps.map((s) => [s.priority, s.low, s.high])).toEqual([
      ['warning', '-25', '25'],
      ['alarm', '-35', '35']
    ])
    expect(form.detector.hysteresis).toBe('2')
    expect(form.detector.duration).toEqual({ amount: '10', unit: 's' })
  })

  it('round-trips with every step and its timing', () => {
    expect(saved(fromRule(heel, displayed))).toEqual(heel)
    expect(saved(fromRule(heel, NO_UNITS), NO_UNITS)).toEqual(heel)
  })

  it('stores a range typed in °F in kelvin, and shows it back in °F', () => {
    const rule = saved(outside('-4', '104'))
    const steps = rule.detector.type === 'outside' ? rule.detector.steps : []
    expect(steps[0]?.low).toBeCloseTo(253.15)
    expect(steps[0]?.high).toBeCloseTo(313.15)
    const [back] = fromRule(rule, displayed).steps
    expect([back.low, back.high]).toEqual(['-4', '104'])
  })

  it('names a missing or malformed limit by its side', () => {
    const result = toRule(outside('', 'x'), displayed)
    expect(!result.ok && result.errors).toEqual([
      { path: '/detector/steps/0/low', message: 'is required' },
      { path: '/detector/steps/0/high', message: 'must be a number' }
    ])
  })

  it('opens an outside rule that does not validate with its kind kept', () => {
    const body = { ...heel, detector: { ...heel.detector, hysteresis: 1 } }
    expect(bodyForm(body, displayed).detector.type).toBe('outside')
  })

  it('holds for a duration and takes up to four steps', () => {
    const form = fromRule(heel, displayed)
    expect(holdsFor(form.detector)).toBe(true)
    expect(maxSteps(form.detector)).toBe(4)
  })
})

describe('unit storage', () => {
  function sustained(path: string, value: string, hysteresis = ''): RuleForm {
    return authored((f) => {
      f.name = 'r'
      f.slug = 'r'
      f.message = 'm'
      f.steps[0].priority = 'warning'
      f.signal.slots[0].path = path
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.steps[0].limit = value
      f.detector.hysteresis = hysteresis
    })
  }

  it('stores 11.8 V as 11.8', () => {
    const rule = saved(sustained('electrical.batteries.house.voltage', '11.8'))
    expect(rule.detector).toMatchObject({ steps: [{ limit: 11.8, priority: 'warning' }] })
  })

  it('stores 95 °C as 368.15 K and a 2 °C hysteresis as 2 K', () => {
    const rule = saved(sustained('propulsion.port.coolantTemperature', '95', '2'))
    expect(rule.detector).toMatchObject({ steps: [{ limit: 368.15 }], hysteresis: 2 })
  })

  it('stores a 0.5 °C/min slope as the equivalent K/s', () => {
    const rule = saved(
      authored((f) => {
        Object.assign(f, { name: 'r', slug: 'r', message: 'm' })
        f.steps[0].priority = 'warning'
        f.signal.slots[0].path = 'propulsion.port.coolantTemperature'
        f.detector.type = 'slope'
        f.detector.trend = 'rising'
        f.steps[0].limit = '0.5'
        f.detector.window = { amount: '5', unit: 'min' }
      })
    )
    expect(rule.detector).toEqual({
      type: 'slope',
      direction: 'rising',
      window: 300,
      steps: [{ limit: expect.closeTo(0.5 / 60, 15) as number, priority: 'warning' }]
    })
  })

  it('stores a ratio slope of 0.6 /min as 0.01 per second, and shows it back per minute', () => {
    const form = authored((f) => {
      Object.assign(f, { name: 'r', slug: 'r', message: 'm' })
      f.steps[0].priority = 'warning'
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'ratio')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
      f.signal.slots[1].path = 'propulsion.starboard.revolutions'
      f.detector.type = 'slope'
      f.detector.trend = 'rising'
      f.steps[0].limit = '0.6'
      f.detector.window = { amount: '1', unit: 'min' }
    })
    const rule = saved(form)
    expect(rule.detector).toMatchObject({ steps: [{ limit: 0.01 }] })
    expect(fromRule(rule, displayed).steps[0].limit).toBe('0.6')
  })

  describe('an accumulator on coolant temperature', () => {
    const accumulator = (edit: (f: RuleForm) => void) =>
      authored((f) => {
        Object.assign(f, { name: 'r', slug: 'r', message: 'm' })
        f.steps[0].priority = 'warning'
        f.signal.slots[0].path = 'propulsion.port.coolantTemperature'
        f.detector.type = 'accumulator'
        f.detector.measure = 'integral'
        f.steps[0].limit = '10'
        edit(f)
      })

    it('stores an integral limit of 10 °C·s as 10 K·s, without the offset', () => {
      const rule = saved(accumulator(() => undefined))
      expect(rule.detector).toMatchObject({ steps: [{ limit: 10 }] })
      expect(fromRule(rule, displayed).steps[0].limit).toBe('10')
    })

    it('stores a reset on reaching 20 °C as 293.15 K', () => {
      const rule = saved(
        accumulator((f) => {
          f.detector.useResetOn = true
          f.detector.resetOn = { op: 'changesTo', value: { type: 'number', text: '20' } }
        })
      )
      expect(rule.detector).toMatchObject({ resetOn: { op: 'changesTo', value: 293.15 } })
      expect(fromRule(rule, displayed).detector.resetOn).toEqual({
        op: 'changesTo',
        value: { type: 'number', text: '20' }
      })
    })

    it('stores a reset on any change without a value', () => {
      const rule = saved(
        accumulator((f) => {
          f.detector.useResetOn = true
          f.detector.resetOn = { op: 'changes', value: { type: 'number', text: '20' } }
        })
      )
      expect((rule.detector as { resetOn: unknown }).resetOn).toEqual({ op: 'changes' })
    })
  })

  it("stores a zone limit on another path with that path, and on the input's own without one", () => {
    const zone = (path: string) =>
      authored((f) => {
        Object.assign(f, { name: 'r', slug: 'r', message: 'm' })
        f.signal.slots[0].path = 'electrical.batteries.house.voltage'
        f.detector.type = 'sustained'
        f.detector.direction = 'below'
        f.detector.limit = { kind: 'zone', value: '', level: 'warn', path }
      })
    const other = saved(zone('electrical.batteries.start.voltage'))
    expect(other.detector).toMatchObject({
      limit: { kind: 'zone', level: 'warn', path: 'electrical.batteries.start.voltage' }
    })
    expect(fromRule(other, displayed).detector.limit.path).toBe(
      'electrical.batteries.start.voltage'
    )
    expect((saved(zone('')).detector as { limit: object }).limit).toEqual({
      kind: 'zone',
      level: 'warn'
    })
  })

  it('gives back a stored value the user did not change, though its display is rounded', () => {
    const rule: Rule = {
      name: 'r',
      slug: 'r',
      message: 'm',
      signal: { path: 'navigation.headingMagnetic' },
      detector: {
        type: 'sustained',
        direction: 'above',
        steps: [{ limit: 0.1, priority: 'caution' }]
      }
    }
    const form = fromRule(rule, displayed)
    expect(form.steps[0].limit).toBe('5.73')
    expect(saved(form)).toEqual(rule)
    form.steps[0].limit = '6'
    expect(firstLimit(saved(form))).toBeCloseTo(0.10472, 5)
  })

  it('shows a stored limit in the display unit', () => {
    const rule = saved(sustained('environment.outside.temperature', '212'))
    expect(rule.detector).toMatchObject({ steps: [{ limit: 373.15 }] })
    expect(fromRule(rule, displayed).steps[0].limit).toBe('212')
  })

  it('shows durations in the largest whole unit', () => {
    const form = fromRule(example('engine-service-due'), displayed)
    expect(form.steps[0].duration).toEqual({ amount: '250', unit: 'h' })
  })
})

describe('authoring the worked scenarios', () => {
  it('authors the twin-engine RPM difference with two slots and gates', () => {
    const form = authored((f) => {
      f.name = 'Engine RPM mismatch'
      f.slug = slugify(f.name)
      f.condition = 'revolutionsMismatch'
      f.message = 'Port and starboard engine speeds differ'
      f.steps[0].priority = 'caution'
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'absDifference')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
      f.signal.slots[1].path = 'propulsion.starboard.revolutions'
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.steps[0].limit = '180'
      f.detector.duration = { amount: '30', unit: 's' }
    })
    const rule = saved(form)
    expect(rule.signal).toEqual({
      combinator: 'absDifference',
      inputs: [
        { path: 'propulsion.port.revolutions' },
        { path: 'propulsion.starboard.revolutions' }
      ]
    })
    expect(rule.detector).toMatchObject({
      steps: [{ limit: 3, priority: 'caution' }],
      duration: 30
    })
    expect(validateRule(rule).ok).toBe(true)
  })

  it('authors the three-GNSS spread with source-restricted slots, in the distance unit', () => {
    const form = authored((f) => {
      Object.assign(f, {
        name: 'GNSS',
        slug: 'gnss',
        condition: 'gnssDisagree',
        message: 'm'
      })
      f.steps[0].priority = 'warning'
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'positionSpread')
      f.signal.slots = ['gnss.bow', 'gnss.stern', 'gnss.mast'].map((source) => ({
        path: 'navigation.position',
        source
      }))
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.steps[0].limit = '0.027'
    })
    const rule = saved(form)
    expect(rule.signal).toMatchObject({
      combinator: 'positionSpread',
      inputs: [
        { path: 'navigation.position', source: 'gnss.bow' },
        { path: 'navigation.position', source: 'gnss.stern' },
        { path: 'navigation.position', source: 'gnss.mast' }
      ]
    })
    expect(firstLimit(rule)).toBeCloseTo(50.004, 3)
    expect(validateRule(rule).ok).toBe(true)
  })

  it('authors a wildcard battery rule with an {instance} message and a zone limit', () => {
    const rule = saved(
      authored((f) => {
        Object.assign(f, { name: 'Battery low', slug: 'battery-low' })
        f.message = 'Battery {instance} low'
        f.steps[0].priority = 'alarm'
        f.signal.slots[0].path = 'electrical.batteries.*.voltage'
        f.detector.type = 'sustained'
        f.detector.direction = 'below'
        f.detector.limit.kind = 'zone'
        f.detector.limit.level = 'warn'
      })
    )
    expect(rule.detector).not.toHaveProperty('steps')
    expect(rule.signal).toEqual({ path: 'electrical.batteries.*.voltage' })
    expect(validateRule(rule).ok).toBe(true)
  })
})

describe('combinator slots', () => {
  it('sets two slots for a two-input kind and at least two otherwise', () => {
    let signal = setMode(emptyForm().signal, 'combine')
    expect(signal.slots).toHaveLength(2)
    signal = setCombinator(
      { ...signal, slots: [...signal.slots, { path: 'c', source: '' }] },
      'ratio'
    )
    expect(signal.slots).toHaveLength(2)
    signal = setCombinator(signal, 'spread')
    expect(signal.slots).toHaveLength(2)
  })

  it('keeps the first slot when switching back to a single path', () => {
    const signal = setMode(emptyForm().signal, 'combine')
    signal.slots[0].path = 'a.b'
    expect(setMode(signal, 'single').slots).toEqual([{ path: 'a.b', source: '' }])
  })

  it('rejects combining inputs whose units differ', () => {
    const form = authored((f) => {
      Object.assign(f, { name: 'x', slug: 'x', message: 'm' })
      f.steps[0].priority = 'warning'
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'difference')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
      f.signal.slots[1].path = 'electrical.batteries.house.voltage'
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.steps[0].limit = '1'
    })
    const result = toRule(form, displayed)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors).toEqual([
      { path: '/signal/inputs/1/path', message: 'is in V, the other inputs in Hz' }
    ])
  })
})

describe('a stored rule that does not validate', () => {
  it('opens as stored when its shape is a rule, so it saves unchanged once fixed', () => {
    const rule = example('house-battery-low')
    expect(saved(bodyForm(rule, NO_UNITS), NO_UNITS)).toEqual(rule)
  })

  it('keeps what it can read of a body that is not a rule', () => {
    const form = bodyForm({ name: 'Coolant high', slug: 'coolant-high', detector: 7 }, NO_UNITS)
    expect(form).toMatchObject({ name: 'Coolant high', slug: 'coolant-high', nameFollows: false })
    expect(form.detector.type).toBe('')
    expect(bodyForm('junk', NO_UNITS).name).toBe('')
  })

  it('opens a rule-shaped body missing its texts with them empty, to be filled in', () => {
    const { name: _name, message: _message, ...body } = example('house-battery-low')
    const form = bodyForm(body, NO_UNITS)
    expect(form).toMatchObject({ name: '', message: '', condition: '' })
    const result = toRule(form, NO_UNITS)
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual(['/name', '/message'])
  })

  it('keeps the signal and gates of a body without a detector, asking only for its kind', () => {
    const { detector: _detector, ...body } = example('coolant-temperature-rising')
    const form = bodyForm(body, NO_UNITS)
    expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
    expect(form.gates).toHaveLength(1)
    expect(form.detector.type).toBe('')
    const result = toRule(form, NO_UNITS)
    expect(!result.ok && result.errors).toEqual([
      { path: '/detector/type', message: 'is required' }
    ])
  })

  it.each([null, [], 'sustained'])(
    'keeps the signal of a body whose detector is %j',
    (detector) => {
      const form = bodyForm({ ...example('coolant-temperature-rising'), detector }, NO_UNITS)
      expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
      expect(form.detector.type).toBe('')
    }
  )

  const pointers = (form: RuleForm) => {
    const result = toRule(form, NO_UNITS)
    return result.ok ? [] : result.errors.map((e) => e.path)
  }

  it('keeps the detector and gates of a body without a signal, asking for its path and limit', () => {
    const { signal: _signal, ...body } = example('coolant-temperature-rising')
    const form = bodyForm(body, NO_UNITS)
    expect(form.detector).toMatchObject({ type: 'slope', trend: 'rising' })
    expect(form.steps[0]).toMatchObject({ priority: 'warning', limit: '' })
    expect(form.gates[0]?.signal.slots[0]?.path).toBe('propulsion.*.revolutions')
    expect(pointers(form)).toEqual(['/signal/path', '/detector/steps/0/limit'])
  })

  const bilge = example('bilge-pump-cycling')
  const { event: _event, ...countDetector } = bilge.detector as Extract<
    Rule['detector'],
    { type: 'count' }
  >
  it.each([
    ['count', countDetector],
    ['absence', { type: 'absence', steps: [{ within: 60, priority: 'warning' }] }]
  ])(
    'keeps the rest of a body whose %s detector has no event, asking only for it',
    (type, detector) => {
      const form = bodyForm({ ...bilge, detector }, NO_UNITS)
      expect(form.signal.slots[0]?.path).toBe('electrical.switches.bilgePump.state')
      expect(form.detector.type).toBe(type)
      expect(form.steps[0]?.priority).toBe('warning')
      expect(form.detector.event.op).toBe('')
      expect(pointers(form)).toEqual(['/detector/event/op'])
    }
  )

  it.each([{}, { value: true }, { op: 'nonsense' }])(
    'asks for the event of a body whose event is %j',
    (event) => {
      const form = bodyForm({ ...bilge, detector: { ...countDetector, event } }, NO_UNITS)
      expect(form.detector.event.op).toBe('')
      expect(pointers(form)).toEqual(['/detector/event/op'])
    }
  )

  describe('a direction missing or unknown', () => {
    const without = (slug: string, direction?: string) => {
      const rule = example(slug)
      const { direction: _direction, ...detector } = rule.detector as Extract<
        Rule['detector'],
        { direction: string }
      >
      return bodyForm(
        { ...rule, detector: direction === undefined ? detector : { ...detector, direction } },
        NO_UNITS
      )
    }

    it.each([undefined, 'sideways'])(
      'keeps the rest of a sustained detector whose direction is %s, asking only for it',
      (direction) => {
        const form = without('house-battery-low', direction)
        expect(form.signal.slots[0]?.path).toBe('electrical.batteries.house.voltage')
        expect(form.detector).toMatchObject({
          type: 'sustained',
          direction: '',
          limit: { kind: 'zone', level: 'warn' },
          duration: { amount: '1', unit: 'min' }
        })
        expect(pointers(form)).toEqual(['/detector/direction'])
      }
    )

    it.each([
      ['slope', 'coolant-temperature-rising', 'propulsion.*.coolantTemperature'],
      ['projection', 'fresh-water-running-out', 'tanks.freshWater.0.currentLevel']
    ])(
      'keeps the rest of a %s detector without a direction, asking only for it',
      (type, slug, path) => {
        const rule = example(slug)
        const form = without(slug)
        expect(form.signal.slots[0]?.path).toBe(path)
        expect(form.detector).toMatchObject({ type, trend: '' })
        expect(form.steps[0]?.priority).toBe(rule.detector.steps?.[0]?.priority)
        expect(form.gates).toHaveLength(rule.gates?.length ?? 0)
        expect(pointers(form)).toEqual(['/detector/direction'])
      }
    )

    it.each([undefined, 'x'])(
      'keeps the rest of a gate whose direction is %s, asking only for it',
      (direction) => {
        const rule = example('coolant-temperature-rising')
        const { direction: _direction, ...gate } = { ...rule.gates?.[0] }
        const form = bodyForm(
          { ...rule, gates: [direction === undefined ? gate : { ...gate, direction }] },
          NO_UNITS
        )
        expect(form.detector).toMatchObject({ type: 'slope', trend: 'rising' })
        expect(form.gates[0]).toMatchObject({
          signal: { slots: [{ path: 'propulsion.*.revolutions' }] },
          direction: '',
          limit: { kind: 'fixed', value: '5' }
        })
        expect(pointers(form)).toEqual(['/gates/0/direction'])
      }
    )

    it('gives a new gate a direction', () => {
      expect(emptyGate().direction).toBe('above')
    })
  })

  describe('another choice missing or unknown', () => {
    type Body = Record<string, unknown> & { detector: Record<string, unknown> }
    const body = (slug: string) => example(slug) as unknown as Body
    it.each<[string, () => Body, (form: RuleForm) => unknown, string]>([
      [
        'the state of a match',
        () => {
          const b = body('engine-stopped')
          return { ...b, detector: { ...b.detector, op: 'sometimes' } }
        },
        (form) => form.detector.matchOp,
        '/detector/op'
      ],
      [
        'what to total',
        () => {
          const { measure: _measure, ...detector } = body('engine-service-due').detector
          return { ...body('engine-service-due'), detector }
        },
        (form) => form.detector.measure,
        '/detector/measure'
      ],
      [
        'what to total while',
        () => {
          const b = body('engine-service-due')
          return { ...b, detector: { ...b.detector, while: { value: 0 } } }
        },
        (form) => form.detector.whileOp,
        '/detector/while/op'
      ],
      [
        'the zone level',
        () => {
          const b = body('house-battery-low')
          return { ...b, detector: { ...b.detector, limit: { kind: 'zone' } } }
        },
        (form) => form.detector.limit.level,
        '/detector/limit/level'
      ],
      [
        'the zone level of a gate',
        () => {
          const b = body('coolant-temperature-rising')
          const [gate] = example('coolant-temperature-rising').gates ?? []
          return { ...b, gates: [{ ...gate, limit: { kind: 'zone', level: 'loud' } }] }
        },
        (form) => form.gates[0]?.limit.level,
        '/gates/0/limit/level'
      ],
      [
        'the priority of a step',
        () => {
          const b = body('coolant-temperature-rising')
          return { ...b, detector: { ...b.detector, steps: [{ limit: 0.02, priority: 'urgent' }] } }
        },
        (form) => form.steps[0]?.priority,
        '/detector/steps/0/priority'
      ]
    ])('reads %s as unchosen, asking only for it', (_name, stored, field, pointer) => {
      const b = stored()
      const form = bodyForm(b, NO_UNITS)
      expect(form.signal.slots[0]?.path).toBe((b.signal as { path: string }).path)
      expect(form.detector.type).toBe(b.detector.type)
      expect(field(form)).toBe('')
      expect(pointers(form)).toEqual([pointer])
    })
  })

  it('asks for the path and limit of a body whose signal has no path', () => {
    const form = bodyForm({ ...example('coolant-temperature-rising'), signal: {} }, NO_UNITS)
    expect(form.signal.slots[0]?.path).toBe('')
    expect(pointers(form)).toEqual(['/signal/path', '/detector/steps/0/limit'])
  })

  it.each(['many', { first: 1 }, [null]])(
    'keeps the rest of a body whose steps are %j, asking only for a step',
    (steps) => {
      const rule = example('coolant-temperature-rising')
      const form = bodyForm({ ...rule, detector: { ...rule.detector, steps } }, NO_UNITS)
      expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
      expect(form.detector).toMatchObject({ type: 'slope', window: { amount: '5', unit: 'min' } })
      expect(form.gates).toHaveLength(1)
      expect(form.steps).toEqual([emptyStep()])
      expect(pointers(form)).toEqual(['/detector/steps/0/limit', '/detector/steps/0/priority'])
    }
  )

  const noPath = ['/signal/inputs/0/path', '/signal/inputs/1/path', '/detector/steps/0/limit']
  it.each([
    { inputs: undefined, missing: noPath },
    { inputs: 'a.b', missing: noPath },
    // a.b has no known unit, and the empty input may yet get a path that has one.
    {
      inputs: [null, { path: 'a.b' }],
      missing: ['/signal/inputs/0/path', '/detector/steps/0/limit']
    }
  ])(
    'keeps the rest of a body whose combined signal has inputs $inputs, asking for each path',
    ({ inputs, missing }) => {
      const rule = example('coolant-temperature-rising')
      const form = bodyForm({ ...rule, signal: { combinator: 'difference', inputs } }, NO_UNITS)
      expect(form.signal.mode).toBe('combine')
      expect(form.detector.type).toBe('slope')
      expect(form.gates).toHaveLength(1)
      expect(pointers(form)).toEqual(missing)
    }
  )

  it('keeps the rest of a body whose gate has a combined signal without inputs', () => {
    const rule = example('coolant-temperature-rising')
    const gate = { ...rule.gates?.[0], signal: { combinator: 'difference' } }
    const form = bodyForm({ ...rule, gates: [gate] }, NO_UNITS)
    expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
    expect(form.gates[0]?.limit.value).toBe('')
    expect(pointers(form)).toEqual([
      '/gates/0/signal/inputs/0/path',
      '/gates/0/signal/inputs/1/path',
      '/gates/0/limit/value'
    ])
  })

  describe('a malformed gate', () => {
    const rule = example('coolant-temperature-rising')
    const gate = rule.gates?.[0]
    const withGates = (gates: unknown) => bodyForm({ ...rule, gates }, NO_UNITS)
    const gateToFill = ['/gates/0/signal/path', '/gates/0/direction', '/gates/0/limit/value']

    it('keeps the rest of a gate without a signal, asking for its path and limit', () => {
      const form = withGates([{ ...gate, signal: undefined }])
      expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
      expect(form.detector.type).toBe('slope')
      expect(form.gates[0]).toMatchObject({ direction: 'above', limit: { value: '' } })
      expect(pointers(form)).toEqual(['/gates/0/signal/path', '/gates/0/limit/value'])
    })

    it('keeps the signal of a gate without a limit, asking only for it', () => {
      const form = withGates([{ ...gate, limit: undefined }])
      expect(form.gates[0]?.signal.slots[0]?.path).toBe('propulsion.*.revolutions')
      expect(pointers(form)).toEqual(['/gates/0/limit/value'])
    })

    it('reads a gate that is not an object as one to fill in', () => {
      const form = withGates([null])
      expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
      expect(form.gates).toEqual([{ ...emptyGate(), direction: '' }])
      expect(pointers(form)).toEqual(gateToFill)
    })

    it('reads a lone gate as a list of one', () => {
      const form = withGates(gate)
      expect(form.gates[0]?.signal.slots[0]?.path).toBe('propulsion.*.revolutions')
      expect(pointers(form)).toEqual([])
    })

    it('asks to fill in gates that are an object but not a gate, rather than drop them', () => {
      const form = withGates({ first: gate })
      expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
      expect(form.gates).toHaveLength(1)
      expect(pointers(form)).toEqual(gateToFill)
    })

    it('asks to fill in gates that are neither a list nor an object, rather than drop them', () => {
      const form = withGates('many')
      expect(form.signal.slots[0]?.path).toBe('propulsion.*.coolantTemperature')
      expect(form.gates).toEqual([{ ...emptyGate(), direction: '' }])
      expect(pointers(form)).toEqual(gateToFill)
    })
  })

  describe('the numbers of a signal without a path', () => {
    const withoutSignal = (slug: string, signal?: unknown) =>
      bodyForm({ ...example(slug), signal }, displayed)

    it('asks again for a step limit rather than read it in the unit of the path picked later', () => {
      // 3 Hz is 180 rpm: shown as 3 before a path is picked, it would save as 3 rpm.
      const form = withoutSignal('engine-rpm-mismatch', { combinator: 'absDifference' })
      const picked: RuleForm = {
        ...form,
        signal: {
          ...form.signal,
          slots: [
            { path: 'propulsion.port.revolutions', source: '' },
            { path: 'propulsion.starboard.revolutions', source: '' }
          ]
        }
      }
      const result = toRule(picked, displayed)
      expect(!result.ok && result.errors).toEqual([
        { path: '/detector/steps/0/limit', message: 'is required' }
      ])
    })

    it('drops the range and hysteresis, keeping the duration', () => {
      const form = withoutSignal('shore-power-frequency')
      expect(form.steps.map((s) => [s.low, s.high, s.priority])).toEqual([
        ['', '', 'warning'],
        ['', '', 'alarm']
      ])
      expect(form.detector).toMatchObject({
        hysteresis: '',
        duration: { amount: '10', unit: 's' }
      })
    })

    it('drops a number to total while, keeping a limit in time', () => {
      const form = withoutSignal('engine-service-due')
      expect(form.detector.whileValue).toMatchObject({ type: 'number', text: '' })
      expect(form.steps[0]?.duration).toEqual({ amount: '250', unit: 'h' })
    })

    it('keeps a value that is not a number', () => {
      expect(withoutSignal('engine-stopped').steps[0]?.value).toEqual({
        type: 'text',
        text: 'stopped'
      })
    })

    it('asks again for the limit of a combination whose only path has no known unit', () => {
      // The empty input may yet be given a path the server shows in rpm.
      const starboardOnly = unitLookup(
        shown.filter((p) => p.path === 'propulsion.starboard.revolutions'),
        displayed.distance
      )
      const rule = example('engine-rpm-mismatch')
      const form = bodyForm(
        {
          ...rule,
          signal: {
            combinator: 'absDifference',
            inputs: [{ path: 'propulsion.port.revolutions' }, {}]
          }
        },
        starboardOnly
      )
      expect(form.steps[0]?.limit).toBe('')
    })

    it('asks again for the limit of a combination stored without inputs', () => {
      const form = withoutSignal('engine-rpm-mismatch', { combinator: 'absDifference', inputs: [] })
      expect(form.steps[0]?.limit).toBe('')
    })

    it('keeps the limit of a combination whose every input has a path of unknown unit', () => {
      const form = bodyForm(example('engine-rpm-mismatch'), NO_UNITS)
      expect(form.steps[0]?.limit).toBe('3')
    })

    it('keeps the limit of a combination one of whose paths has a known unit', () => {
      const rule = example('engine-rpm-mismatch')
      const form = bodyForm(
        {
          ...rule,
          signal: {
            combinator: 'absDifference',
            inputs: [{ path: 'propulsion.port.revolutions' }, {}]
          }
        },
        displayed
      )
      expect(form.steps[0]?.limit).toBe('180')
    })

    it('keeps the limit of a combination whose unit does not come from its paths', () => {
      const form = withoutSignal('gnss-disagree', { combinator: 'positionSpread' })
      expect(form.steps[0]?.limit).not.toBe('')
    })

    it('drops the limit of a gate without a signal, keeping its duration', () => {
      const rule = example('engine-rpm-mismatch')
      const [gate, other] = rule.gates ?? []
      const form = bodyForm({ ...rule, gates: [{ ...gate, signal: undefined }, other] }, displayed)
      expect(form.gates[0]).toMatchObject({
        limit: { value: '' },
        duration: { amount: '10', unit: 's' }
      })
      expect(form.gates[1]?.limit.value).toBe('480')
    })
  })

  describe('the numbers it leaves empty for want of a unit', () => {
    const rule = example('engine-rpm-mismatch')
    const [gate, other] = rule.gates ?? []

    it('names each at its field, a hysteresis as one to type again', () => {
      const { signal: _signal, ...body } = rule
      const { emptied } = fromBody(
        {
          ...body,
          detector: { ...rule.detector, hysteresis: 1 },
          gates: [{ ...gate, signal: undefined }, other]
        },
        displayed
      )
      const retype = 'must be typed again in the unit of the chosen path'
      expect(emptied).toEqual([
        { path: '/detector/hysteresis', message: retype },
        { path: '/detector/steps/0/limit', message: 'is required' },
        { path: '/gates/0/limit/value', message: 'is required' }
      ])
    })

    it('names none when every unit is settled', () => {
      expect(
        fromBody({ ...rule, detector: { ...rule.detector, hysteresis: 1 } }, displayed).emptied
      ).toEqual([])
    })
  })

  it('asks for the kind of a detector it does not know', () => {
    const rule = example('house-battery-low')
    const form = bodyForm({ ...rule, detector: { type: 'nonsense' } }, NO_UNITS)
    const result = toRule(form, NO_UNITS)
    expect(!result.ok && result.errors).toEqual([
      { path: '/detector/type', message: 'is required' }
    ])
  })
})

describe('local checks', () => {
  it('names each missing or malformed field by its pointer', () => {
    const form = authored((f) => {
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.steps[0].limit = 'abc'
    })
    const result = toRule(form, NO_UNITS)
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      '/name',
      '/slug',
      '/message',
      '/signal/path',
      '/detector/steps/0/limit',
      '/detector/steps/0/priority'
    ])
  })

  it('drops latching once the detector can no longer latch', () => {
    const form = fromRule(example('engine-stopped'), NO_UNITS)
    form.detector.matchOp = 'equals'
    expect(saved(form, NO_UNITS).latching).toBeUndefined()
  })
})

describe('a converted value shown rounded', () => {
  /** Degrees per radian, as the heading's display unit converts. */
  const DEGREES = 57.29577951308232
  const heading = (detector: Partial<Detector>, gates?: Rule['gates']): Rule => ({
    name: 'r',
    slug: 'r',
    message: 'm',
    signal: { path: 'navigation.headingMagnetic' },
    detector: {
      type: 'sustained',
      direction: 'above',
      steps: [{ limit: 0.1, priority: 'caution' }],
      ...detector
    } as Detector,
    ...(gates === undefined ? {} : { gates })
  })

  /** The form after the user has edited it through the editor, which forgets what they changed. */
  const edit = (form: RuleForm, change: (f: RuleForm) => void): RuleForm => {
    const next = structuredClone(form)
    change(next)
    return forgetEdited(next)
  }

  it("shows the worked examples' limits to the precision the panel shows values in", () => {
    expect(fromRule(example('gnss-disagree'), displayed).steps[0].limit).toBe('0.027')
    expect(fromRule(example('compasses-disagree'), displayed).steps[0].limit).toBe('5.73')
  })

  it('stores the exact value of a limit the user did not touch', () => {
    for (const slug of ['gnss-disagree', 'compasses-disagree']) {
      const form = edit(fromRule(example(slug), displayed), (f) => {
        f.message = 'Edited'
      })
      expect(saved(form)).toEqual({ ...example(slug), message: 'Edited' })
    }
  })

  it('converts the rounded value when the user types it into that field', () => {
    let form = fromRule(example('gnss-disagree'), displayed)
    form = edit(form, (f) => {
      f.steps[0].limit = '0.02'
    })
    form = edit(form, (f) => {
      f.steps[0].limit = '0.027'
    })
    expect(firstLimit(saved(form))).toBeCloseTo(50.004, 3)
    expect(firstLimit(saved(form))).not.toBe(50)
  })

  it('converts the same rounded text typed into another field', () => {
    const form = edit(fromRule(heading({}), displayed), (f) => {
      f.steps.push({ ...emptyStep('warning'), limit: '5.73' })
    })
    const steps = saved(form).detector.steps as { limit: number }[]
    expect(steps[0].limit).toBe(0.1)
    expect(steps[1].limit).toBeCloseTo(0.100007, 6)
    expect(steps[1].limit).not.toBe(0.1)
  })

  it('keeps the exact value of a step that moves when an earlier one is removed', () => {
    const rule = heading({
      steps: [
        { limit: 0.1, priority: 'caution' },
        { limit: 0.2, priority: 'warning' }
      ]
    })
    const form = edit(fromRule(rule, displayed), (f) => {
      f.steps = f.steps.slice(1)
    })
    expect(form.steps[0].limit).toBe('11.46')
    expect(saved(form).detector.steps).toEqual([{ limit: 0.2, priority: 'warning' }])
  })

  it('rounds and keeps a hysteresis, a slope and a gate limit', () => {
    const rule = heading({ hysteresis: 0.01 }, [
      {
        signal: { path: 'navigation.headingMagnetic' },
        direction: 'above',
        limit: { kind: 'fixed', value: 0.3 }
      }
    ])
    const form = fromRule(rule, displayed)
    expect(form.detector.hysteresis).toBe('0.573')
    expect(form.gates[0].limit.value).toBe('17.19')
    expect(saved(form)).toEqual(rule)

    const slope = heading({
      type: 'slope',
      direction: 'rising',
      window: 60,
      steps: [{ limit: 0.001, priority: 'caution' }]
    })
    const sloped = fromRule(slope, displayed)
    expect(sloped.steps[0].limit).toBe('3.438')
    expect(saved(sloped)).toEqual(slope)
  })

  it('shows a value in its SI unit unrounded', () => {
    const rule: Rule = {
      ...heading({ steps: [{ limit: 13.125, priority: 'caution' }] }),
      signal: { path: 'electrical.batteries.house.voltage' }
    }
    expect(fromRule(rule, displayed).steps[0].limit).toBe('13.125')
    const si = fromRule(heading({ steps: [{ limit: 0.123456, priority: 'caution' }] }), NO_UNITS)
    expect(si.steps[0].limit).toBe('0.123456')
  })

  it('converts the shown text once the field shows another unit', () => {
    const form = edit(fromRule(example('compasses-disagree'), displayed), (f) => {
      f.signal = setCombinator({ ...f.signal, angular: false }, 'ratio')
    })
    expect(form.steps[0].limit).toBe('5.73')
    expect(firstLimit(saved(form))).toBeCloseTo(5.73, 12)
  })

  it('keeps the exact value of the other bound when one bound is edited', () => {
    const rule = heading({
      type: 'outside',
      steps: [{ low: 0.1, high: 0.2, priority: 'caution' }]
    })
    const form = edit(fromRule(rule, displayed), (f) => {
      f.steps[0].low = '6'
    })
    expect(form.steps[0].high).toBe('11.46')
    const step = saved(form).detector.steps?.[0] as { low: number; high: number }
    expect(step.low).toBeCloseTo(6 / DEGREES, 12)
    expect(step.high).toBe(0.2)
  })

  describe('converts the shown text typed back into a field the user edited', () => {
    const gated: Rule['gates'] = [
      {
        signal: { path: 'navigation.headingMagnetic' },
        direction: 'above',
        limit: { kind: 'fixed', value: 0.1 }
      }
    ]
    type AccumulatorDetector = Extract<Detector, { type: 'accumulator' }>
    const accumulator = (extra: Pick<AccumulatorDetector, 'while' | 'resetOn'>) =>
      heading({
        type: 'accumulator',
        measure: 'time',
        steps: [{ limit: 600, priority: 'caution' }],
        ...extra
      })
    const counted = heading({
      type: 'count',
      event: { op: 'changesTo', value: 0.1 },
      window: 600,
      steps: [{ limit: 3, priority: 'caution' }]
    })
    const outside = heading({
      type: 'outside',
      steps: [{ low: 0.1, high: 0.2, priority: 'caution' }]
    })
    const step = (rule: Rule) => rule.detector.steps?.[0] as Record<string, unknown>
    const detector = (rule: Rule) => rule.detector as Record<string, unknown>
    const gate = (rule: Rule) => {
      const first = rule.gates?.at(0)
      if (first === undefined) throw new Error('no gate')
      return first
    }

    interface Holder {
      field: string
      rule: Rule
      text: (form: RuleForm) => string
      type: (form: RuleForm, text: string) => void
      stored: (rule: Rule) => unknown
    }
    const holders: Holder[] = [
      {
        field: 'step limit',
        rule: heading({}),
        text: (f) => f.steps[0].limit,
        type: (f, t) => {
          f.steps[0].limit = t
        },
        stored: (r) => step(r).limit
      },
      {
        field: 'step low',
        rule: outside,
        text: (f) => f.steps[0].low,
        type: (f, t) => {
          f.steps[0].low = t
        },
        stored: (r) => step(r).low
      },
      {
        field: 'step high',
        rule: heading({
          type: 'outside',
          steps: [{ low: 0.05, high: 0.1, priority: 'caution' }]
        }),
        text: (f) => f.steps[0].high,
        type: (f, t) => {
          f.steps[0].high = t
        },
        stored: (r) => step(r).high
      },
      {
        field: 'step value',
        rule: heading({
          type: 'match',
          op: 'equals',
          steps: [{ value: 0.1, priority: 'caution' }]
        }),
        text: (f) => f.steps[0].value.text,
        type: (f, t) => {
          f.steps[0].value.text = t
        },
        stored: (r) => step(r).value
      },
      {
        field: 'hysteresis',
        rule: heading({ hysteresis: 0.1 }),
        text: (f) => f.detector.hysteresis,
        type: (f, t) => {
          f.detector.hysteresis = t
        },
        stored: (r) => detector(r).hysteresis
      },
      {
        field: 'while value',
        rule: accumulator({ while: { op: 'above', value: 0.1 } }),
        text: (f) => f.detector.whileValue.text,
        type: (f, t) => {
          f.detector.whileValue.text = t
        },
        stored: (r) => (r.detector as { while: { value: number } }).while.value
      },
      {
        field: 'reset value',
        rule: accumulator({ resetOn: { op: 'changesTo', value: 0.1 } }),
        text: (f) => f.detector.resetOn.value.text,
        type: (f, t) => {
          f.detector.resetOn.value.text = t
        },
        stored: (r) => (r.detector as { resetOn: Event }).resetOn.value
      },
      {
        field: 'event value',
        rule: counted,
        text: (f) => f.detector.event.value.text,
        type: (f, t) => {
          f.detector.event.value.text = t
        },
        stored: (r) => (r.detector as { event: Event }).event.value
      },
      {
        field: 'gate limit',
        rule: heading({}, gated),
        text: (f) => f.gates[0].limit.value,
        type: (f, t) => {
          f.gates[0].limit.value = t
        },
        stored: (r) => (gate(r).limit as { value: number }).value
      }
    ]

    it.each(holders)('$field', ({ rule, text, type, stored }) => {
      let form = fromRule(rule, displayed)
      const shownText = text(form)
      expect(shownText).toBe('5.73')
      expect(stored(saved(form))).toBe(0.1)
      form = edit(form, (f) => {
        type(f, '7')
      })
      form = edit(form, (f) => {
        type(f, shownText)
      })
      expect(stored(saved(form))).toBeCloseTo(5.73 / DEGREES, 12)
      expect(stored(saved(form))).not.toBe(0.1)
    })
  })
})

describe('withNumbersInUnit', () => {
  const RPM = 'propulsion.port.revolutions'
  const TEMPERATURE = 'propulsion.port.coolantTemperature'
  const gate = {
    signal: { path: RPM },
    direction: 'above',
    limit: { kind: 'fixed', value: 10 }
  }
  const priority = 'warning'
  // Every number of each detector typed in its signal's unit, filled; a fixed detector limit is
  // read from a stored body that does not validate.
  const detectors: [string, Record<string, unknown>][] = [
    ['match', { type: 'match', op: 'equals', steps: [{ value: 3, priority }] }],
    [
      'sustained',
      {
        type: 'sustained',
        direction: 'above',
        limit: { kind: 'fixed', value: 5 },
        steps: [
          { limit: 3, priority },
          { limit: 4, priority: 'alarm' }
        ],
        hysteresis: 1
      }
    ],
    ['outside', { type: 'outside', steps: [{ low: 1, high: 2, priority }], hysteresis: 1 }],
    ['slope', { type: 'slope', direction: 'rising', window: 60, steps: [{ limit: 1, priority }] }],
    [
      'projection',
      {
        type: 'projection',
        direction: 'rising',
        limit: { kind: 'fixed', value: 5 },
        window: 60,
        horizon: 600
      }
    ],
    [
      'accumulator',
      {
        type: 'accumulator',
        measure: 'integral',
        while: { op: 'above', value: 2 },
        resetOn: { op: 'changesTo', value: 0 },
        steps: [{ limit: 100, priority }]
      }
    ],
    [
      'count',
      {
        type: 'count',
        event: { op: 'changesTo', value: 1 },
        window: 60,
        steps: [{ limit: 3, priority }]
      }
    ],
    ['absence', { type: 'absence', event: { op: 'changesTo', value: 1 }, steps: [{ within: 60 }] }]
  ]
  const byPath = (errors: readonly { path: string; message: string }[]) =>
    [...errors].sort((a, b) => a.path.localeCompare(b.path))

  it.each(detectors)(
    '%s: empties for another unit the numbers that opening without paths leaves empty',
    (_type, detector) => {
      const rule = { name: 'R', slug: 'r', message: 'm', signal: { path: RPM }, detector }
      const withPaths = (path: string) => ({
        ...rule,
        signal: { path },
        gates: [{ ...gate, signal: { path } }]
      })
      const opened = fromBody(withPaths(''), displayed).emptied
      const form = fromBody(withPaths(RPM), displayed).form
      const moved = fromBody(withPaths(TEMPERATURE), displayed).form
      const changed: RuleForm = {
        ...form,
        signal: moved.signal,
        gates: form.gates.map((g, i) => ({ ...g, signal: moved.gates[i]?.signal ?? g.signal }))
      }
      const { emptied } = withNumbersInUnit(form, changed, displayed)
      // Beyond the gate's limit, the detector's own.
      expect(emptied.length).toBeGreaterThan(1)
      // A change of unit withholds the text that opening shows.
      expect(emptied.every((e) => e.withheld === true)).toBe(true)
      expect(byPath(revealed(emptied))).toEqual(byPath(opened))
    }
  )
})

describe('withUnitErrors', () => {
  const limit = '/detector/steps/0/limit'
  const emptied = [{ path: limit, message: 'is required', withheld: true as const }]

  it('withholds the text of an error new on its field', () => {
    expect(withUnitErrors([], emptied)).toEqual(emptied)
  })

  it('shows the text on a field already showing an error, replacing that error', () => {
    const shown = [{ path: limit, message: 'must be a number' }]
    expect(withUnitErrors(shown, emptied)).toEqual([{ path: limit, message: 'is required' }])
  })

  it('withholds the text on a field whose error was itself withheld', () => {
    expect(withUnitErrors(emptied, emptied)).toEqual(emptied)
  })
})

describe('withoutGate', () => {
  const error = (path: string) => ({ path, message: 'is required' })
  const paths = (errors: readonly { path: string }[]) => errors.map((e) => e.path)

  it('drops the removed condition’s errors and moves those after it down by one', () => {
    const errors = [
      error('/gates/0/limit/value'),
      error('/gates/1/limit/value'),
      error('/gates/1/duration'),
      error('/gates/2/duration'),
      error('/gates/3')
    ]
    expect(paths(withoutGate(errors, 1))).toEqual([
      '/gates/0/limit/value',
      '/gates/1/duration',
      '/gates/2'
    ])
  })

  it('leaves the pointers of the rule’s own fields, and of all conditions together, alone', () => {
    const errors = [error('/detector/hysteresis'), error('/gates'), error('/name')]
    expect(withoutGate(errors, 0)).toEqual(errors)
  })

  it('reads a condition’s index whole, condition 10 apart from condition 1', () => {
    const errors = [error('/gates/1/duration'), error('/gates/10/duration')]
    expect(paths(withoutGate(errors, 1))).toEqual(['/gates/9/duration'])
    expect(paths(withoutGate(errors, 10))).toEqual(['/gates/1/duration'])
  })

  it('keeps each error’s text withheld or shown as it was', () => {
    const errors = [
      { path: '/gates/1/limit/value', message: 'is required', withheld: true as const },
      { path: '/gates/2/limit/value', message: 'is required' }
    ]
    expect(withoutGate(errors, 0)).toEqual([
      { path: '/gates/0/limit/value', message: 'is required', withheld: true },
      { path: '/gates/1/limit/value', message: 'is required' }
    ])
  })

  it('keeps each error’s message', () => {
    const errors = [{ path: '/gates/2/duration', message: 'must be at least 0' }]
    expect(withoutGate(errors, 0)).toEqual([
      { path: '/gates/1/duration', message: 'must be at least 0' }
    ])
  })
})
