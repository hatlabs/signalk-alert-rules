import type { Progress, Side } from '../engine/detectors/index.js'
import type { GateStatus, Judgement, Problem } from '../engine/evaluator.js'
import type { InputState, SignalValue } from '../engine/signals.js'
import type { Priority, ZoneLevel } from '../model/rule.js'

/** Whether a rule raises alerts; a disabled rule keeps evaluating but raises nothing. */
export type RuleState = 'enabled' | 'disabled'

/**
 * The condition of a rule or an instance, worst first: the order a wildcard
 * rule takes its worst instance's in. `present` is a disabled rule's
 * counterpart of `alerting`: its condition holds, but it raises nothing.
 */
export const CONDITIONS = ['alerting', 'present', 'problem', 'noData', 'normal'] as const
export type Condition = (typeof CONDITIONS)[number]

/**
 * A condition with its reason code and the facts the webapp words its
 * explanation from. The server sends no prose: every variant is a code plus
 * structured facts.
 */
export type ConditionState =
  | {
      condition: 'alerting'
      reason: 'alertActive'
      priority: Priority
      /** The furthest step the alert has reached, an index into the rule's steps. */
      step: number
      /** The zone level of that step, for a zone-limit rule. */
      level?: ZoneLevel
      /** Which of an outside rule's limits the value last went past: the one `limit` names. */
      passed?: Side
      /** The input has stopped reporting, so the alert is not repeated. */
      awaitingInput: boolean
      /** The alert's message as SKAR last sent it, or as it reads now before its first emission. */
      message?: string
    }
  | { condition: 'present'; reason: 'conditionPresent' }
  | {
      condition: 'normal'
      reason: 'withinLimits'
      /** When the condition last stopped holding. */
      clearedAt?: string
      /**
       * For a disabled rule whose condition has not held since the rule
       * started evaluating, at this time: when it held before is not known.
       */
      clearSince?: string
    }
  | { condition: 'normal'; reason: 'outsideGate' }
  | { condition: 'noData'; reason: 'neverReported' }
  | {
      condition: 'noData'
      reason: 'inputUnavailable'
      /** When the input last had a value; absent when it has had none since start. */
      lastSeen?: string
    }
  /** The plugin has not started evaluating the rule. */
  | { condition: 'noData'; reason: 'notEvaluated' }
  | ({ condition: 'problem' } & Problem)
  /** The rule's evaluation failed; the rule's errors say how. */
  | { condition: 'problem'; reason: 'evaluationError' }
  /** A stored rule file that does not load; its entry carries the errors. */
  | { condition: 'problem'; reason: 'invalidRule' }

/** A total or an event count; a timer toward a transition is not reported. */
export type Count = Exclude<Progress, { kind: 'timer' }>

/** What an instance reports whatever its condition. */
export interface LiveFacts {
  /** For a wildcard rule; a rule that is not evaluated keeps only the segment. */
  instance?: { name?: string; segment: string }
  /** The input's value in SI units, while it has one. */
  value?: SignalValue
  /** The limit in force in SI units: the reached step's while alerting, else the first step's. */
  limit?: number
  progress?: Count
  /** One per gate of the rule, in its order. */
  gates: GateStatus[]
}

export type InstanceState = ConditionState & LiveFacts

/** A rule's condition: its worst instance's state, or a rule-wide one. */
export type RuleCondition = ConditionState & Partial<LiveFacts>

/**
 * A rule's state on its two axes, whether it is enabled and its condition,
 * with the condition's reason and facts and each instance's state.
 */
export type RuleStateReport = RuleCondition & {
  ruleState: RuleState
  /** When the rule state or the condition last changed. */
  changedAt: string
  /** Conditions that do not stop the rule, such as a rejected wildcard instance; diagnostic text. */
  issues: string[]
  /** Failures that make the rule a problem, such as an evaluation that threw; diagnostic text. */
  errors: string[]
  instances: InstanceState[]
}

export function ruleStateOf(disabled: boolean): RuleState {
  return disabled ? 'disabled' : 'enabled'
}

/** A rule's state report, whether the rule is evaluated or not. */
export function stateReport(
  disabled: boolean,
  condition: RuleCondition,
  changedAt: string,
  details: Partial<Pick<RuleStateReport, 'issues' | 'errors' | 'instances'>> = {}
): RuleStateReport {
  return {
    ruleState: ruleStateOf(disabled),
    ...condition,
    changedAt,
    issues: details.issues ?? [],
    errors: details.errors ?? [],
    instances: details.instances ?? []
  }
}

