import type {
  ConditionFacts,
  InstanceStatus,
  RuleEntry,
  RuleEvent,
  RuleGate,
  RuleInfo,
  RuleStep,
  SignalValue
} from '../api'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { fromSI } from '../units'
import { formatDuration, formatNumber } from '../../format'

/** The longest note the server accepts with a disable. */
export const MAX_NOTE_LENGTH = 500

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** "a" or "an", for the priority names. */
export function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}

/** The alerts a rule holds now, as its state reports them. */
export function activeCount(entry: RuleEntry): number {
  return entry.status.instances.filter((i) => i.condition === 'alerting').length
}

export function instanceName(i: InstanceStatus): string {
  return i.instance?.name ?? i.instance?.segment ?? ''
}

/**
 * The accumulated totals a reset or an edit would discard, each shown with
 * `format`: one per instance holding a total above zero, named for a
 * wildcard rule.
 */
export function discardedTotals(
  entry: RuleEntry,
  format: (total: number) => string
): { name: string; total: string }[] {
  return entry.status.instances.flatMap((i) =>
    i.progress?.kind === 'total' && i.progress.total > 0
      ? [{ name: instanceName(i), total: format(i.progress.total) }]
      : []
  )
}

export function describeInput(s: RuleInfo['signal']): string {
  const paths = s.paths.join(', ')
  return s.combinator === undefined ? paths : `${s.combinator} of ${paths}`
}

export function isWildcard(rule: RuleInfo): boolean {
  return rule.signal.paths.some((path) => path.split('.').includes('*'))
}

/** Whether a rule is told per instance: a wildcard, or one reporting several. */
export function hasInstances(entry: RuleEntry): boolean {
  return isWildcard(entry.rule) || entry.status.instances.length > 1
}

function withUnit(shown: string, unit: string): string {
  return unit === '' ? shown : `${shown} ${unit}`
}

/**
 * A value as the panel shows it: an SI number converted by `measure` and
 * labelled with its unit, or as it is without one.
 */
export function formatValue(value: SignalValue, measure?: Measure): string {
  if (typeof value === 'object') {
    return `${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)}`
  }
  if (typeof value !== 'number') return String(value)
  if (measure === undefined) return formatNumber(value)
  const unit = measure.kind === 'ratio' ? '' : measure.unit.symbol
  return withUnit(formatNumber(fromSI(measure.kind, value, measure.unit)), unit)
}

/** A timestamp from the server, in the operator's local time. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

const MATCH_WORDS: Readonly<Partial<Record<string, string>>> = {
  equals: 'equals',
  notEquals: 'is not',
  changesTo: 'changes to'
}

const EVENT_WORDS: Readonly<Partial<Record<string, string>>> = {
  changes: 'changes',
  changesTo: 'changes to',
  decreases: 'decreases'
}

/** An event in words: "changes to true". */
function eventWords(event: RuleEvent, display: RuleDisplay): string {
  const words = EVENT_WORDS[event.op] ?? event.op
  return event.value === undefined ? words : `${words} ${display.value(event.value)}`
}

/** A projection's limit is passed on the side its trend heads for. */
function projectedSide(direction: RuleInfo['detector']['direction']): string {
  return direction === 'falling' ? 'below' : 'above'
}

/**
 * The side of its limit an alert's value went: a sustained rule's direction,
 * or the limit an outside rule's alert reports passing. Undefined for the
 * detectors whose limit is not a bound on the value.
 */
export function passedSide(rule: RuleInfo, passed: ConditionFacts['passed']): string | undefined {
  const { type, direction } = rule.detector
  if (type === 'sustained') return direction
  if (type === 'outside' && passed !== undefined) return passed === 'low' ? 'below' : 'above'
  return undefined
}

/** The condition one step holds at, as the facts and the step ladder word it. */
export function stepCondition(step: RuleStep, rule: RuleInfo, display: RuleDisplay): string {
  const { type, direction, op } = rule.detector
  const limit = step.limit
  switch (type) {
    case 'match': {
      if (op === 'decreases') return 'decreases'
      if (op === 'timedOut') return 'times out'
      const value = step.value === undefined ? '' : ` ${display.value(step.value)}`
      return `${MATCH_WORDS[op ?? ''] ?? op ?? ''}${value}`
    }
    case 'absence':
      return `no event within ${formatDuration(step.within ?? 0)}`
    case 'count': {
      const { event, window } = rule.detector
      const what = event === undefined ? '' : ` (${eventWords(event, display)})`
      const within = window === undefined ? '' : ` within ${formatDuration(window)}`
      return `more than ${plural(limit ?? 0, 'event')}${what}${within}`
    }
    case 'accumulator':
      return `a total of ${display.total(limit ?? 0)}`
    case 'slope':
      return `${direction ?? ''} faster than ${display.rate(limit ?? 0)}`
    case 'projection':
      return `projected ${projectedSide(direction)} ${display.value(limit ?? 0)}`
    case 'outside':
      return `outside ${display.range(step.low ?? 0, step.high ?? 0, 'to')}`
    default:
      return `${direction ?? ''} ${display.value(limit ?? 0)}`
  }
}

