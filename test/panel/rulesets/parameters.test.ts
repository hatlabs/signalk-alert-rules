import { describe, expect, it } from 'vitest'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import type { Parameter } from '../../../src/panel/rulesets/api'
import {
  initialDraft,
  parameterUnit,
  shownValue,
  valuesToSend
} from '../../../src/panel/rulesets/parameters'
import { displayUnit } from '../../../src/panel/units'

const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
const fahrenheit = displayUnit({
  units: 'K',
  displayUnits: { formula: '(value - 273.15) * 9/5 + 32', symbol: '°F' }
})

const path = (p: string, unit: PathEntry['unit'], units = 'K'): PathEntry => ({
  path: p,
  units,
  unit
})

const prefix: Parameter = { name: 'prefix', type: 'string', default: 'electrical.batteries.house' }
const lowVoltage: Parameter = {
  name: 'lowVoltage',
  type: 'number',
  unit: 'V',
  default: 12,
  minimum: 10,
  maximum: 14
}
const hot: Parameter = { name: 'hot', type: 'number', unit: 'K', default: 353.15 }
const parameters = [prefix, lowVoltage, hot]

const inCelsius = (p: Parameter) => (p.unit === 'K' ? celsius : displayUnit({ units: p.unit }))

describe('parameterUnit', () => {
  it('takes the display unit the server resolves for paths in the same SI unit', () => {
    const paths = [
      path('propulsion.port.temperature', celsius),
      path('environment.water.temperature', celsius)
    ]
    expect(parameterUnit('K', paths)).toEqual(celsius)
  })

  it('stays in SI when paths in the unit are shown in different units', () => {
    const paths = [path('a.temperature', celsius), path('b.temperature', fahrenheit)]
    expect(parameterUnit('K', paths)).toEqual(displayUnit({ units: 'K' }))
  })

  it('stays in SI when no path has the unit', () => {
    expect(parameterUnit('V', [path('a.temperature', celsius)])).toEqual(
      displayUnit({ units: 'V' })
    )
  })

  it('has no unit for a parameter without one', () => {
    expect(parameterUnit(undefined, [])).toEqual(displayUnit({}))
  })
})

describe('shownValue', () => {
  it('shows a number in the display unit', () => {
    expect(shownValue(hot, 353.15, celsius)).toBe('80')
  })

  it('shows a string as it is', () => {
    expect(shownValue(prefix, 'a.b', celsius)).toBe('a.b')
  })
})

describe('initialDraft', () => {
  it('holds the stored values in display units and leaves the rest at the default', () => {
    const draft = initialDraft(parameters, { hot: 363.15, prefix: 'x' }, inCelsius)
    expect(draft).toEqual({ prefix: 'x', lowVoltage: undefined, hot: '90' })
  })
})

describe('valuesToSend', () => {
  const stored = { hot: 363.15 }
  const initial = initialDraft(parameters, stored, inCelsius)

  it('converts typed numbers to SI', () => {
    const outcome = valuesToSend(parameters, stored, initial, { ...initial, hot: '85' }, inCelsius)
    expect(outcome).toEqual({ ok: true, values: { hot: 358.15 } })
  })

  it('leaves out a parameter reset to its default', () => {
    const outcome = valuesToSend(
      parameters,
      stored,
      initial,
      { ...initial, hot: undefined },
      inCelsius
    )
    expect(outcome).toEqual({ ok: true, values: {} })
  })

  it('sends an untouched stored value exactly, not through the display unit', () => {
    const odd = { hot: 363.1500000001 }
    const draft = initialDraft(parameters, odd, inCelsius)
    expect(valuesToSend(parameters, odd, draft, draft, inCelsius)).toEqual({
      ok: true,
      values: odd
    })
  })

  it('sends a string parameter as typed', () => {
    const outcome = valuesToSend(
      parameters,
      {},
      {},
      { prefix: 'electrical.batteries.start' },
      inCelsius
    )
    expect(outcome).toEqual({ ok: true, values: { prefix: 'electrical.batteries.start' } })
  })

  it('refuses text that is not a number, naming the parameter', () => {
    const outcome = valuesToSend(parameters, {}, {}, { lowVoltage: 'twelve', hot: '' }, inCelsius)
    expect(outcome).toEqual({
      ok: false,
      errors: [
        { path: '/lowVoltage', message: 'must be a number' },
        { path: '/hot', message: 'must be a number' }
      ]
    })
  })
})
