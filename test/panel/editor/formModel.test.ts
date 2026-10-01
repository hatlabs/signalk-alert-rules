import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMBINATORS,
  MAX_COMBINATOR_INPUTS,
  MAX_GATES as MODEL_MAX_GATES,
  MAX_SLUG_LENGTH,
  PRIORITIES,
  ZONE_LEVELS,
  type Detector,
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
  formAlertPrefix,
  fromRule,
  MAX_GATES,
  MAX_INPUTS,
  MAX_SLUG,
  PRIORITY_LEVELS,
  setCombinator,
  setMode,
  slugify,
  toRule,
  TWO_INPUT_KINDS,
  ZONE_LEVEL_NAMES,
  type RuleForm
} from '../../../src/panel/editor/formModel'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { NO_UNITS, POSITION_KINDS, unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')

function examples(): [string, Rule][] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')) as Rule])
}

function example(slug: string): Rule {
  return JSON.parse(readFileSync(join(EXAMPLES, `${slug}.json`), 'utf8')) as Rule
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

function saved(form: RuleForm, units = displayed): Rule {
  const result = toRule(form, units)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.rule
}

describe('the form model mirrors the rule model', () => {
  it('offers exactly the combinators, priorities and zone levels the model has', () => {
    expect([...COMBINATOR_KINDS]).toEqual([...COMBINATORS])
    expect([...PRIORITY_LEVELS]).toEqual([...PRIORITIES])
    expect([...ZONE_LEVEL_NAMES]).toEqual([...ZONE_LEVELS])
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
  const fixed = { kind: 'fixed', value: 1 } as const
  const event = { op: 'changes' } as const
  const states: [Detector, string][] = [
    [{ type: 'sustained', direction: 'above', limit: fixed }, 'voltageHigh'],
    [{ type: 'sustained', direction: 'below', limit: fixed }, 'voltageLow'],
    [{ type: 'slope', direction: 'rising', window: 60, limit: 1 }, 'voltageRising'],
    [{ type: 'slope', direction: 'falling', window: 60, limit: 1 }, 'voltageFalling'],
    [
      { type: 'projection', direction: 'rising', limit: fixed, window: 60, horizon: 600 },
      'voltageProjectedHigh'
    ],
    [
      { type: 'projection', direction: 'falling', limit: fixed, window: 60, horizon: 600 },
      'voltageProjectedLow'
    ],
    [{ type: 'match', op: 'equals', value: 1 }, 'voltageMatch'],
    [{ type: 'match', op: 'notEquals', value: 1 }, 'voltageMismatch'],
    [{ type: 'match', op: 'changesTo', value: 1 }, 'voltageChanged'],
    [{ type: 'match', op: 'decreases' }, 'voltageDecreased'],
    [{ type: 'match', op: 'timedOut', duration: 60 }, 'voltageTimedOut'],
    [{ type: 'accumulator', measure: 'time', limit: 3600 }, 'voltageAccumulated'],
    [{ type: 'count', event, window: 60, limit: 3 }, 'voltageFrequent'],
    [{ type: 'absence', event, within: 60 }, 'voltageMissing']
  ]

  it.each(states)('is the default of the detector the form saves: %j', (detector, condition) => {
    const base = { name: 'r', slug: 'r', message: 'm', priority: 'warning' }
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
      Object.assign(f, { name: 'r', slug: 'r', message: 'm', priority: 'warning' })
      f.signal.slots = [{ path: INPUT, source: '' }]
      f.detector.type = 'sustained'
      f.detector.direction = 'below'
      f.detector.limit.value = '12'
    })
    expect(defaultFormCondition(form)).toBe('voltageLow')
    expect(saved(form, NO_UNITS)).not.toHaveProperty('condition')
    const typed = { ...form, condition: 'flat' }
    expect(defaultFormCondition(typed)).toBe('voltageLow')
    expect(saved(typed, NO_UNITS)).toMatchObject({ condition: 'flat' })
  })

  it('loads a stored name, and none for a rule that stores none', () => {
    const base = { name: 'r', slug: 'r', message: 'm', priority: 'warning' as const }
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

describe('unit storage', () => {
  function sustained(path: string, value: string, hysteresis = ''): RuleForm {
    return authored((f) => {
      f.name = 'r'
      f.slug = 'r'
      f.message = 'm'
      f.priority = 'warning'
      f.signal.slots[0].path = path
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.detector.limit.value = value
      f.detector.hysteresis = hysteresis
    })
  }

  it('stores 11.8 V as 11.8', () => {
    const rule = saved(sustained('electrical.batteries.house.voltage', '11.8'))
    expect(rule.detector).toMatchObject({ limit: { kind: 'fixed', value: 11.8 } })
  })

  it('stores 95 °C as 368.15 K and a 2 °C hysteresis as 2 K', () => {
    const rule = saved(sustained('propulsion.port.coolantTemperature', '95', '2'))
    expect(rule.detector).toMatchObject({ limit: { value: 368.15 }, hysteresis: 2 })
  })

  it('stores a 0.5 °C/min slope as the equivalent K/s', () => {
    const rule = saved(
      authored((f) => {
        Object.assign(f, { name: 'r', slug: 'r', message: 'm', priority: 'warning' })
        f.signal.slots[0].path = 'propulsion.port.coolantTemperature'
        f.detector.type = 'slope'
        f.detector.trend = 'rising'
        f.detector.slopeLimit = '0.5'
        f.detector.window = { amount: '5', unit: 'min' }
      })
    )
    expect(rule.detector).toEqual({
      type: 'slope',
      direction: 'rising',
      window: 300,
      limit: expect.closeTo(0.5 / 60, 15) as number
    })
  })

  it('stores a ratio slope of 0.6 /min as 0.01 per second, and shows it back per minute', () => {
    const form = authored((f) => {
      Object.assign(f, { name: 'r', slug: 'r', message: 'm', priority: 'warning' })
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'ratio')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
      f.signal.slots[1].path = 'propulsion.starboard.revolutions'
      f.detector.type = 'slope'
      f.detector.trend = 'rising'
      f.detector.slopeLimit = '0.6'
      f.detector.window = { amount: '1', unit: 'min' }
    })
    const rule = saved(form)
    expect(rule.detector).toMatchObject({ limit: 0.01 })
    expect(fromRule(rule, displayed).detector.slopeLimit).toBe('0.6')
  })

  describe('an accumulator on coolant temperature', () => {
    const accumulator = (edit: (f: RuleForm) => void) =>
      authored((f) => {
        Object.assign(f, { name: 'r', slug: 'r', message: 'm', priority: 'warning' })
        f.signal.slots[0].path = 'propulsion.port.coolantTemperature'
        f.detector.type = 'accumulator'
        f.detector.measure = 'integral'
        f.detector.integralLimit = '10'
        edit(f)
      })

    it('stores an integral limit of 10 °C·s as 10 K·s, without the offset', () => {
      const rule = saved(accumulator(() => undefined))
      expect(rule.detector).toMatchObject({ limit: 10 })
      expect(fromRule(rule, displayed).detector.integralLimit).toBe('10')
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
      priority: 'caution',
      signal: { path: 'navigation.headingMagnetic' },
      detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 0.1 } }
    }
    const form = fromRule(rule, displayed)
    expect(form.detector.limit.value).toBe('5.72957795131')
    expect(saved(form)).toEqual(rule)
    form.detector.limit.value = '6'
    expect((saved(form).detector as { limit: { value: number } }).limit.value).toBeCloseTo(
      0.10472,
      5
    )
  })

  it('shows a stored limit in the display unit', () => {
    const rule = saved(sustained('environment.outside.temperature', '212'))
    expect(rule.detector).toMatchObject({ limit: { value: 373.15 } })
    expect(fromRule(rule, displayed).detector.limit.value).toBe('212')
  })

  it('shows durations in the largest whole unit', () => {
    const form = fromRule(example('engine-service-due'), displayed)
    expect(form.detector.timeLimit).toEqual({ amount: '250', unit: 'h' })
  })
})

describe('authoring the worked scenarios', () => {
  it('authors the twin-engine RPM difference with two slots and gates', () => {
    const form = authored((f) => {
      f.name = 'Engine RPM mismatch'
      f.slug = slugify(f.name)
      f.condition = 'revolutionsMismatch'
      f.message = 'Port and starboard engine speeds differ'
      f.priority = 'caution'
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'absDifference')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
      f.signal.slots[1].path = 'propulsion.starboard.revolutions'
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.detector.limit.value = '180'
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
    expect(rule.detector).toMatchObject({ limit: { kind: 'fixed', value: 3 }, duration: 30 })
    expect(validateRule(rule).ok).toBe(true)
  })

  it('authors the three-GNSS spread with source-restricted slots, in the distance unit', () => {
    const form = authored((f) => {
      Object.assign(f, {
        name: 'GNSS',
        slug: 'gnss',
        condition: 'gnssDisagree',
        message: 'm',
        priority: 'warning'
      })
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'positionSpread')
      f.signal.slots = ['gnss.bow', 'gnss.stern', 'gnss.mast'].map((source) => ({
        path: 'navigation.position',
        source
      }))
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.detector.limit.value = '0.027'
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
    expect((rule.detector as { limit: { value: number } }).limit.value).toBeCloseTo(50.004, 3)
    expect(validateRule(rule).ok).toBe(true)
  })

  it('authors a wildcard battery rule with an {instance} message and a zone limit', () => {
    const rule = saved(
      authored((f) => {
        Object.assign(f, { name: 'Battery low', slug: 'battery-low' })
        f.message = 'Battery {instance} low'
        f.priority = 'alarm'
        f.signal.slots[0].path = 'electrical.batteries.*.voltage'
        f.detector.type = 'sustained'
        f.detector.direction = 'below'
        f.detector.limit.kind = 'zone'
        f.detector.limit.level = 'warn'
      })
    )
    expect(rule.priority).toBeUndefined()
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
      Object.assign(f, { name: 'x', slug: 'x', message: 'm', priority: 'warning' })
      f.signal = setCombinator(setMode(f.signal, 'combine'), 'difference')
      f.signal.slots[0].path = 'propulsion.port.revolutions'
      f.signal.slots[1].path = 'electrical.batteries.house.voltage'
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.detector.limit.value = '1'
    })
    const result = toRule(form, displayed)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors).toEqual([
      { path: '/signal/inputs/1/path', message: 'is in V, the other inputs in Hz' }
    ])
  })
})

describe('local checks', () => {
  it('names each missing or malformed field by its pointer', () => {
    const form = authored((f) => {
      f.detector.type = 'sustained'
      f.detector.direction = 'above'
      f.detector.limit.value = 'abc'
    })
    const result = toRule(form, NO_UNITS)
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      '/name',
      '/slug',
      '/message',
      '/priority',
      '/signal/path',
      '/detector/limit/value'
    ])
  })

  it('drops latching once the detector can no longer latch', () => {
    const form = fromRule(example('engine-stopped'), NO_UNITS)
    form.detector.matchOp = 'equals'
    expect(saved(form, NO_UNITS).latching).toBeUndefined()
  })
})
