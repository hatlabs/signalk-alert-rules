import { describe, expect, it } from 'vitest'
import {
  affine,
  displayUnit,
  fromSI,
  toSI,
  unitLabel,
  type DisplayUnit,
  type QuantityKind
} from '../../src/panel/units'

// Formulas as signalk-server's standard-units-definitions.json writes them
// and GET /signalk/v1/api/vessels/self returns them in meta.displayUnits.
const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
const fahrenheit = displayUnit({
  units: 'K',
  displayUnits: { formula: '(value - 273.15) * 9/5 + 32', symbol: '°F' }
})
const knots = displayUnit({
  units: 'm/s',
  displayUnits: { formula: 'value * 1.94384', symbol: 'kn' }
})
const volts = displayUnit({ units: 'V', displayUnits: { formula: 'value * 1', symbol: 'V' } })
const nauticalMiles = displayUnit({
  units: 'm',
  displayUnits: { formula: 'value * 0.0005399568034557236', symbol: 'nmi' }
})

describe('affine', () => {
  it.each([
    ['value', 1, 0],
    ['value * 1.94384', 1.94384, 0],
    ['value - 273.15', 1, -273.15],
    ['value / 1000', 0.001, 0],
    ['value * 6.0221412901167415e+26', 6.0221412901167415e26, 0],
    ['-value + 1', -1, 1],
    ['2^3 * value', 8, 0]
  ])('reads %s as scale %d and offset %d', (formula, scale, offset) => {
    const result = affine(formula)
    expect(result?.scale).toBeCloseTo(scale, 12)
    expect(result?.offset).toBeCloseTo(offset, 12)
  })

  it('reads the Fahrenheit formula', () => {
    const result = affine('(value - 273.15) * 9/5 + 32')
    expect(result?.scale).toBeCloseTo(1.8, 12)
    expect(result?.offset).toBeCloseTo(-459.67, 10)
  })

  it.each([
    ['(value / 0.836)^(2/3)', 'Beaufort is not linear'],
    ['formatDurationHMS(value)', 'a function call'],
    ['value * value', 'a product of values'],
    ['1 / value', 'a division by the value'],
    ['value * 0', 'a conversion that cannot be inverted'],
    ['value +', 'a malformed expression'],
    ['value 2', 'trailing input'],
    ['', 'an empty formula']
  ])('rejects %s (%s)', (formula) => {
    expect(affine(formula)).toBeNull()
  })
})

describe('displayUnit', () => {
  it('uses the display unit the server resolved for the path', () => {
    expect(celsius).toMatchObject({ symbol: '°C', si: false })
  })

  it('falls back to the SI unit, marked as such, when meta has no display unit', () => {
    const unit = displayUnit({ units: 'K' })
    expect(unit).toEqual({ symbol: 'K', scale: 1, offset: 0, si: true })
    expect(unitLabel('absolute', unit)).toBe('K (SI)')
  })

  it('falls back to SI when the formula is not linear', () => {
    const unit = displayUnit({
      units: 'm/s',
      displayUnits: { formula: '(value / 0.836)^(2/3)', symbol: 'Bf' }
    })
    expect(unit).toMatchObject({ symbol: 'm/s', si: true })
  })

  it('labels a path with no units at all as SI', () => {
    expect(unitLabel('absolute', displayUnit({}))).toBe('SI')
  })
})

describe('conversion', () => {
  it('stores 11.8 V as 11.8', () => {
    expect(toSI('absolute', 11.8, volts)).toBe(11.8)
    expect(toSI('absolute', 11.8, displayUnit({ units: 'V' }))).toBe(11.8)
  })

  it('stores 95 °C as 368.15 K', () => {
    expect(toSI('absolute', 95, celsius)).toBe(368.15)
    expect(toSI('absolute', 212, fahrenheit)).toBe(373.15)
  })

  it('stores a 2 °C hysteresis as 2 K through the linear part only', () => {
    expect(toSI('interval', 2, celsius)).toBe(2)
    expect(toSI('interval', 1.8, fahrenheit)).toBe(1)
  })

  it('stores a 0.5 °C/min slope as the equivalent K/s', () => {
    expect(toSI('slope', 0.5, celsius)).toBeCloseTo(0.5 / 60, 16)
    expect(toSI('slope', 0.9, fahrenheit)).toBeCloseTo(0.5 / 60, 16)
  })

  it('leaves a ratio unitless', () => {
    expect(toSI('ratio', 1.25, celsius)).toBe(1.25)
    expect(fromSI('ratio', 1.25, celsius)).toBe(1.25)
    expect(unitLabel('ratio', celsius)).toBe('')
  })

  it('converts a distance in the user distance unit', () => {
    expect(toSI('absolute', 1, nauticalMiles)).toBe(1852)
    expect(fromSI('absolute', 1852, nauticalMiles)).toBe(1)
  })

  it('shows stored SI values in the display unit', () => {
    expect(fromSI('absolute', 368.15, celsius)).toBe(95)
    expect(fromSI('absolute', 273.15, fahrenheit)).toBe(32)
    expect(fromSI('interval', 2, fahrenheit)).toBe(3.6)
    expect(fromSI('slope', 0.5 / 60, celsius)).toBe(0.5)
    // The server's own constants are rounded, so this is 1 kn only to six digits.
    expect(fromSI('absolute', 0.514444, knots)).toBeCloseTo(1, 5)
  })

  const kinds: QuantityKind[] = ['absolute', 'interval', 'ratio', 'slope']
  const units: [string, DisplayUnit][] = [
    ['°C', celsius],
    ['°F', fahrenheit],
    ['kn', knots],
    ['V', volts],
    ['nmi', nauticalMiles]
  ]
  const entered = [0, 11.8, -40, 95, 0.1, 1234.5, 0.03]

  it.each(kinds.flatMap((kind) => units.map(([name, unit]) => [kind, name, unit] as const)))(
    'round-trips %s values in %s',
    (kind, _name, unit) => {
      for (const value of entered) {
        expect(fromSI(kind, toSI(kind, value, unit), unit)).toBe(value)
      }
    }
  )
})

describe('unitLabel', () => {
  it.each([
    ['absolute', celsius, '°C'],
    ['interval', celsius, '°C'],
    ['slope', celsius, '°C/min'],
    ['slope', displayUnit({ units: 'K' }), 'K/min (SI)'],
    ['interval', displayUnit({ units: 'K' }), 'K (SI)']
  ] as const)('labels a %s field in %o as %s', (kind, unit, label) => {
    expect(unitLabel(kind, unit)).toBe(label)
  })
})
