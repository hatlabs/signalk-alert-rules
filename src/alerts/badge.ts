import type { Progress } from '../engine/detectors/index.js'
import type { InputState } from '../engine/signals.js'
import type { SuppressionScope } from '../engine/suppression.js'

/**
 * The closed status list, most important first. `disabled` is the status of
 * a rule that is not evaluated, which this module never derives.
 */
export const BADGES = [
  'disabled',
  'suppressed',
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
  suppression?: SuppressionScope
}

export interface Verdict {
  badge: Badge
  /** The one-line reason of a disabled, errored or inactive badge. */
  reason?: string
  /** What a suppressed badge's suppression comes from. */
  suppression?: SuppressionScope
  subLabels: SubLabel[]
}

export interface RuleVerdict extends Verdict {
  instances: Verdict[]
}

function instanceBadge(facts: InstanceFacts): Badge {
  if (facts.suppression !== undefined) return 'suppressed'
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
    // A suppression that ends by itself waits for the condition to stay clear.
    waitingForClear:
      facts.suppression?.autoEndAfter !== undefined ||
      (facts.active && progress?.kind === 'timer' && progress.toward === 'clear'),
    awaitingInput: facts.awaitingInput === true
  }
  return SUB_LABELS.filter((label) => present[label])
}

function verdict(facts: InstanceFacts): Verdict {
  const badge = instanceBadge(facts)
  const labels = subLabels(facts)
  switch (badge) {
    case 'suppressed':
      return { badge, suppression: facts.suppression, subLabels: labels }
    case 'inactive':
      return { badge, reason: facts.inactive, subLabels: labels }
    default:
      return { badge, subLabels: labels }
  }
}

/**
 * An instance's rank toward its rule's badge. An instance suppressed through
 * its input ranks just below an active alert, so a suppressed faulty sender
 * hides neither another instance's alert nor anything more important.
 */
function rank(badge: Badge): number {
  return badge === 'suppressed' ? BADGES.indexOf('alertActive') + 0.5 : BADGES.indexOf(badge)
}

/**
 * The status badge and sub-labels of a rule and of each of its instances. A
 * suppressed rule is suppressed, and otherwise a rule with an error errored;
 * otherwise the rule takes the highest-ranking badge among its instances, and
 * a wildcard rule with no instance yet has never seen its input. Its
 * sub-labels are those of any instance, or of its own suppression.
 */
export function statusBadge(
  errors: readonly string[],
  instances: readonly InstanceFacts[],
  suppression?: SuppressionScope
): RuleVerdict {
  const verdicts = instances.map(verdict)
  const labels = new Set(verdicts.flatMap((v) => v.subLabels))
  if (suppression?.autoEndAfter !== undefined) labels.add('waitingForClear')
  const rule = { subLabels: SUB_LABELS.filter((l) => labels.has(l)), instances: verdicts }
  if (suppression !== undefined) return { badge: 'suppressed', suppression, ...rule }
  if (errors.length > 0) return { badge: 'errored', reason: errors[0], ...rule }
  const top = verdicts.reduce<Verdict | undefined>(
    (best, v) => (best === undefined || rank(v.badge) < rank(best.badge) ? v : best),
    undefined
  )
  if (top === undefined) return { badge: 'neverSeen', ...rule }
  const { subLabels: _labels, ...badge } = top
  return { ...badge, ...rule }
}
