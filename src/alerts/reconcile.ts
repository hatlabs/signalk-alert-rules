import { isWildcard, type Adopted } from '../engine/evaluator.js'
import type { Rule } from '../model/rule.js'
import type { CoreAlert } from './emitter.js'
import { parseAlertPath } from './paths.js'

export interface KeptAlert {
  alert: CoreAlert
  ruleId: string
  segment?: string
}

export interface Reconciliation {
  /** SKAR's alerts that stay: the emitter takes each over. */
  kept: KeptAlert[]
  /** Per rule id, the instances whose evaluator starts condition-active. */
  activeByRule: Map<string, Adopted[]>
  /** SKAR's alerts whose rule, or whose instance by definition, no longer exists. */
  orphaned: CoreAlert[]
}

/**
 * Sorts the alerts core holds at start. SKAR's own alerts are adopted rather
 * than re-verified: a rule with an active alert starts condition-active, so
 * a restart neither re-alerts nor clears it. An instance is gone only when
 * the rule cannot have it at all, not when it has not reported yet.
 */
export function reconcile(
  alerts: readonly CoreAlert[],
  pluginId: string,
  rules: ReadonlyMap<string, Rule>
): Reconciliation {
  const result: Reconciliation = { kept: [], activeByRule: new Map(), orphaned: [] }
  for (const alert of alerts) {
    const parsed = alert.$source === pluginId ? parseAlertPath(alert.path) : undefined
    if (parsed === undefined) continue
    const rule = rules.get(parsed.ruleId)
    if (rule === undefined || isWildcard(rule.signal) !== (parsed.segment !== undefined)) {
      result.orphaned.push(alert)
      continue
    }
    result.kept.push({ alert, ...parsed })
    if (!alert.condition) continue
    const adopted: Adopted = parsed.segment === undefined ? {} : { segment: parsed.segment }
    result.activeByRule.set(parsed.ruleId, [
      ...(result.activeByRule.get(parsed.ruleId) ?? []),
      adopted
    ])
  }
  return result
}
