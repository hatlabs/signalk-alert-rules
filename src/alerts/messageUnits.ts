import type { Signal } from '../model/rule.js'
import { DIFFERENCE_COMBINATORS, POSITION_COMBINATORS } from '../model/validate.js'
import { bindPath, type Instance } from '../engine/signals.js'

/**
 * Where a signal's units come from: the units, the path whose display unit
 * renders them (none for the position combinations' metres, which no path
 * reports), and whether the signal is a difference.
 */
export interface UnitSource {
  units: string
  path?: string
  difference: boolean
}

/**
 * The units a signal's values are in: its path's, or a combination's first
 * input's that has them. A ratio has none, and the position combinations
 * give metres.
 */
export function unitSource(
  signal: Signal,
  instance: Instance | undefined,
  meta: (path: string) => { units?: string } | undefined
): UnitSource | undefined {
  const from = (path: string, difference: boolean): UnitSource | undefined => {
    const bound = bindPath(path, instance)
    const units = meta(bound)?.units
    return units === undefined ? undefined : { units, path: bound, difference }
  }
  if (!('combinator' in signal)) return from(signal.path, false)
  if (signal.combinator === 'ratio') return undefined
  if (POSITION_COMBINATORS.has(signal.combinator)) return { units: 'm', difference: false }
  const difference = DIFFERENCE_COMBINATORS.has(signal.combinator)
  for (const input of signal.inputs) {
    const source = from(input.path, difference)
    if (source !== undefined) return source
  }
  return undefined
}
