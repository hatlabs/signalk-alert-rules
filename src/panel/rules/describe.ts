import { BADGES, type RuleEntry, type RuleInfo, type SignalValue } from '../api'
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

/**
 * A value as the panel shows it. Values stay in SI units until display-unit
 * conversion lands; this is the one place that has to change for it.
 */
export function formatValue(value: SignalValue, unit?: string): string {
  if (typeof value === 'object') {
    return `${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)}`
  }
  if (typeof value !== 'number') return String(value)
  const rounded = Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(4)
  const shown = Number.isInteger(value) ? String(value) : String(Number(rounded))
  return unit === undefined ? shown : `${shown} ${unit}`
}
