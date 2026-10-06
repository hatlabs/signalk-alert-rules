import type { InstanceStatus, RuleEntry, RuleInfo, RuleStatus } from '../api'
import { leafWords } from '../editor/words'
import { elapsed, MINUTE, noData, problem, reading } from '../list/fact'
import { capitalised } from '../list/PriorityBadge'
import {
  article,
  hasInstances,
  passedSide,
  plural,
  ruleDisplay,
  stepCondition,
  type RuleDisplay
} from '../rules/describe'
import { baseSegments, instanceSegment, type UnitLookup } from '../signalUnits'

/** A piece of an explanation; the emphasised pieces carry what the operator scans for. */
export type Part = string | { strong: string }
export type Sentence = Part[]

const strong = (text: string): Part => ({ strong: text })

export function sentenceText(sentence: Sentence): string {
  return sentence.map((p) => (typeof p === 'string' ? p : p.strong)).join('')
}

/**
 * What the rule watches, as a sentence's subject: the path's display name when
 * the server gives one, otherwise its instance and leaf in words, "House
 * voltage" for `electrical.batteries.house.voltage`.
 *
 * @param instance the instance of a wildcard rule the sentence is about
 */
function subjectOf(rule: RuleInfo, units: UnitLookup, instance?: string): string {
  if (rule.signal.combinator !== undefined) return 'The combined value'
  const path = rule.signal.paths[0] ?? ''
  const named = path.includes('*') ? undefined : units.entry(path)?.displayName
  if (named !== undefined) return named
  const parts = baseSegments(path)
  const at = instanceSegment(path)
  const which = instance ?? (at === undefined || parts[at] === '*' ? undefined : parts[at])
  const leaf = leafWords(path)
  return capitalised(which === undefined ? leaf : `${which} ${leaf}`)
}

type Facts = Pick<
  RuleStatus,
  | 'condition'
  | 'reason'
  | 'value'
  | 'limit'
  | 'progress'
  | 'step'
  | 'priority'
  | 'level'
  | 'message'
  | 'awaitingInput'
  | 'clearedAt'
  | 'clearSince'
  | 'lastSeen'
  | 'side'
  | 'passed'
  | 'gate'
  | 'cause'
  | 'contract'
  | 'path'
  | 'units'
>

/** The value against the limit it passed, which only a sustained or outside rule reads as such. */
function passedLimit(facts: Facts, rule: RuleInfo, display: RuleDisplay) {
  const direction = passedSide(rule, facts.passed)
  const { value, limit } = facts
  if (direction === undefined) return undefined
  if (typeof value !== 'number' || limit === undefined) return undefined
  return { direction, value: display.value(value), limit: display.value(limit) }
}

function alerting(
  facts: Facts,
  rule: RuleInfo,
  display: RuleDisplay,
  subject: string,
  since: string
): Sentence {
  const passed = passedLimit(facts, rule, display)
  const step = facts.step ?? 0
  const first = rule.steps.at(0)
  let sentence: Sentence
  if (passed === undefined) {
    const now = reading(facts, display)
    sentence = [
      strong(facts.message ?? 'The condition holds'),
      `. Alerting for ${since}.`,
      ...(now === undefined ? [] : [' Now ', strong(now), '.'])
    ]
  } else {
    const { direction, value, limit } = passed
    const went: Sentence = [' and went ', strong(`${direction} ${limit}`)]
    // A zone-limit rule has no steps of its own, so its first condition is the level's.
    const held = first === undefined ? undefined : stepCondition(first, rule, display)
    let reached: Sentence
    if (step > 0 && first !== undefined && held !== undefined && facts.priority !== undefined) {
      reached = [
        `${subject} has been `,
        strong(`${held} for ${since}`),
        ...went,
        `, so the ${first.priority} became ${article(facts.priority)} `,
        strong(facts.priority),
        '.'
      ]
    } else if (step > 0 && facts.level !== undefined) {
      reached = [
        `${subject} reached the ${facts.level} zone at `,
        strong(limit),
        `. Alerting for ${since}.`
      ]
    } else if (rule.detector.type === 'outside' && held !== undefined) {
      // The range, not the limit passed, is what held: the value may have crossed it.
      reached = [`${subject} has been `, strong(`${held} for ${since}`), ...went, '.']
    } else {
      reached = [`${subject} has been `, strong(`${direction} ${limit} for ${since}`), '.']
    }
    sentence = [...reached, ' Now ', strong(value), '.']
  }
  return facts.awaitingInput === true ? [...sentence, ' No new value since.'] : sentence
}

