import type { Progress } from '../engine/detectors/index.js'
import type { InputState } from '../engine/signals.js'

/** The closed status list, most important first; disabled and suppressed join it above errored. */
export const BADGES = [
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
  inactive?: string
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

/**
 * The status badge and sub-labels of a rule and of each of its instances. A
 * rule with an error is errored; otherwise it takes the highest-precedence
 * badge among its instances, and a wildcard rule with no instance yet has
 * never seen its input. Its sub-labels are those of any instance.
 */
export function statusBadge(
  errors: readonly string[],
  instances: readonly InstanceFacts[]
): RuleVerdict {
  const verdicts = instances.map((facts): Verdict => {
    const badge = instanceBadge(facts)
    return badge === 'inactive'
      ? { badge, reason: facts.inactive, subLabels: subLabels(facts) }
      : { badge, subLabels: subLabels(facts) }
  })
  const labels = new Set(verdicts.flatMap((v) => v.subLabels))
  const rule = { subLabels: SUB_LABELS.filter((l) => labels.has(l)), instances: verdicts }
  if (errors.length > 0) return { badge: 'errored', reason: errors[0], ...rule }
  const top = verdicts.reduce<Verdict | undefined>(
    (best, v) =>
      best === undefined || BADGES.indexOf(v.badge) < BADGES.indexOf(best.badge) ? v : best,
    undefined
  )
  if (top === undefined) return { badge: 'neverSeen', ...rule }
  return top.reason === undefined
    ? { badge: top.badge, ...rule }
    : { badge: top.badge, reason: top.reason, ...rule }
}
