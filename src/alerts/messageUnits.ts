import type { Signal } from '../model/rule.js'
import { POSITION_COMBINATORS } from '../model/validate.js'
import { bindPath, type Instance } from '../engine/signals.js'

/**
 * The units a signal's values are in: its path's, or a combination's first
 * input's that has them. A ratio has none, and the position combinations
 * give metres.
 */
export function signalUnits(
  signal: Signal,
  instance: Instance | undefined,
  meta: (path: string) => { units?: string } | undefined
): string | undefined {
  if (!('combinator' in signal)) return meta(bindPath(signal.path, instance))?.units
  if (signal.combinator === 'ratio') return undefined
  if (POSITION_COMBINATORS.has(signal.combinator)) return 'm'
  return signal.inputs
    .map((input) => meta(bindPath(input.path, instance))?.units)
    .find((units) => units !== undefined)
}
