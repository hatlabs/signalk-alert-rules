import { isInvalid, type ListedRule, type RuleInfo, type RuleStatus } from '../api'
import { isWildcard, ruleDisplay, type RuleDisplay } from '../rules/describe'
import type { UnitLookup } from '../signalUnits'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A time span in whole units, coarse enough to read at a glance. */
export function elapsed(ms: number): string {
  if (ms >= 2 * DAY) return `${String(Math.floor(ms / DAY))} d`
  if (ms >= 2 * HOUR) return `${String(Math.floor(ms / HOUR))} h`
  if (ms >= 2 * MINUTE) return `${String(Math.floor(ms / MINUTE))} min`
  return `${String(Math.max(0, Math.round(ms / SECOND)))} s`
}

const TIMEOUT_CAUSES: Readonly<
  Partial<Record<string, (status: Pick<RuleStatus, 'contract'>) => string>>
> = {
  booleanPath: () => 'An on/off value cannot time out',
  stringPath: () => 'A text value cannot time out',
  notEnforced: () => 'The server does not enforce timeouts',
  updateContract: (s) =>
    `The path updates ${s.contract ?? 'irregularly'}, not periodically, so it cannot time out`,
  timeoutOff: () => "The path's timeout is disabled",
  noTimeout: () => 'The path has no timeout and the server sets none'
}

/** A problem's sentence, without a closing full stop. */
export function problem(
  status: Pick<
    RuleStatus,
    'reason' | 'side' | 'level' | 'gate' | 'cause' | 'contract' | 'path' | 'units'
  >
): string {
  switch (status.reason) {
    case 'missingZone': {
      const zone = `${status.side === undefined ? '' : `${status.side} `}${status.level ?? ''} zone`
      const path =
        status.gate === undefined ? 'The path' : `The path of gate ${String(status.gate + 1)}`
      return `${path} has no ${zone}`
    }
    case 'timeoutNotPossible':
      return TIMEOUT_CAUSES[status.cause ?? '']?.(status) ?? 'The path cannot time out'
    case 'unitsNotRadians':
      return `${status.path ?? 'An input'} is in ${status.units ?? 'other units'}, not radians`
    case 'alertPathInvalid':
      return 'The alert path is not valid'
    case 'evaluationError':
      return 'The rule failed to evaluate'
    case 'invalidRule':
      return 'The stored rule is not valid'
    default:
      return 'The rule cannot run'
  }
}

const NEVER_REPORTED = 'No value since the plugin started'

function noData(status: RuleStatus, now: number): string {
  if (status.reason === 'notEvaluated') return 'Not evaluated yet'
  if (status.reason === 'inputUnavailable' && status.lastSeen !== undefined) {
    return `No value for ${elapsed(now - Date.parse(status.lastSeen))}`
  }
  return NEVER_REPORTED
}

/** The value, or the count or total toward the limit, as the rule shows it. */
export function reading(
  status: Pick<RuleStatus, 'progress' | 'value'>,
  display: RuleDisplay
): string | undefined {
  const { progress } = status
  if (progress?.kind === 'events') {
    return `${String(progress.count)} of ${String(progress.limit)} events`
  }
  if (progress?.kind === 'total') {
    return `${display.total(progress.total)} of ${display.total(progress.limit)}`
  }
  return status.value === undefined ? undefined : display.value(status.value)
}

/**
 * Detectors whose alert is not the value against a limit it passed: events or
 * a state, a rate of change (the limit is per second), or a value projected
 * to pass the limit later.
 */
export const NO_READING: ReadonlySet<string> = new Set([
  'match',
  'count',
  'absence',
  'slope',
  'projection'
])

/**
 * An alert as the boards word it: the reading against the limit it passed,
 * "11.6 V: below 11.8 V". The other detectors have no such reading, so their
 * alert message, which names its own instance, stands in. The priority has
 * its own tag.
 *
 * @param on the instance a wildcard rule's alert is on
 */
function alerting(status: RuleStatus, rule: RuleInfo, display: RuleDisplay, on?: string): string {
  const { value, limit } = status
  const { type, direction } = rule.detector
  const at = on === undefined ? '' : `${on} at `
  const shown = reading(status, display)
  let text: string
  if (NO_READING.has(type) || shown === undefined) {
    text = status.message ?? ''
  } else if (value !== undefined && limit !== undefined && direction !== undefined) {
    text = `${at}${shown}: ${direction} ${display.value(limit)}`
  } else {
    text = `${at}${shown}`
  }
  return status.awaitingInput === true ? `${text}. No new value since.` : text
}

/** What a disabled rule's condition is doing while it raises nothing. */
function disabledCondition(
  status: RuleStatus,
  display: RuleDisplay,
  now: number,
  on?: string
): string | undefined {
  if (status.condition === 'present') {
    const where = on === undefined ? '' : ` on ${on}`
    const value = reading(status, display)
    return `Condition still present${where}${value === undefined ? '' : `: ${value}`}`
  }
  if (status.condition !== 'normal' || status.reason !== 'withinLimits') return undefined
  if (status.clearedAt !== undefined) {
    return `Condition clear for ${elapsed(now - Date.parse(status.clearedAt))}`
  }
  if (status.clearSince !== undefined) {
    return `Condition clear for at least ${elapsed(now - Date.parse(status.clearSince))}`
  }
  return 'Condition clear'
}

/** The sentence for a condition other than an alert, as an enabled rule has it. */
function condition(status: RuleStatus, display: RuleDisplay, now: number): string {
  switch (status.condition) {
    case 'problem':
      return problem(status)
    case 'noData':
      return noData(status, now)
    default:
      if (status.reason === 'outsideGate') return 'Not watching now: a gate is closed'
      return reading(status, display) ?? ''
  }
}

/** Lower-cases the first letter, for a sentence that follows an instance's name. */
function continued(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

/**
 * One line of what a rule is doing now, as the list shows it under the
 * rule's name, worded from the reason code and facts the server sends.
 */
export function currentFact(entry: ListedRule, units: UnitLookup, now: number): string {
  if (isInvalid(entry)) return problem(entry.status)
  const { status, rule } = entry
  const display = ruleDisplay(rule, units)
  const disabled = status.ruleState === 'disabled'
  const wildcard = isWildcard(rule) || status.instances.length > 1
  if (wildcard && status.condition === 'normal' && !disabled) {
    const count = status.instances.length
    return `${String(count)} instance${count === 1 ? '' : 's'}`
  }
  // The instance a wildcard rule's condition comes from.
  const on =
    wildcard && status.instance !== undefined
      ? (status.instance.name ?? status.instance.segment)
      : undefined
  const whileDisabled = disabled ? disabledCondition(status, display, now, on) : undefined
  let sentence: string
  if (whileDisabled !== undefined) {
    sentence = whileDisabled
  } else if (status.condition === 'alerting') {
    sentence = alerting(status, rule, display, on)
  } else {
    const text = condition(status, display, now)
    sentence = on === undefined ? text : `${on}: ${continued(text)}`
  }
  const note = entry.disabled?.note
  return note === undefined ? sentence : `“${note}”. ${sentence}`
}
