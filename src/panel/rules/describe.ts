import {
  CONDITIONS,
  type InstanceStatus,
  type RuleEntry,
  type RuleInfo,
  type SignalValue
} from '../api'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { fromSI } from '../units'
import { formatDuration, formatNumber } from '../../format'
import { BADGE_LOOK, type BadgeKind } from './StatusBadge'

/** The longest note the server accepts with a disable. */
export const MAX_NOTE_LENGTH = 500

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** The alerts a rule holds now, as its state reports them. */
export function activeCount(entry: RuleEntry): number {
  return entry.status.instances.filter((i) => i.condition === 'alerting').length
}

/** A rule's badge: Disabled while it is disabled, otherwise its condition. */
export function ruleBadge(entry: RuleEntry): BadgeKind {
  return entry.disabled === undefined ? entry.status.condition : 'disabled'
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

/** How many instances have each condition, worst first. */
export function instanceSummary(entry: RuleEntry): string {
  const { instances } = entry.status
  if (instances.length === 0) return 'no instances yet'
  const counts = CONDITIONS.map(
    (condition) => [condition, instances.filter((i) => i.condition === condition).length] as const
  ).filter(([, count]) => count > 0)
  const parts = counts.map(([badge, count]) => `${String(count)} ${BADGE_LOOK[badge].label}`)
  const noun = instances.length === 1 ? 'instance' : 'instances'
  return `${String(instances.length)} ${noun}: ${parts.join(', ').toLowerCase()}`
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
