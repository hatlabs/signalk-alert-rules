/**
 * The message and name a new rule is given until the user writes their own:
 * written from the value, the condition and the limits as they are typed.
 * One limit is written as typed, in the display unit; several are written as
 * `{limit}`, which the server fills in with the limit of the step reached.
 */
import { limitDirection, zoneLimitLevels, zonePath } from '../../engine/limits'
import type { Rule } from '../../model/rule'
import type { SignalValue } from '../api'
import { isWildcardPath, signalMeasure, type UnitLookup } from '../signalUnits'
import { kindOf } from './conditionKinds'
import {
  isZoneLimited,
  signalShape,
  slugify,
  stepQuantity,
  toRule,
  type EventForm,
  type RuleForm,
  type ToRuleResult
} from './formModel'
import { reachedStep } from './live'
import { durationText, stepLimitText, subjectOf, valueText } from './words'
import type { Measure } from '../signalUnits'

/** The placeholders the server fills in (docs/rules.md, Messages). */
export const PLACEHOLDERS = ['{value}', '{limit}', '{duration}', '{instance}'] as const

function eventVerb(event: EventForm, measure: Measure): string {
  switch (event.op) {
    case 'changes':
      return 'changed'
    case 'changesTo':
      return `changed to ${valueText(event.value, measure) ?? '…'}`
    case 'decreases':
      return 'decreased'
    case '':
      return '…'
  }
}

function limitOf(form: RuleForm, measure: Measure): string {
  const first = form.steps.at(0)
  if (form.steps.length !== 1 || first === undefined || isZoneLimited(form.detector)) {
    return '{limit}'
  }
  return stepLimitText(first, stepQuantity(form.detector), measure) ?? '{limit}'
}

/** The message written from the form; empty until a value and a condition are chosen. */
export function generatedMessage(form: RuleForm, units: UnitLookup): string {
  const subject = subjectOf(form.signal, units)
  const kind = kindOf(form.detector)
  if (subject === '' || kind === undefined) return ''
  const d = form.detector
  const measure = signalMeasure(signalShape(form.signal), units)
  const limit = limitOf(form, measure)
  const within = (text: string | undefined) => (text === undefined ? '' : ` within ${text}`)
  switch (kind) {
    case 'below':
    case 'above': {
      const held = durationText(d.duration)
      return `${subject} ${kind} ${limit}${held === undefined ? '' : ` for ${held}`}: {value}`
    }
    case 'outside': {
      // {limit} is the one limit passed, not the range, so only a typed range is written.
      const range = limit === '{limit}' ? '' : ` ${limit}`
      const held = durationText(d.duration)
      return `${subject} out of range${range}${held === undefined ? '' : ` for ${held}`}: {value}`
    }
    case 'rate':
      return `${subject} ${d.trend === '' ? 'changing' : d.trend} faster than ${limit}: {value}`
    case 'projection':
      return `${subject} ${d.trend === '' ? 'heading' : d.trend} to ${limit}${within(durationText(d.horizon))}: {value}`
    case 'silent':
      return `${subject} has stopped reporting`
    case 'state':
      switch (d.matchOp) {
        case 'notEquals':
          return `${subject} is not ${limit}`
        case 'changesTo':
          return `${subject} changed to ${limit}`
        case 'decreases':
          return `${subject} decreased`
        default:
          return `${subject} is ${limit}`
      }
    case 'often': {
      const window = durationText(d.window)
      return `${subject} ${eventVerb(d.event, measure)} more than ${limit} times${window === undefined ? '' : ` in ${window}`}`
    }
    case 'total':
      return `${subject} total reached ${limit}`
    case 'missing':
      return `${subject} has not ${eventVerb(d.event, measure)} for ${limit}`
  }
}

/** A message Save replaces with the written one: empty, or only spaces, which `toRule` refuses. */
export function isEmptyMessage(message: string): boolean {
  return message.trim() === ''
}

/**
 * The rule Save stores: as `toRule` reads it, with an empty message as the
 * one written from the rule, as the Message field's placeholder shows it.
 * Still asks for a message while none can be written.
 */
export function toSavedRule(form: RuleForm, units: UnitLookup): ToRuleResult {
  const message = isEmptyMessage(form.message) ? generatedMessage(form, units) : form.message
  return toRule({ ...form, message }, units)
}

