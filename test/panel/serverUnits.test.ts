import { describe, expect, it } from 'vitest'
import { affine } from '../../src/panel/units'
// Copied unchanged from signalk-server 2.31.0, unitpreferences/: the unit
// conversions the server ships, whose formulas it sends in meta.displayUnits.
import custom from '../fixtures/signalk-server-units/custom-units-definitions.json'
import standard from '../fixtures/signalk-server-units/standard-units-definitions.json'

type Definitions = Record<string, { conversions: Record<string, { formula: string }> }>

const files: Definitions[] = [standard, custom]

const conversions = files.flatMap((definitions) =>
  Object.entries(definitions).flatMap(([si, unit]) =>
    Object.entries(unit.conversions).map(([name, { formula }]) => ({
      label: `${si} to ${name}`,
      formula
    }))
  )
)

/**
 * Conversions the panel shows in SI instead: Beaufort is not linear, the
 * duration formatters produce text, and mathjs, which the server evaluates
 * formulas with, rejects the digit separators in the terabyte formula.
 */
const NOT_AFFINE = [
  'm/s to Bf',
  's to DD:HH:MM:SS',
  's to HH:MM:SS',
  's to HH:MM:SS.mmm',
  's to MM:SS',
  's to MM:SS.mmm',
  's to duration-verbose',
  's to duration-compact',
  'MB to Terrabyte'
]

const ARITHMETIC = /^(?:value|[\d.e+\-*/()^\s])+$/

/**
 * The formula evaluated by JavaScript, an oracle independent of the parser
 * under test. mathjs's `^` is JavaScript's `**`.
 */
function evaluate(formula: string, value: number): number {
  if (!ARITHMETIC.test(formula)) throw new Error(`not plain arithmetic: ${formula}`)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function('value', `return ${formula.replaceAll('^', '**')}`) as (
    value: number
  ) => number
  return f(value)
}

const SAMPLES = [-40, 0, 1, 273.15, 101325]

describe("affine over the server's shipped unit conversions", () => {
  it('reads every conversion it can as the server evaluates it', () => {
    const read = conversions.filter(({ label }) => !NOT_AFFINE.includes(label))
    expect(read.length).toBeGreaterThan(100)
    for (const { label, formula } of read) {
      const map = affine(formula)
      expect(map, label).not.toBeNull()
      if (map === null) continue
      for (const value of SAMPLES) {
        const expected = evaluate(formula, value)
        const tolerance = 1e-9 * Math.max(1, Math.abs(expected))
        expect(Math.abs(map.scale * value + map.offset - expected), label).toBeLessThanOrEqual(
          tolerance
        )
      }
    }
  })

  it('falls back to SI for exactly the conversions that are not affine', () => {
    const unread = conversions.filter(({ formula }) => affine(formula) === null)
    expect(unread.map(({ label }) => label)).toEqual(NOT_AFFINE)
  })
})
