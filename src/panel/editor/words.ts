/**
 * How the editor words a rule's parts: the value it watches, a step's limit
 * as typed, and the unit each kind of field is entered in.
 */
import { formatNumber } from '../../format'
import { isPointerPath, splitPointerPath } from '../../model/pointerPath'
import type { CombinatorKind } from '../../model/rule'
import { capitalised } from '../list/PriorityBadge'
import {
  instanceOf,
  instanceSegment,
  isWildcardPath,
  type Measure,
  type UnitLookup
} from '../signalUnits'
import { unitLabel } from '../units'
import {
  parsedNumber,
  type DetectorForm,
  type DurationField,
  type SignalForm,
  type StepForm,
  type StepQuantity,
  type ValueField
} from './formModel'

/** The unit labels of each kind of field on a signal measured by `measure`. */
export function unitLabels(measure: Measure) {
  const ratio = measure.kind === 'ratio'
  const symbol = ratio ? '' : measure.unit.symbol
  return {
    value: unitLabel(measure.kind, measure.unit),
    interval: unitLabel(ratio ? 'ratio' : 'interval', measure.unit),
    slope: ratio ? '/min' : unitLabel('slope', measure.unit),
    integral: symbol === '' ? 's' : `${symbol}·s`
  }
}

const COMBINATOR_WORDS: Readonly<Record<CombinatorKind, string>> = {
  difference: 'Difference',
  absDifference: 'Difference',
  ratio: 'Ratio',
  spread: 'Spread',
  mean: 'Mean',
  median: 'Median',
  distance: 'Distance',
  positionSpread: 'Spread'
}

