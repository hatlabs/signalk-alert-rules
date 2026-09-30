import type { Signal } from '../model/rule.js'
import { instanceIn } from './instances.js'
import { bindPath, type Instance } from './signals.js'

/** What an instance's suppression comes from: its rule, or an input path it reads. */
export type SuppressionScope =
  { scope: 'rule'; autoEndAfter?: number } | { scope: 'input'; path: string; autoEndAfter?: number }

/**
 * The gate states an input suppression froze when it started, by rule id,
 * gate index and rule instance name (`''` for a rule without instances).
 */
export type FrozenGates = Record<string, Record<string, Record<string, boolean>>>

/** The part of a suppression the engine acts on. */
export interface ActiveSuppression {
  /** Seconds the condition must stay clear for the suppression to end by itself. */
  autoEndAfter?: number
  /** For an input suppression: the states of the gates reading its path. */
  frozen?: FrozenGates
}

/** The suppressions in force, read at each evaluation. */
export interface Suppressions {
  /** The suppression of a rule, by its id `<origin>.<slug>`. */
  rule(id: string): ActiveSuppression | undefined
  /** The suppression of an exact concrete path. */
  path(path: string): ActiveSuppression | undefined
}

export const NO_SUPPRESSIONS: Suppressions = {
  rule: () => undefined,
  path: () => undefined
}

/** Where an evaluator reads its rule's suppressions: the rule's id and the suppressions in force. */
export interface SuppressionSource {
  id: string
  suppressions: Suppressions
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
 * Whether a signal reads a concrete path for some instance, and which: the
 * instance name a wildcard signal binds to read it, or undefined for a
 * signal without one.
 */
export function readsPath(
  signal: Signal,
  path: string
): { reads: false } | { reads: true; instance?: string } {
  if ('combinator' in signal) return { reads: signal.inputs.some((input) => input.path === path) }
  if (!signal.path.split('.').includes('*')) return { reads: signal.path === path }
  const instance = instanceIn(signal.path, path)
  return instance === undefined ? { reads: false } : { reads: true, instance }
}

/**
 * The suppression an instance of a rule is under: the rule's own, else that
 * of the first input path it reads that is suppressed.
 */
export function suppressionOf(
  { id, suppressions }: SuppressionSource,
  signal: Signal,
  instance: Instance | undefined
): SuppressionScope | undefined {
  const rule = ruleScope(suppressions.rule(id))
  if (rule !== undefined) return rule
  for (const path of signalPaths(signal, instance)) {
    const input = suppressions.path(path)
    if (input !== undefined) return { scope: 'input', path, ...autoEnd(input) }
  }
  return undefined
}

/** The scope of a rule's own suppression, if it has one. */
export function ruleScope(
  suppression: ActiveSuppression | undefined
): SuppressionScope | undefined {
  return suppression === undefined ? undefined : { scope: 'rule', ...autoEnd(suppression) }
}

function autoEnd({ autoEndAfter }: ActiveSuppression): ActiveSuppression {
  return autoEndAfter === undefined ? {} : { autoEndAfter }
}