/**
 * Whether {@link previewLimit} resolves the rule's limit, so an unfilled
 * `{limit}` stays as written: a sustained or projection zone limit, or a
 * range's bound.
 */
export function previewResolvesLimit(rule: Rule): boolean {
  const d = rule.detector
  if (d.type === 'outside') return true
  return (d.type === 'sustained' || d.type === 'projection') && d.limit?.kind === 'zone'
}

/**
 * The SI limit the server would fill `{limit}` in with were the rule to alert
 * now, where the reached step does not hold it: for a zone limit, the bound
 * of the severest level the value is past among those the evaluator builds
 * from the zone path's zones, else the named level's; for a range the bound
 * of the step the value reaches, else the nearer bound of the first (the high
 * one midway, by SI distance). Undefined for a typed limit, which the reached
 * step holds, and where the editor cannot know it: zones not known, no single
 * zone path, or for a range no value now.
 */
export function previewLimit(
  form: RuleForm,
  rule: Rule,
  value: SignalValue | undefined,
  measure: Measure,
  live: UnitLookup
): number | undefined {
  const d = rule.detector
  if ((d.type === 'sustained' || d.type === 'projection') && d.limit?.kind === 'zone') {
    // Units come only with a single signal, so a combined one's bound would read bare.
    if ('combinator' in rule.signal) return undefined
    const path = zonePath(d.limit, rule.signal)
    if (path === undefined || isWildcardPath(path)) return undefined
    const resolved = zoneLimitLevels(d, d.limit, live.entry(path)?.zones)
    if (!resolved.ok) return undefined
    const bounds = resolved.levels.map((l) => l.value)
    const named = bounds[0]
    if (typeof value !== 'number') return named
    const direction = limitDirection(d)
    const past = (bound: number) => (direction === 'below' ? value < bound : value > bound)
    return bounds.filter(past).at(-1) ?? named
  }
  if (d.type !== 'outside' || typeof value !== 'number') return undefined
  const reached = reachedStep(form, value, measure)
  if (reached === undefined) return undefined
  const step = d.steps.at(Math.max(reached, 0))
  if (step === undefined) return undefined
  if (reached >= 0) return value > step.high ? step.high : step.low
  return value - step.low < step.high - value ? step.low : step.high
}

const NAME_WORDS: Readonly<Record<string, string>> = {
  below: 'low',
  above: 'high',
  outside: 'out of range',
  silent: 'not reporting',
  often: 'changing often',
  total: 'total reached',
  missing: 'missing'
}

/** The name written from the form; empty until a value and a condition are chosen. */
export function generatedName(form: RuleForm, units: UnitLookup): string {
  const subject = subjectOf(form.signal, units)
  const kind = kindOf(form.detector)
  if (subject === '' || kind === undefined) return ''
  const d = form.detector
  const measure = signalMeasure(signalShape(form.signal), units)
  switch (kind) {
    case 'rate':
      return `${subject} ${d.trend === '' ? 'changing' : d.trend} fast`
    case 'projection':
      return `${subject} ${d.trend === 'rising' ? 'rising' : 'falling'} to a limit`
    case 'state': {
      const first = form.steps.at(0)
      const value = first === undefined ? undefined : valueText(first.value, measure)
      return value === undefined ? `${subject} state` : `${subject} ${value}`
    }
    default:
      return `${subject} ${NAME_WORDS[kind] ?? ''}`
  }
}

/**
 * The form with its message, name and slug written afresh, each only while
 * it still follows the rule; the same form when none does.
 */
export function withGenerated(form: RuleForm, units: UnitLookup): RuleForm {
  if (!form.messageFollows && !form.nameFollows && !form.slugFollowsName) return form
  const name = form.nameFollows ? generatedName(form, units) : form.name
  return {
    ...form,
    name,
    ...(form.slugFollowsName ? { slug: slugify(name) } : {}),
    ...(form.messageFollows ? { message: generatedMessage(form, units) } : {})
  }
}

/**
 * Brace text the server sends as written: braces around anything but a
 * placeholder, and a placeholder after `$`, which reads as a template
 * literal but is filled in with the `$` left in front.
 */
export function strayBraces(message: string): string[] {
  const placeholders: readonly string[] = PLACEHOLDERS
  return [...message.matchAll(/\$?\{[^{}]*\}/g)]
    .map((m) => m[0])
    .filter((text) => text.startsWith('$') || !placeholders.includes(text))
}
