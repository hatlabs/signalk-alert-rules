import type { Progress } from '../engine/detectors/index.js'
import type { Problem } from '../engine/evaluator.js'
import type { InputState } from '../engine/signals.js'

/** The closed status list, most important first. */
export const BADGES = [
  'disabled',
  'errored',
  'inactive',
  'alertActive',
  'gatedOff',
  'inputUnavailable',
  'neverSeen',
  'timerRunning',
  'idle'
] as const
export type Badge = (typeof BADGES)[number]

/** Secondary conditions shown next to the badge, in display order. */
export const SUB_LABELS = ['gateInputUnavailable', 'waitingForClear', 'awaitingInput'] as const
export type SubLabel = (typeof SUB_LABELS)[number]

/** What the badge of one instance depends on. */
export interface InstanceFacts {
  active: boolean
  input: InputState
  gates: readonly { holds: boolean; input: InputState }[]
  progress?: Progress
  /** Why the rule cannot evaluate this instance. */
  inactive?: Problem
  awaitingInput?: boolean
}

export interface Verdict {
  badge: Badge
  /** The one-line reason of an errored or inactive badge. */
  reason?: string
  subLabels: SubLabel[]
}

export interface RuleVerdict extends Verdict {
  instances: Verdict[]
}

function instanceBadge(facts: InstanceFacts): Badge {
  if (facts.inactive !== undefined) return 'inactive'
  if (facts.active) return 'alertActive'
  if (facts.gates.some((g) => !g.holds)) return 'gatedOff'
  if (facts.input === 'unavailable') return 'inputUnavailable'
  if (facts.input === 'neverSeen') return 'neverSeen'
  const { progress } = facts
  if (progress?.kind === 'timer' && progress.toward === 'set') return 'timerRunning'
  return 'idle'
}

function subLabels(facts: InstanceFacts): SubLabel[] {
  const { progress } = facts
  const present: Record<SubLabel, boolean> = {
    gateInputUnavailable: facts.gates.some((g) => g.input === 'unavailable'),
    waitingForClear: facts.active && progress?.kind === 'timer' && progress.toward === 'clear',
    awaitingInput: facts.awaitingInput === true
  }
  return SUB_LABELS.filter((label) => present[label])
}

function verdict(facts: InstanceFacts, disabled: boolean): Verdict {
  const labels = subLabels(facts)
  if (disabled) return { badge: 'disabled', subLabels: labels }
  const badge = instanceBadge(facts)
  return badge === 'inactive'
    ? { badge, reason: facts.inactive?.reason, subLabels: labels }
    : { badge, subLabels: labels }
}

/**
 * The status badge and sub-labels of a rule and of each of its instances. A
 * disabled rule and each of its instances are disabled, and otherwise a rule
 * with an error errored; otherwise the rule takes the highest-ranking badge
 * among its instances, and a wildcard rule with no instance yet has never
 * seen its input. Its sub-labels are those of any instance.
 */
export function statusBadge(
  errors: readonly string[],
  instances: readonly InstanceFacts[],
  disabled = false
): RuleVerdict {
  const verdicts = instances.map((facts) => verdict(facts, disabled))
  const labels = new Set(verdicts.flatMap((v) => v.subLabels))
  const rule = { subLabels: SUB_LABELS.filter((l) => labels.has(l)), instances: verdicts }
  if (disabled) return { badge: 'disabled', ...rule }
  if (errors.length > 0) return { badge: 'errored', reason: errors[0], ...rule }
  const rank = (badge: Badge) => BADGES.indexOf(badge)
  const top = verdicts.reduce<Verdict | undefined>(
    (best, v) => (best === undefined || rank(v.badge) < rank(best.badge) ? v : best),
    undefined
  )
  if (top === undefined) return { badge: 'neverSeen', ...rule }
  const { subLabels: _labels, ...badge } = top
  return { ...badge, ...rule }
}
