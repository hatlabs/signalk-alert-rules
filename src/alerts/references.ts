import type { Limit, Rule, Signal } from '../model/rule.js'
import { acceptedByCore, fillWildcard } from './paths.js'

/** The most paths core accepts in an alert's `references` (src/api/alerts/description.ts). */
export const MAX_REFERENCES = 50

function signalPaths(signal: Signal): string[] {
  return 'combinator' in signal ? signal.inputs.map((input) => input.path) : [signal.path]
}

function limitPaths(limit: Limit): string[] {
  return limit.kind === 'zone' && limit.path !== undefined ? [limit.path] : []
}

/**
 * The data paths a rule reads for an instance, for its alert's `references`:
 * its input, its zone limit's path, then each gate's input and zone limit's
 * path, with the instance's name in place of the wildcard. Duplicates and
 * paths core would refuse are left out. A rule can read more paths than core
 * accepts (16 inputs and 8 gates of 16), so the list keeps the first
 * {@link MAX_REFERENCES} in that order, the input's first.
 */
export function referencesOf(rule: Rule, instance?: string): string[] {
  const d = rule.detector
  const paths = [
    ...signalPaths(rule.signal),
    ...(d.type === 'sustained' || d.type === 'projection' ? limitPaths(d.limit) : []),
    ...(rule.gates ?? []).flatMap((gate) => [
      ...signalPaths(gate.signal),
      ...limitPaths(gate.limit)
    ])
  ].map((path) => (instance === undefined ? path : fillWildcard(path, instance)))
  // Core drops every reference when it refuses one.
  return [...new Set(paths)].filter(acceptedByCore).slice(0, MAX_REFERENCES)
}
