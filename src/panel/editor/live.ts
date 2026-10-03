/**
 * What the editor says next to the limits: what the chosen priority means,
 * how the steps climb, and whether the value now would alert.
 */
import type { Priority } from '../../model/rule'
import type { SignalValue } from '../api'
import { article, formatValue } from '../rules/describe'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { toSI } from '../units'
import { kindOf } from './conditionKinds'
import {
  isZoneLimited,
  parsedNumber,
  signalShape,
  stepQuantity,
  type RuleForm,
  type StepForm
} from './formModel'
import { stepLimitText, stepWord } from './words'

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

function siLimit(step: StepForm, measure: Measure): number | undefined {
  const value = parsedNumber(step.limit)
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
      const limit = siLimit(step, measure)
      if (limit === undefined || typeof value !== 'number') return undefined
      return kind === 'below' ? value < limit : value > limit
    }
    if (kind === 'state' && form.detector.matchOp === 'equals') {
      const { value: wanted } = step
      if (wanted.type === 'true' || wanted.type === 'false')
        return value === (wanted.type === 'true')
      if (wanted.type === 'text') return value === wanted.text
      const limit = siLimit({ ...step, limit: wanted.text }, measure)
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
  return `${now}: would alert as ${article(priority)} ${priority}.`
}

const CLEARS: Readonly<Partial<Record<string, string>>> = { below: 'above', above: 'below' }

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
  const kind = kindOf(form.detector)
  const back = CLEARS[kind ?? '']
  const firstLimit = form.steps[0] && stepLimitText(form.steps[0], quantity, measure)
  return back === undefined || firstLimit === undefined
    ? climb
    : `${climb} It clears only ${back} ${firstLimit}.`
}