/**
 * @param since how long the condition has held at least; undefined under a
 *   minute, when it would only count up from 0 s
 */
function present(
  facts: Facts,
  rule: RuleInfo,
  display: RuleDisplay,
  since: string | undefined,
  on: string | undefined
): Sentence {
  const where = on === undefined ? '' : ` on ${on}`
  const passed = passedLimit(facts, rule, display)
  if (passed !== undefined) {
    const held = since === undefined ? '' : ` for at least ${since}`
    return [
      `Condition still present${where}: `,
      strong(`${passed.direction} ${passed.limit}${held}`),
      `, now ${passed.value}.`
    ]
  }
  const now = reading(facts, display)
  return [`Condition still present${where}`, now === undefined ? '.' : `: now ${now}.`]
}

function withinLimits(facts: Facts, display: RuleDisplay, disabled: boolean, now: number) {
  const value = reading(facts, display)
  const current: Sentence = value === undefined ? [] : [' Now ', strong(value), '.']
  if (!disabled) return ['Within limits.', ...current]
  if (facts.clearedAt !== undefined) {
    const ago = elapsed(now - Date.parse(facts.clearedAt))
    return ['Condition cleared ', strong(`${ago} ago`), '.', ...current]
  }
  if (facts.clearSince !== undefined) {
    const span = elapsed(now - Date.parse(facts.clearSince))
    return ['Condition clear for at least ', strong(span), '.', ...current]
  }
  return ['Waiting for a reading to tell whether the condition is present.']
}

function notReported(facts: Facts, subject: string, now: number): Sentence {
  if (facts.reason === 'notEvaluated') return ['Not evaluated yet: the plugin is starting.']
  if (facts.reason === 'inputUnavailable' && facts.lastSeen !== undefined) {
    return [
      `${subject} has not reported for `,
      strong(elapsed(now - Date.parse(facts.lastSeen))),
      '.'
    ]
  }
  return [`${subject} has not reported since the plugin started.`]
}

/**
 * The detail's one-sentence explanation of a rule's state, worded from the
 * reason code and facts the server sends, with values in display units.
 *
 * @param now the time ages are counted to, in ms since the epoch
 */
export function explain(entry: RuleEntry, units: UnitLookup, now: number): Sentence {
  const { rule, status } = entry
  const display = ruleDisplay(rule, units)
  const disabled = status.ruleState === 'disabled'
  const wildcard = hasInstances(entry)
  const allWell = status.condition === 'normal' && status.reason === 'withinLimits'
  if (wildcard && !disabled && allWell) {
    const count = status.instances.length
    return [
      count === 1
        ? '1 instance is within limits.'
        : `All ${plural(count, 'instance')} are within limits.`
    ]
  }
  const on = wildcard ? (status.instance?.name ?? status.instance?.segment) : undefined
  const subject = subjectOf(rule, units, on)
  const held = now - Date.parse(status.changedAt)
  const since = elapsed(held)
  switch (status.condition) {
    case 'alerting':
      return alerting(status, rule, display, subject, since)
    case 'present':
      return present(status, rule, display, held < MINUTE ? undefined : since, on)
    case 'problem':
      return [`${problem(status)}.`]
    case 'noData':
      return notReported(status, subject, now)
    case 'normal':
      if (status.reason === 'outsideGate') return ['Not watching now: a gate is closed.']
      return withinLimits(status, display, disabled, now)
  }
}

function limitInForce(i: InstanceStatus, rule: RuleInfo, display: RuleDisplay) {
  if (i.limit === undefined) return undefined
  // An outside rule's limit is one of two, so it means something only with the side passed.
  if (rule.detector.type === 'outside') {
    const side = passedSide(rule, i.passed)
    return side === undefined ? undefined : `${side} ${display.value(i.limit)}`
  }
  // A count or total already reads against its limit.
  if (i.progress !== undefined || rule.detector.type === 'match') return undefined
  return `limit ${display.value(i.limit)}`
}

/** One instance's line in the detail's instance list: its value, or why it has none. */
export function instanceFact(
  i: InstanceStatus,
  rule: RuleInfo,
  display: RuleDisplay,
  now: number
): string {
  switch (i.condition) {
    case 'problem':
      return problem(i)
    case 'noData':
      return noData(i, now)
    default: {
      if (i.reason === 'outsideGate') return 'Not watching: a gate is closed'
      const value = reading(i, display)
      const limit = limitInForce(i, rule, display)
      return [value, limit].filter((part) => part !== undefined).join(', ')
    }
  }
}
