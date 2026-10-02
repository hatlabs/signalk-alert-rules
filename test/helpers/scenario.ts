// The shape of a scenario, self-vessel values over time and the alert
// sequence SKAR is expected to send in response, and builders for its
// samples. Shared by the worked-example and built-in template suites.

import type { PathValueState, Value } from '@signalk/server-api'
import type { PathMeta } from '../../src/engine/evaluator.js'
import type { Priority } from '../../src/model/rule.js'

export interface Timed {
  /** Seconds since the plugin started. */
  t: number
  path: string
  source: string
  value: Value
  state?: PathValueState
}

/**
 * One alert emission as core receives it: a raise, a priority change of an
 * active alert, or the report that its condition ended. Heartbeats are left
 * out. The path is under `alerts.`.
 */
export type AlertStep =
  | [t: number, event: 'raise' | 'priority', path: string, priority: Priority]
  | [t: number, event: 'clear', path: string]

export interface Scenario {
  /** Source ranking for the preferred-source filter, best first. */
  ranking?: string[]
  /** Path meta, such as zones, the server holds. */
  meta?: Record<string, PathMeta>
  /** Seconds between evaluation ticks; transitions land on a tick or a sample. */
  tick: number
  /** Last tick, in seconds since start. */
  until: number
  deltas: Timed[]
  expected: AlertStep[]
}

export const HOUR = 3600

export function at(t: number, path: string, value: Value, source = 'sensor'): Timed {
  return { t, path, source, value }
}

export function timedOut(t: number, path: string, source = 'sensor'): Timed {
  return { t, path, source, value: null, state: { timedOut: true } }
}

/** A sample every `step` seconds from `from` up to but not including `to`. */
export function every(
  step: number,
  from: number,
  to: number,
  sample: (t: number) => Timed | Timed[]
): Timed[] {
  const samples: Timed[] = []
  for (let t = from; t < to; t += step) samples.push(...[sample(t)].flat())
  return samples
}
