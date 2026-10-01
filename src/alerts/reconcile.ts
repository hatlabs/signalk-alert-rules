import { isWildcard, type Adopted } from '../engine/evaluator.js'
import type { Rule } from '../model/rule.js'
import type { CoreAlert } from './emitter.js'
import { parseAlertPath, type ParsedAlertPath } from './paths.js'

export interface KeptAlert {
  alert: CoreAlert
  slug: string
  segment?: string
}

export interface Reconciliation {
  /** SKAR's active alerts that stay: the emitter takes each over. */
  kept: KeptAlert[]
  /** Per rule id, the instances whose evaluator starts condition-active. */
  activeByRule: Map<string, Adopted[]>
  /**
   * SKAR's active alerts to clear at start, for either of two reasons: their
   * rule, or their instance by definition, no longer exists; or their rule is
   * now latching and so holds no active alert.
   */
  toClear: CoreAlert[]
}

/**
 * The rule and instance of an active alert SKAR raised under its own prefix;
 * undefined for any other alert, including another source's under the same
 * prefix.
 */
export function ownedActiveAlert(alert: CoreAlert, pluginId: string): ParsedAlertPath | undefined {
  return alert.$source === pluginId && alert.condition ? parseAlertPath(alert.path) : undefined
}

/**
 * Sorts the alerts core holds at start. SKAR's own active alerts are adopted
 * rather than re-verified: a rule with an active alert starts
 * condition-active, so a restart neither re-alerts nor clears it. An alert
 * whose condition has ended is core's until acknowledged, so it is ignored;
 * that includes every latching alert, which core holds as ended from its
 * raise. An active alert of a rule turned latching while SKAR was down is
 * cleared, as the edit would have cleared it. An instance is gone only when
 * the rule cannot have it at all, not when it has not reported yet.
 */
export function reconcile(
  alerts: readonly CoreAlert[],
  pluginId: string,
  rules: ReadonlyMap<string, Rule>
): Reconciliation {
  const result: Reconciliation = { kept: [], activeByRule: new Map(), toClear: [] }
  for (const alert of alerts) {
    const parsed = ownedActiveAlert(alert, pluginId)
    if (parsed === undefined) continue
    const rule = rules.get(parsed.slug)
    if (
      rule === undefined ||
      rule.latching === true ||
      isWildcard(rule.signal) !== (parsed.segment !== undefined)
    ) {
      result.toClear.push(alert)
      continue
    }
    result.kept.push({ alert, ...parsed })
    const adopted: Adopted = parsed.segment === undefined ? {} : { segment: parsed.segment }
    result.activeByRule.set(parsed.slug, [...(result.activeByRule.get(parsed.slug) ?? []), adopted])
  }
  return result
}
