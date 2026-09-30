import type { Context, Path, SubscriptionManager, Unsubscribes } from '@signalk/server-api'
import { instanceIn } from '../engine/instances.js'
import type { Rule, Signal } from '../model/rule.js'

const SELF = 'vessels.self' as Context

function signalInputs(signal: Signal): string[] {
  return 'combinator' in signal ? signal.inputs.map((i) => i.path) : [signal.path]
}

/**
 * The paths a rule reads, its detector's, combinator's and gates' inputs,
 * each once. A wildcard path stays a pattern.
 */
export function rulePaths(rule: Rule): string[] {
  const paths = [rule.signal, ...(rule.gates ?? []).map((g) => g.signal)].flatMap(signalInputs)
  return [...new Set(paths)]
}

function matches(pattern: string, path: string): boolean {
  return pattern.split('.').includes('*')
    ? instanceIn(pattern, path) !== undefined
    : path === pattern
}

/**
 * Which paths the server has had since watching began, from any source and
 * with any value, null included; a wildcard pattern counts once one path
 * matches it. A path once seen stays seen: a ruleset rule describes hardware,
 * and hardware that has reported is present even while it is silent.
 */
export class PathPresence {
  private readonly seen = new Set<string>()
  private readonly watching = new Map<string, Unsubscribes>()

  constructor(private readonly subscriptions: SubscriptionManager) {}

  /** Starts watching the patterns neither seen nor watched yet. */
  watch(patterns: Iterable<string>): void {
    for (const pattern of patterns) {
      if (this.seen.has(pattern) || this.watching.has(pattern)) continue
      const unsubscribes: Unsubscribes = []
      this.watching.set(pattern, unsubscribes)
      // The server replays the paths it already has synchronously inside subscribe().
      this.subscriptions.subscribe(
        { context: SELF, subscribe: [{ path: pattern as Path }], sourcePolicy: 'all' },
        unsubscribes,
        () => undefined,
        (delta) => {
          for (const update of delta.updates) {
            if (!('values' in update)) continue
            if (update.values.some((pv) => matches(pattern, pv.path))) this.seen.add(pattern)
          }
        }
      )
    }
  }

  has(pattern: string): boolean {
    return this.seen.has(pattern)
  }

  /** Ends the subscriptions of patterns already seen; not done in the callback, where the server is mid-delivery. */
  prune(): void {
    for (const [pattern, unsubscribes] of this.watching) {
      if (!this.seen.has(pattern)) continue
      for (const unsubscribe of unsubscribes) unsubscribe()
      this.watching.delete(pattern)
    }
  }

  stop(): void {
    for (const unsubscribes of this.watching.values())
      for (const unsubscribe of unsubscribes) unsubscribe()
    this.watching.clear()
  }
}