function uncapitalised(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** `coolantTemperature` as `coolant temperature`. */
function segmentWords(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

/**
 * A path in words: its leaf, after the segment before it unless that is the
 * group at the top, such as `navigation`, or a number, which names nothing
 * (`tanks.freshWater.0.currentLevel` reads "fresh water current level").
 */
function pathWords(path: string): string {
  // A field reads as the rule detail names it: its instance, then its leaf words.
  if (isPointerPath(path)) {
    const instance = instanceOf(path)
    return [...(instance === undefined ? [] : [instance]), leafWords(path)].join(' ')
  }
  const segments = path.split('.')
  const leaf = segments.at(-1) ?? ''
  const before = segments
    .slice(1, -1)
    .reverse()
    .find((s) => !/^\d+$/.test(s))
  return before === undefined ? segmentWords(leaf) : `${segmentWords(before)} ${segmentWords(leaf)}`
}

/** A path in words as a name, "Attitude roll" for `navigation.attitude#/roll`. */
export function pathName(path: string): string {
  return capitalised(pathWords(path))
}

/**
 * What a path's leaf reads as beside its instance: the leaf in words, or
 * for a field the base path's last segment and then the field,
 * `navigation.attitude#/roll` "attitude roll". That segment is left out
 * where it names nothing of its own: a wildcard, a number, the top group,
 * or the instance, which is named apart.
 */
export function leafWords(path: string): string {
  const split = splitPointerPath(path)
  const base = split.basePath.split('.')
  const last = base.at(-1) ?? ''
  if (!split.valid || split.tokens.length === 0) return segmentWords(last)
  const named =
    base.length > 1 &&
    last !== '*' &&
    !/^\d+$/.test(last) &&
    instanceSegment(path) !== base.length - 1
  return [...(named ? [last] : []), ...split.tokens].map(segmentWords).join(' ')
}

/** `1 rule`, `2 rules`. */
export function rulesWord(n: number): string {
  return n === 1 ? '1 rule' : `${String(n)} rules`
}

/** `a, b and c`. */
export function joined(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`
}

function singleSubject(path: string, units: UnitLookup): string {
  if (isWildcardPath(path)) return `${capitalised(leafWords(path))} of {instance}`
  return units.entry(path)?.displayName ?? pathName(path)
}

/**
 * What a rule watches, in words: a path's display name, else its path in
 * words; a wildcard's `{instance}`; a combination by its inputs. Empty
 * until a path is chosen.
 */
export function subjectOf(signal: SignalForm, units: UnitLookup): string {
  const paths = signal.slots.map((s) => s.path).filter((p) => p !== '')
  if (paths.length === 0) return ''
  if (signal.mode === 'single') return singleSubject(paths[0], units)
  const inputs = paths.map((p) => uncapitalised(singleSubject(p, units)))
  return `${COMBINATOR_WORDS[signal.combinator]} of ${joined([...new Set(inputs)])}`
}

/** The words between a step's priority and its limit: "below", "more than". */
export function stepWord(d: DetectorForm): string {
  switch (d.type) {
    case 'sustained':
      return d.direction
    case 'outside':
      return 'outside'
    case 'slope':
      return 'faster than'
    case 'projection':
      return 'reaching'
    case 'count':
      return 'more than'
    case 'accumulator':
      return 'at a total of'
    case 'absence':
      return 'none for'
    case 'match':
      return MATCH_WORDS[d.matchOp]
    case '':
      return ''
  }
}

const MATCH_WORDS: Readonly<Record<DetectorForm['matchOp'], string>> = {
  equals: 'is',
  notEquals: 'is not',
  changesTo: 'changes to',
  decreases: 'decreases',
  timedOut: 'stops reporting',
  '': ''
}

const DURATION_WORDS: Readonly<Record<DurationField['unit'], string>> = {
  s: 's',
  min: 'min',
  h: 'h'
}

/** A duration as typed, `30 s`; undefined while empty. */
export function durationText(duration: DurationField): string | undefined {
  const amount = duration.amount.trim()
  return amount === '' ? undefined : `${amount} ${DURATION_WORDS[duration.unit]}`
}

function withUnit(text: string, unit: string): string {
  return unit === '' ? text : `${text} ${unit}`
}

/** A match value as typed, a number with its unit. */
export function valueText(value: ValueField, measure: Measure): string | undefined {
  switch (value.type) {
    case 'true':
    case 'false':
      return value.type
    case 'text':
      return value.text === '' ? undefined : value.text
    case 'number':
      return value.text.trim() === ''
        ? undefined
        : withUnit(value.text.trim(), unitLabels(measure).value.replace(/ \(SI\)$/, ''))
  }
}

/** One limit of a range step as typed, with its unit: `25 °`. */
export function rangeLimitText(
  step: StepForm,
  side: 'low' | 'high',
  measure: Measure
): string | undefined {
  return stepLimitText({ ...step, limit: step[side] }, 'value', measure)
}

/**
 * The clear margin an outside rule's first step allows, as a sentence:
 * `The clear margin must be less than 25 °, half the warning's range -25 to 25 °.`
 * Undefined while the range is not filled in.
 */
export function clearMarginText(first: StepForm, measure: Measure): string | undefined {
  const range = stepLimitText(first, 'range', measure)
  const [low, high] = [parsedNumber(first.low), parsedNumber(first.high)]
  if (range === undefined || low === undefined || high === undefined) return undefined
  const half = withUnit(
    formatNumber((high - low) / 2),
    unitLabels(measure).interval.replace(/ \(SI\)$/, '')
  )
  const whose = first.priority === '' ? 'the first step' : `the ${first.priority}`
  return `The clear margin must be less than ${half}, half ${whose}'s range ${range}.`
}

/**
 * A step's limit as typed, with its unit, a range as `-25 to 25 °`;
 * undefined while empty, a range while either limit is, or for a step
 * without one.
 */
export function stepLimitText(
  step: StepForm,
  quantity: StepQuantity | undefined,
  measure: Measure
): string | undefined {
  const labels = unitLabels(measure)
  const typed = step.limit.trim()
  const plain = (unit: string) =>
    typed === '' ? undefined : withUnit(typed, unit.replace(/ \(SI\)$/, ''))
  switch (quantity) {
    case 'value':
      return plain(labels.value)
    case 'range': {
      const [low, high] = [step.low.trim(), step.high.trim()]
      return low === '' || high === ''
        ? undefined
        : withUnit(`${low} to ${high}`, labels.value.replace(/ \(SI\)$/, ''))
    }
    case 'slope':
      return plain(labels.slope)
    case 'integral':
      return plain(labels.integral)
    case 'count':
      return plain('')
    case 'time':
    case 'within':
      return durationText(step.duration)
    case 'match':
      return valueText(step.value, measure)
    default:
      return undefined
  }
}
