/**
 * The parameter form of a ruleset: what each field shows, and the values
 * object a save sends. A save replaces every stored value, so a parameter at
 * its default is always left out, never sent as its default: an upgrade that
 * changes the default then applies it.
 */
import type { FieldError } from '../api'
import type { PathEntry } from '../paths/selfPaths'
import { displayUnit, fromSI, toSI, type DisplayUnit } from '../units'
import type { Parameter } from './api'

/**
 * Each parameter's text as the form holds it, by name; undefined takes the
 * default.
 */
export type Draft = Record<string, string | undefined>

export type Values = Record<string, number | string>

/**
 * A parameter declares only its SI unit, and the server resolves display
 * units per path. Paths in the same SI unit that all show in one unit give
 * the operator's preference for it; where they disagree, as depth and
 * distance may for metres, no choice is safe, so the value stays in SI.
 */
export function parameterUnit(unit: string | undefined, paths: readonly PathEntry[]): DisplayUnit {
  if (unit === undefined) return displayUnit({})
  const shown = paths.filter((p) => p.units === unit).map((p) => p.unit)
  if (shown.length === 0) return displayUnit({ units: unit })
  const [first] = shown
  const agree = shown.every(
    (u) => u.symbol === first.symbol && u.scale === first.scale && u.offset === first.offset
  )
  return agree ? first : displayUnit({ units: unit })
}

/**
 * A parameter is a threshold far more often than a difference, and the
 * declaration cannot tell them apart, so a number converts as an absolute
 * value.
 */
export function shownValue(parameter: Parameter, value: number | string, unit: DisplayUnit) {
  return parameter.type === 'number' && typeof value === 'number'
    ? String(fromSI('absolute', value, unit))
    : String(value)
}

export function initialDraft(
  parameters: readonly Parameter[],
  values: Values,
  unitOf: (p: Parameter) => DisplayUnit
): Draft {
  return Object.fromEntries(
    parameters.map((p) => {
      const value = Object.hasOwn(values, p.name) ? values[p.name] : undefined
      return [p.name, value === undefined ? undefined : shownValue(p, value, unitOf(p))]
    })
  )
}

export type SendOutcome = { ok: true; values: Values } | { ok: false; errors: FieldError[] }

/**
 * The values object to send, or an error on each field that does not hold a
 * number. A stored value whose text is untouched is sent as stored, since a
 * round trip through the display unit could change its last digits.
 */
export function valuesToSend(
  parameters: readonly Parameter[],
  stored: Values,
  initial: Draft,
  draft: Draft,
  unitOf: (p: Parameter) => DisplayUnit
): SendOutcome {
  const values: Values = {}
  const errors: FieldError[] = []
  for (const p of parameters) {
    const text = draft[p.name]
    if (text === undefined) continue
    if (text === initial[p.name] && Object.hasOwn(stored, p.name)) {
      values[p.name] = stored[p.name]
    } else if (p.type === 'string') {
      values[p.name] = text
    } else {
      const typed = text.trim() === '' ? NaN : Number(text)
      if (Number.isFinite(typed)) values[p.name] = toSI('absolute', typed, unitOf(p))
      else errors.push({ path: `/${p.name}`, message: 'must be a number' })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}
