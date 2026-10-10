/**
 * What the editor says next to the limits: what the chosen priority means,
 * how the steps climb, and whether the value now would alert.
 */
import { formatNumber } from '../../format'
import type { Priority, ZoneLevel } from '../../model/rule'
import type { SignalValue } from '../api'
import { article, clearPoint, formatValue, OPPOSITE_SIDE } from '../rules/describe'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { fromSI, toSI } from '../units'
import { kindOf } from './conditionKinds'
import {
  isZoneLimited,
  parsedNumber,
  signalShape,
  stepQuantity,
  type RuleForm,
  type StepForm
} from './formModel'
import { intervalText, rangeLimitText, stepLimitText, stepWord } from './words'

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
export function reachedStep(
  form: RuleForm,
  value: SignalValue,
  measure: Measure
): number | undefined {
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

/** Where the alert ends, each part as shown; `eased` when a hysteresis moves it. */
type EndLevel = { eased: boolean } & (
  | { at: 'limit'; side: 'above' | 'below'; limit: string }
  | { at: 'range'; low: string; high: string }
  | { at: 'zone'; side: 'above' | 'below'; zone: ZoneLevel; margin: string }
)

/**
 * Where the alert ends for the limits typed now: past the first step by the
 * hysteresis, inside its range narrowed by it, or past the zone it starts
 * at. Undefined where nothing typed gives a level: no first limit, a
 * hysteresis that is not a number, or one that closes the range.
 */
function endLevel(form: RuleForm, measure: Measure): EndLevel | undefined {
  const { detector } = form
  const typed = parsedNumber(detector.hysteresis)
  if (typed === undefined && detector.hysteresis.trim() !== '') return undefined
  const margin =
    typed === undefined
      ? undefined
      : toSI(measure.kind === 'ratio' ? 'ratio' : 'interval', typed, measure.unit)
  const shown = (si: number) => formatNumber(fromSI(measure.kind, si, measure.unit))
  const kind = kindOf(detector)
  const side = OPPOSITE_SIDE[kind ?? '']
  if (isZoneLimited(detector)) {
    if (side === undefined || detector.limit.level === '') return undefined
    const eased = clearPoint({ side }, margin).margin !== undefined
    return {
      at: 'zone',
      side,
      zone: detector.limit.level,
      eased,
      margin: intervalText(typed ?? 0, measure)
    }
  }
  const first = form.steps.at(0)
  if (first === undefined) return undefined
  if (kind === 'outside') {
    const [low, high] = [siValue(first.low, measure), siValue(first.high, measure)]
    if (low === undefined || high === undefined) return undefined
    const { back, margin: by } = clearPoint({ side: 'between', low, high }, margin)
    if (back.low >= back.high) return undefined
    const shownHigh = rangeLimitText({ ...first, high: shown(back.high) }, 'high', measure)
    return shownHigh === undefined
      ? undefined
      : { at: 'range', low: shown(back.low), high: shownHigh, eased: by !== undefined }
  }
  const limit = siValue(first.limit, measure)
  if (side === undefined || limit === undefined) return undefined
  const { back, margin: by } = clearPoint({ side, limit }, margin)
  const text = stepLimitText(
    { ...first, limit: shown(back.limit) },
    stepQuantity(detector),
    measure
  )
  return text === undefined
    ? undefined
    : { at: 'limit', side, limit: text, eased: by !== undefined }
}

/** The hysteresis field's hint where no level follows from what is typed. */
const HYSTERESIS_DEFINED = 'How far past the limit the value must return before the alert ends.'

/** The hysteresis field's hint: where the alert ends for the limits typed now. */
export function hysteresisHint(form: RuleForm, units: UnitLookup): string {
  const end = endLevel(form, signalMeasure(signalShape(form.signal), units))
  if (end === undefined) return HYSTERESIS_DEFINED
  switch (end.at) {
    case 'limit':
      return `Alert ends at ${end.limit}.`
    case 'range':
      return `Alert ends inside ${end.low}–${end.high}.`
    case 'zone':
      return `Alert ends ${end.eased ? `${end.margin} ` : ''}${end.side} the ${end.zone} zone.`
  }
}

/** How the alert climbs through several steps, and where a comparison ends. */
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
  const end = endLevel(form, measure)
  if (end === undefined || end.at === 'zone') return climb
  const where =
    end.at === 'range' ? `between ${end.low} and ${end.high}` : `${end.side} ${end.limit}`
  return `${climb} It ends ${end.eased ? 'only ' : ''}once back ${where}.`
}