/** What the state of one instance depends on, with times as ISO strings. */
export interface InstanceFacts {
  instance?: { name?: string; segment: string }
  judgement: Judgement
  gates: GateStatus[]
  value?: SignalValue
  limit?: number
  passed?: Side
  progress?: Progress
  clearedAt?: string
  lastSeen?: string
  awaitingInput: boolean
  /** The active alert's message as last sent, or as it reads now before its first emission. */
  message?: string
}

function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, T>>)
}

/** An instance's condition with what decided it. */
type Classified =
  | { condition: 'problem'; problem: Problem }
  | { condition: 'alerting'; alert: NonNullable<Judgement['alert']> }
  | { condition: 'normal'; outsideGate: boolean }
  | { condition: 'present' }
  | { condition: 'noData'; input: Exclude<InputState, 'value'> }

/**
 * A disabled rule never alerts; its condition is present instead. Outside
 * its gate an instance is normal whatever its condition did before: a gate
 * closing is not the condition clearing, and what holds then is not judged.
 */
function classify(judgement: Judgement, disabled: boolean): Classified {
  const { problem, alert, input } = judgement
  if (problem !== undefined) return { condition: 'problem', problem }
  if (alert !== undefined && !disabled) return { condition: 'alerting', alert }
  if (!judgement.gatesHold) return { condition: 'normal', outsideGate: true }
  if (disabled && judgement.present) return { condition: 'present' }
  return input === 'value'
    ? { condition: 'normal', outsideGate: false }
    : { condition: 'noData', input }
}

/** An instance's condition, as both the timing of a change and its state judge it. */
export function conditionOf(judgement: Judgement, disabled: boolean): Condition {
  return classify(judgement, disabled).condition
}

function conditionState(facts: InstanceFacts, disabled: boolean, started: string): ConditionState {
  const classified = classify(facts.judgement, disabled)
  switch (classified.condition) {
    case 'problem':
      return { condition: 'problem', ...classified.problem }
    case 'alerting':
      return {
        condition: 'alerting',
        reason: 'alertActive',
        ...classified.alert,
        ...optional('passed', facts.passed),
        awaitingInput: facts.awaitingInput,
        ...optional('message', facts.message)
      }
    case 'present':
      return { condition: 'present', reason: 'conditionPresent' }
    case 'noData':
      return classified.input === 'unavailable'
        ? {
            condition: 'noData',
            reason: 'inputUnavailable',
            ...optional('lastSeen', facts.lastSeen)
          }
        : { condition: 'noData', reason: 'neverReported' }
    case 'normal':
      if (classified.outsideGate) return { condition: 'normal', reason: 'outsideGate' }
      if (facts.clearedAt !== undefined) {
        return { condition: 'normal', reason: 'withinLimits', clearedAt: facts.clearedAt }
      }
      return disabled && !facts.judgement.undecided
        ? { condition: 'normal', reason: 'withinLimits', clearSince: started }
        : { condition: 'normal', reason: 'withinLimits' }
  }
}

/**
 * The state of one instance: its condition, as {@link conditionOf} judges
 * it, with the reason and facts that go with it.
 *
 * @param started when the rule started evaluating, the earliest a disabled
 *   rule's condition is known to have been clear.
 */
export function instanceState(
  facts: InstanceFacts,
  disabled: boolean,
  started: string
): InstanceState {
  const { progress } = facts
  return {
    ...optional('instance', facts.instance),
    ...conditionState(facts, disabled, started),
    ...optional('value', facts.value),
    ...optional('limit', facts.limit),
    ...optional('progress', progress?.kind === 'timer' ? undefined : progress),
    gates: facts.gates
  }
}

/** A rule's condition when no single instance gives it. */
export type RuleWide =
  | { condition: 'problem'; reason: 'evaluationError' }
  | { condition: 'noData'; reason: 'neverReported' }

/**
 * A rule's condition. An evaluation error makes it a problem whatever its
 * instances report, as a failing evaluation leaves none of them current, an
 * active alert included. Otherwise it is its worst instance's, the first of
 * equals, and a wildcard rule with no instance yet has had no data.
 */
export function ruleCondition<T extends { condition: Condition }>(
  failing: boolean,
  instances: readonly T[]
): T | RuleWide {
  if (failing) return { condition: 'problem', reason: 'evaluationError' }
  let worst: T | undefined
  for (const instance of instances) {
    if (
      worst === undefined ||
      CONDITIONS.indexOf(instance.condition) < CONDITIONS.indexOf(worst.condition)
    ) {
      worst = instance
    }
  }
  return worst ?? { condition: 'noData', reason: 'neverReported' }
}