/**
 * When a rule alerts: each step's condition, with its priority when there are
 * several, and how long a step must hold.
 */
export function alertsWhen(rule: RuleInfo, display: RuleDisplay): string {
  const { steps, duration, detector } = rule
  const held = duration === undefined || duration <= 0 ? '' : formatDuration(duration)
  if (steps.length === 0) {
    const side =
      detector.type === 'projection'
        ? `projected ${projectedSide(detector.direction)}`
        : (detector.direction ?? 'in')
    const zone = `${side} the ${detector.zoneLevel ?? ''} zone`
    return held === '' ? zone : `${zone} for at least ${held}`
  }
  if (steps.length === 1) {
    const condition = stepCondition(steps[0], rule, display)
    return held === '' ? condition : `${condition} for at least ${held}`
  }
  const each = steps.map((s) => `${stepCondition(s, rule, display)} (${s.priority})`).join(', ')
  return held === '' ? each : `${each}, each for at least ${held}`
}

/** The side a value is back on once it no longer holds past a limit. */
export const BACK_FROM: Readonly<Partial<Record<string, string>>> = {
  below: 'above',
  above: 'below'
}

/** A difference in the signal's unit: the linear part only, as a clear margin is. */
function formatInterval(value: number, measure: Measure): string {
  if (measure.kind === 'ratio') return formatNumber(value)
  return withUnit(formatNumber(fromSI('interval', value, measure.unit)), measure.unit.symbol)
}

/**
 * When a gate holds, after its path: "above 480 rpm for 10 s", and once it
 * stops, by its clear margin and after its clear delay when it sets them.
 */
export function gateCondition(gate: RuleGate, units: UnitLookup): string {
  const measure = signalMeasure(gate, units)
  const { direction = '', limit, zoneLevel = '', duration = 0 } = gate
  const { hysteresis = 0, clearDuration = 0 } = gate
  const held = duration > 0 ? ` for ${formatDuration(duration)}` : ''
  const condition =
    limit === undefined
      ? `${direction} the ${zoneLevel} zone${held}`
      : `${direction} ${formatValue(limit, measure)}${held}`
  const back = BACK_FROM[direction]
  if ((hysteresis <= 0 && clearDuration <= 0) || back === undefined) return condition
  const where =
    limit === undefined
      ? `${back} the ${zoneLevel} zone${hysteresis > 0 ? ` by ${formatInterval(hysteresis, measure)}` : ''}`
      : `${back} ${formatValue(back === 'above' ? limit + hysteresis : limit - hysteresis, measure)}`
  const delay = clearDuration > 0 ? ` for ${formatDuration(clearDuration)}` : ''
  return `${condition}; stops holding once back ${where}${delay}`
}

/** How a rule's values, limits and accumulated totals are shown. */
export interface RuleDisplay {
  value: (value: SignalValue) => string
  /** Two values joined by a word, the unit once after both: "-25 to 25 °". */
  range: (low: number, high: number, joiner: 'to' | 'and') => string
  total: (total: number) => string
  /** A rate of change, stored per second, shown per minute as the editor enters it. */
  rate: (perSecond: number) => string
  /** The rule's values are numbers no display unit applies to, so they are shown in SI. */
  si: boolean
}

/**
 * A rule's status carries SI numbers without units, so the unit comes from
 * the meta of the paths its signal reads.
 */
export function ruleDisplay(rule: RuleInfo, units: UnitLookup): RuleDisplay {
  const measure = signalMeasure(rule.signal, units)
  const integral = measure.kind === 'ratio' ? '' : measure.unit.symbol
  const total =
    rule.detector.measure === 'time'
      ? formatDuration
      : (v: number) =>
          withUnit(
            formatNumber(fromSI('interval', v, measure.unit)),
            integral === '' ? '' : `${integral}·s`
          )
  const shown = (v: number) => formatNumber(fromSI(measure.kind, v, measure.unit))
  // A rule on text or a boolean has no values a unit applies to.
  const textual = [
    ...rule.steps.map((s) => s.value),
    rule.detector.event?.value,
    ...rule.signal.paths.map((p) => units.entry(p)?.value)
  ].some((v) => typeof v === 'string' || typeof v === 'boolean')
  return {
    value: (v) => formatValue(v, measure),
    range: (low, high, joiner) => withUnit(`${shown(low)} ${joiner} ${shown(high)}`, integral),
    total,
    rate: (v) => `${withUnit(formatNumber(fromSI('slope', v, measure.unit)), integral)}/min`,
    si: !textual && measure.kind !== 'ratio' && measure.unit.si
  }
}
