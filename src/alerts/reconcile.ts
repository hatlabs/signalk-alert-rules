import type { Adopted } from '../engine/evaluator.js'
import type { Rule } from '../model/rule.js'
import type { CoreAlert } from './emitter.js'
import { ruleAlertPath } from '../model/alertPath.js'
import { matchAlertPath } from './paths.js'

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
 * The rule and instance whose alert path is the alert's, matching a wildcard
 * rule's path with the instance segment in place of its `*`. Alert paths are
 * unique across rules, so at most one rule matches.
 */
function ruleOf(
  path: string,
  rules: ReadonlyMap<string, Rule>
): { slug: string; rule: Rule; segment?: string } | undefined {
  for (const [slug, rule] of rules) {
    const matched = matchAlertPath(ruleAlertPath(rule), path)
    if (matched !== undefined) return { slug, rule, ...matched }
  }
  return undefined
}

/**
 * Sorts the alerts core holds at start. SKAR's alerts are those core
 * attributes to the plugin's id. Alert paths are in the data model, shared
 * with every other source, and core keeps one alert per path, which any
 * source may raise, taking over its attribution, or clear. So the check
 * keeps SKAR from adopting or clearing an alert at a rule's path only when
 * another source raised it last; while both run, they share that one alert.
 * SKAR's active alerts are adopted
 * rather than re-verified: a rule with an active alert starts
 * condition-active, so a restart neither re-alerts nor clears it. An alert
 * whose condition has ended is core's until acknowledged, so it is ignored;
 * that includes every latching alert, which core holds as ended from its
 * raise. An active alert of a rule turned latching while SKAR was down is
 * cleared, as the edit would have cleared it. An alert whose path no rule
 * has, such as a deleted rule's, is cleared as an orphan. An instance is
 * gone only when the rule cannot have it at all, not when it has not
 * reported yet.
 */
export function reconcile(
  alerts: readonly CoreAlert[],
  pluginId: string,
  rules: ReadonlyMap<string, Rule>
): Reconciliation {
  const result: Reconciliation = { kept: [], activeByRule: new Map(), toClear: [] }
  for (const alert of alerts) {
    if (alert.$source !== pluginId || !alert.condition) continue
    const owner = ruleOf(alert.path, rules)
    if (owner === undefined || owner.rule.latching === true) {
      result.toClear.push(alert)
      continue
    }
    const { slug, segment } = owner
    result.kept.push(segment === undefined ? { alert, slug } : { alert, slug, segment })
    const adopted: Adopted = segment === undefined ? {} : { segment }
    result.activeByRule.set(slug, [...(result.activeByRule.get(slug) ?? []), adopted])
  }
  return result
}
