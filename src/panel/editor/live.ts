/**
 * What the editor says next to the limits: what the chosen priority means,
 * how the steps climb, and whether the value now would alert.
 */
import { formatNumber } from '../../format'
import type { Priority } from '../../model/rule'
import type { SignalValue } from '../api'
import {
  article,
  clearPoint,
  formatValue,
  OPPOSITE_SIDE,
  type BackInRange,
  type BackPastLimit,
  type ClearPoint
} from '../rules/describe'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { fromSI, toSI } from '../units'
import { kindOf } from './conditionKinds'
import {
  DURATION_FACTORS,
  isZoneLimited,
  parsedNumber,
  signalShape,
  stepQuantity,
  type DurationField,
  type RuleForm,
  type StepForm
} from './formModel'
import { durationText, rangeLimitText, stepLimitText, stepWord } from './words'

/**
 * The priorities as the IMO alert management resolutions behind the Signal
 * K alerts API define them (SignalK/signalk-server issue 1857): what each
 * means, whether it must be acknowledged, and how it sounds.
 */
const PRIORITY_MEANINGS: Readonly<Record<Priority, string>> = {
  emergency:
    'immediate danger to life or the boat; act at once. Must be acknowledged; sounds until acknowledged.',
  alarm: 'needs immediate attention. Must be acknowledged; sounds until acknowledged.',
  warning: 'requires attention for precautionary reasons. Must be acknowledged; sounds briefly.',
  caution:
    'requires attention, not immediately hazardous. Needs no acknowledgement; makes no sound.'
}

export function priorityMeaning(priority: Priority): string {
  return PRIORITY_MEANINGS[priority]
}

function siValue(text: string, measure: Measure): number | undefined {
  const value = parsedNumber(text)
  return value === undefined ? undefined : toSI(measure.kind, value, measure.unit)
}

/**
 * The furthest step the value holds at: -1 for none, undefined where the
 * editor cannot tell, as for a trend, which needs history.
 */
function reachedStep(form: RuleForm, value: SignalValue, measure: Measure): number | undefined {
  const kind = kindOf(form.detector)
  const holds = (step: StepForm): boolean | undefined => {
    if (kind === 'below' || kind === 'above') {
      const limit = siValue(step.limit, measure)
      if (limit === undefined || typeof value !== 'number') return undefined
      return kind === 'below' ? value < limit : value > limit
    }
    if (kind === 'outside') {
      const [low, high] = [siValue(step.low, measure), siValue(step.high, measure)]
      if (low === undefined || high === undefined || typeof value !== 'number') return undefined
      return value < low || value > high
    }
    if (kind === 'state' && form.detector.matchOp === 'equals') {
      const { value: wanted } = step
      if (wanted.type === 'true' || wanted.type === 'false')
        return value === (wanted.type === 'true')
      if (wanted.type === 'text') return value === wanted.text
      const limit = siValue(wanted.text, measure)
      return limit === undefined ? undefined : value === limit
    }
    return undefined
  }
  if (isZoneLimited(form.detector)) return undefined
  const results = form.steps.map(holds)
  if (results.some((r) => r === undefined)) return undefined
  return results.lastIndexOf(true)
}

/** The value now and whether it would alert, as far as the editor can tell. */
export function nowText(
  form: RuleForm,
  value: SignalValue | undefined,
  units: UnitLookup
): string | undefined {
  if (value === undefined) return undefined
  const measure = signalMeasure(signalShape(form.signal), units)
  const now = `Now ${formatValue(value, measure)}`
  const reached = reachedStep(form, value, measure)
  if (reached === undefined) return `${now}.`
  const priority = reached < 0 ? undefined : form.steps.at(reached)?.priority
  if (priority === undefined || priority === '') return `${now}: would not alert.`
  const passed = passedText(form, reached, value, measure)
  return `${now}: would alert as ${article(priority)} ${priority}${passed === undefined ? '' : ` (${passed})`}.`
}

/** For a range, the side of step `index` the value is past, and its limit: "above 25 °". */
function passedText(
  form: RuleForm,
  index: number,
  value: SignalValue,
  measure: Measure
): string | undefined {
  const step = form.steps.at(index)
  if (kindOf(form.detector) !== 'outside' || step === undefined || typeof value !== 'number') {
    return undefined
  }
  const low = siValue(step.low, measure)
  const side = low !== undefined && value < low ? 'low' : 'high'
  const limit = rangeLimitText(step, side, measure)
  return limit === undefined ? undefined : `${side === 'low' ? 'below' : 'above'} ${limit}`
}

/** A typed duration in seconds; undefined while empty or not a number. */
function durationSeconds(field: DurationField): number | undefined {
  const amount = parsedNumber(field.amount)
  return amount === undefined ? undefined : amount * DURATION_FACTORS[field.unit]
}

/**
 * Where the value must be back for the alert to clear, as typed for the
 * first step: past it by the clear margin, for the clear delay.
 */
function clearsText(form: RuleForm, measure: Measure): string | undefined {
  const first = form.steps.at(0)
  if (first === undefined) return undefined
  const kind = kindOf(form.detector)
  const typedMargin = parsedNumber(form.detector.hysteresis)
  const margin =
    typedMargin === undefined
      ? undefined
      : toSI(measure.kind === 'ratio' ? 'ratio' : 'interval', typedMargin, measure.unit)
  const delay = durationSeconds(form.detector.clearDuration)
  const shown = (si: number) => formatNumber(fromSI(measure.kind, si, measure.unit))
  const worded = (clear: ClearPoint<BackPastLimit | BackInRange>, where: string) =>
    clear.eased
      ? `once back ${where}${clear.delay === undefined ? '' : ` for ${durationText(form.detector.clearDuration) ?? ''}`}`
      : where
  if (kind === 'outside') {
    const [low, high] = [siValue(first.low, measure), siValue(first.high, measure)]
    if (low === undefined || high === undefined) return undefined
    const clear = clearPoint({ side: 'between', low, high }, margin, delay)
    const range = rangeLimitText({ ...first, high: shown(clear.back.high) }, 'high', measure)
    return range === undefined
      ? undefined
      : worded(clear, `between ${shown(clear.back.low)} and ${range}`)
  }
  const side = OPPOSITE_SIDE[kind ?? '']
  const limit = siValue(first.limit, measure)
  if (side === undefined || limit === undefined) return undefined
  const clear = clearPoint({ side, limit }, margin, delay)
  const text = stepLimitText(
    { ...first, limit: shown(clear.back.limit) },
    stepQuantity(form.detector),
    measure
  )
  return text === undefined ? undefined : worded(clear, `${side} ${text}`)
}

/** How the alert climbs through several steps, and when a comparison clears. */
export function ladderText(form: RuleForm, units: UnitLookup): string | undefined {
  if (form.steps.length < 2 || isZoneLimited(form.detector)) return undefined
  const measure = signalMeasure(signalShape(form.signal), units)
  const quantity = stepQuantity(form.detector)
  const word = stepWord(form.detector)
  const parts = form.steps.map((step) => {
    const limit = stepLimitText(step, quantity, measure) ?? '…'
    const priority = step.priority === '' ? 'step' : step.priority
    return `${article(priority)} ${priority} ${word} ${limit}`.replace(/ {2,}/g, ' ')
  })
  const [first, ...later] = parts
  const climb = `The alert is raised as ${first} and becomes ${later.join(', then ')}.`
  const clears = clearsText(form, measure)
  return clears === undefined ? climb : `${climb} It clears only ${clears}.`
}
