import type { InstanceStatus, RuleEntry, RuleInfo, RuleStep, SignalValue } from '../api'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { fromSI } from '../units'
import { formatDuration, formatNumber } from '../../format'

/** The longest note the server accepts with a disable. */
export const MAX_NOTE_LENGTH = 500

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
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

/** A projection's limit is passed on the side its trend heads for. */
function projectedSide(direction: RuleInfo['detector']['direction']): string {
  return direction === 'falling' ? 'below' : 'above'
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
    case 'count':
      return `more than ${plural(limit ?? 0, 'event')}`
    case 'accumulator':
      return `a total of ${display.total(limit ?? 0)}`
    case 'slope':
      return `${direction ?? ''} faster than ${display.rate(limit ?? 0)}`
    case 'projection':
      return `projected ${projectedSide(direction)} ${display.value(limit ?? 0)}`
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

/** How a rule's values, limits and accumulated totals are shown. */
export interface RuleDisplay {
  value: (value: SignalValue) => string
  total: (total: number) => string
  /** A rate of change, per second, through the linear part of the unit. */
  rate: (perSecond: number) => string
  /** No display unit applies to the rule's values, so they are shown in SI. */
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
  return {
    value: (v) => formatValue(v, measure),
    total,
    rate: (v) =>
      `${withUnit(formatNumber(fromSI('interval', v, measure.unit)), integral)}/s`.trimStart(),
    si: measure.kind !== 'ratio' && measure.unit.si
  }
}
