import { BADGES, type RuleEntry, type RuleInfo, type SignalValue } from '../api'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { fromSI } from '../units'
import { BADGE_LOOK } from './StatusBadge'

export const USER_ORIGIN = 'user'

export function describeDetector(d: RuleInfo['detector']): string {
  if (d.type === 'accumulator' && d.measure !== undefined) return `accumulator (${d.measure})`
  return d.direction === undefined ? d.type : `${d.type} ${d.direction}`
}

export function describeInput(s: RuleInfo['signal']): string {
  const paths = s.paths.join(', ')
  return s.combinator === undefined ? paths : `${s.combinator} of ${paths}`
}

/** A zone-limited rule takes its priority from the zone level it holds. */
export function describePriority(rule: RuleInfo): string {
  if (rule.priority !== undefined) return rule.priority
  return rule.detector.zoneLevel === undefined ? '' : `zone ${rule.detector.zoneLevel}`
}

export function isWildcard(rule: RuleInfo): boolean {
  return rule.signal.paths.some((path) => path.split('.').includes('*'))
}

/** How many instances have each badge, most important first. */
export function instanceSummary(entry: RuleEntry): string {
  const { instances } = entry.status
  if (instances.length === 0) return 'no instances yet'
  const counts = BADGES.map(
    (badge) => [badge, instances.filter((i) => i.badge === badge).length] as const
  ).filter(([, count]) => count > 0)
  const parts = counts.map(([badge, count]) => `${String(count)} ${BADGE_LOOK[badge].label}`)
  const noun = instances.length === 1 ? 'instance' : 'instances'
  return `${String(instances.length)} ${noun}: ${parts.join(', ').toLowerCase()}`
}

/**
 * Operator controls the badge does not already show: a disabled rule while
 * evaluation is off, and a suppression under a higher-ranking badge.
 */
export function markers(entry: RuleEntry): string[] {
  const { status } = entry
  const shown = []
  if (!entry.enabled && !(status.badge === 'disabled' && status.reason === 'disabled')) {
    shown.push('disabled')
  }
  if (entry.suppression !== undefined && status.badge !== 'suppressed') shown.push('suppressed')
  return shown
}

function formatNumber(value: number): string {
  const rounded = Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(4)
  return Number.isInteger(value) ? String(value) : String(Number(rounded))
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

const MINUTE = 60
const HOUR = 3600

/** Seconds in the largest unit that keeps the number readable: timers and running time. */
export function formatDuration(seconds: number): string {
  if (Math.abs(seconds) >= 2 * HOUR) return `${formatNumber(seconds / HOUR)} h`
  if (Math.abs(seconds) >= 2 * MINUTE) return `${formatNumber(seconds / MINUTE)} min`
  return `${formatNumber(seconds)} s`
}

/** How a rule's values, limits and accumulated totals are shown. */
export interface RuleDisplay {
  value: (value: SignalValue) => string
  total: (total: number) => string
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
    si: measure.kind !== 'ratio' && measure.unit.si
  }
}
