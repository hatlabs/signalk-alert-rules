import { describe, expect, it } from 'vitest'
import { affine } from '../src/affine.js'

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
