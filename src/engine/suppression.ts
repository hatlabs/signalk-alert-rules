import type { Signal } from '../model/rule.js'
import { bindPath, type Instance } from './signals.js'

/** What an instance's suppression comes from: its rule, or an input path it reads. */
export type SuppressionScope =
  { scope: 'rule'; autoEndAfter?: number } | { scope: 'input'; path: string; autoEndAfter?: number }

/** The part of a suppression the engine acts on. */
export interface ActiveSuppression {
  /** Seconds the condition must stay clear for the suppression to end by itself. */
  autoEndAfter?: number
}

/** The suppressions in force for one rule, read at each evaluation. */
export interface Suppressions {
  rule(): ActiveSuppression | undefined
  /** The suppression of an exact concrete path. */
  path(path: string): ActiveSuppression | undefined
}

export const NO_SUPPRESSIONS: Suppressions = {
  rule: () => undefined,
  path: () => undefined
}

/**
 * The concrete paths a signal reads for an instance: a path signal's path
 * with its wildcard bound, or each combinator input's path.
 */
export function signalPaths(signal: Signal, instance: Instance | undefined): string[] {
  return 'combinator' in signal
    ? signal.inputs.map((input) => input.path)
    : [bindPath(signal.path, instance)]
}

/**
 * The suppression an instance of a rule is under: the rule's own, else that
 * of the first input path it reads that is suppressed.
 */
export function suppressionOf(
  suppressions: Suppressions,
  signal: Signal,
  instance: Instance | undefined
): SuppressionScope | undefined {
  const rule = suppressions.rule()
  if (rule !== undefined) return { scope: 'rule', ...autoEnd(rule) }
  for (const path of signalPaths(signal, instance)) {
    const input = suppressions.path(path)
    if (input !== undefined) return { scope: 'input', path, ...autoEnd(input) }
  }
  return undefined
}

function autoEnd({ autoEndAfter }: ActiveSuppression): ActiveSuppression {
  return autoEndAfter === undefined ? {} : { autoEndAfter }
}
