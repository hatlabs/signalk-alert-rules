/**
 * The message and name a new rule is given until the user writes their own:
 * written from the value, the condition and the limits as they are typed.
 * One limit is written as typed, in the display unit; several are written as
 * `{limit}`, which the server fills in with the limit of the step reached.
 */
import { signalMeasure, type UnitLookup } from '../signalUnits'
import { kindOf } from './conditionKinds'
import {
  isZoneLimited,
  signalShape,
  slugify,
  stepQuantity,
  type EventForm,
  type RuleForm
} from './formModel'
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

const NAME_WORDS: Readonly<Record<string, string>> = {
  below: 'low',
  above: 'high',
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
