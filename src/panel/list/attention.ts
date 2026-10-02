import type { Condition, ListedRule } from '../api'

/** What a rule's chip shows: Disabled for a disabled rule, otherwise its condition. */
export type ChipKind = Condition | 'disabled'

/**
 * The order the list shows rules in, most urgent first. `present` belongs to
 * a disabled rule, whose chip says Disabled, and appears only on instances.
 */
const ATTENTION_ORDER: readonly ChipKind[] = [
  'alerting',
  'problem',
  'noData',
  'disabled',
  'present',
  'normal'
]

export function chipOf(entry: ListedRule): ChipKind {
  return entry.status.ruleState === 'disabled' ? 'disabled' : entry.status.condition
}

export function needsAttention(entry: ListedRule): boolean {
  return chipOf(entry) !== 'normal'
}

/** The rules in attention order, the most recent change first within each state. */
export function byAttention(rules: readonly ListedRule[]): ListedRule[] {
  const rank = (entry: ListedRule) => ATTENTION_ORDER.indexOf(chipOf(entry))
  const changed = (entry: ListedRule) => Date.parse(entry.status.changedAt)
  return [...rules].sort((a, b) => rank(a) - rank(b) || changed(b) - changed(a))
}

/** How the summary line names each state. */
const SUMMARY_WORDS: Readonly<Record<ChipKind, string>> = {
  alerting: 'alerting',
  problem: 'problem',
  noData: 'no data',
  disabled: 'disabled',
  present: 'present',
  normal: 'normal'
}

/** How many rules have each state, as "1 alerting · 2 normal". */
export function summary(rules: readonly ListedRule[]): string {
  return ATTENTION_ORDER.flatMap((kind) => {
    const count = rules.filter((entry) => chipOf(entry) === kind).length
    return count === 0 ? [] : [`${String(count)} ${SUMMARY_WORDS[kind]}`]
  }).join(' · ')
}
