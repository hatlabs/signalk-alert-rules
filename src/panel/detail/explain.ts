import type { InstanceStatus, RuleEntry, RuleInfo, RuleStatus } from '../api'
import { elapsed, problem, reading } from '../list/fact'
import { isWildcard, plural, ruleDisplay, type RuleDisplay } from '../rules/describe'
import { instanceSegment, type UnitLookup } from '../signalUnits'

/** A piece of an explanation; the emphasised pieces carry what the operator scans for. */
export type Part = string | { strong: string }
export type Sentence = Part[]

const strong = (text: string): Part => ({ strong: text })

const MINUTE = 60_000

export function sentenceText(sentence: Sentence): string {
  return sentence.map((p) => (typeof p === 'string' ? p : p.strong)).join('')
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** `coolantTemperature` as "coolant temperature". */
function words(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

/** "a" or "an", for the priority names. */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
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
  const parts = path.split('.')
  const at = instanceSegment(path)
  const which = instance ?? (at === undefined || parts[at] === '*' ? undefined : parts[at])
  const leaf = words(parts.at(-1) ?? '')
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
  | 'gate'
  | 'cause'
  | 'contract'
  | 'path'
  | 'units'
>

/** The value against the limit it passed, which only a sustained rule reads as such. */
function passedLimit(facts: Facts, rule: RuleInfo, display: RuleDisplay) {
  const { direction, type } = rule.detector
  const { value, limit } = facts
  if (type !== 'sustained' || direction === undefined) return undefined
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
    let reached: Sentence
    if (step > 0 && first?.limit !== undefined && facts.priority !== undefined) {
      reached = [
        `${subject} has been `,
        strong(`${direction} ${display.value(first.limit)} for ${since}`),
        ' and went ',
        strong(`${direction} ${limit}`),
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

function noData(facts: Facts, subject: string, now: number): Sentence {
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
  const wildcard = isWildcard(rule) || status.instances.length > 1
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
      return noData(status, subject, now)
    case 'normal':
      if (status.reason === 'outsideGate') return ['Not watching now: a gate is closed.']
      return withinLimits(status, display, disabled, now)
  }
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
      if (i.reason === 'notEvaluated') return 'Not evaluated yet'
      if (i.reason === 'inputUnavailable' && i.lastSeen !== undefined) {
        return `No value for ${elapsed(now - Date.parse(i.lastSeen))}`
      }
      return 'No value since the plugin started'
    default: {
      if (i.reason === 'outsideGate') return 'Not watching: a gate is closed'
      const value = reading(i, display)
      // A count or total already reads against its limit.
      const limit =
        i.progress === undefined && i.limit !== undefined && rule.detector.type !== 'match'
          ? `limit ${display.value(i.limit)}`
          : undefined
      return [value, limit].filter((part) => part !== undefined).join(', ')
    }
  }
}
