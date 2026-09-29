import {
  PRIORITIES,
  ZONE_LEVELS,
  type Limit,
  type Priority,
  type ZoneLevel
} from '../model/rule.js'

/** A `meta.zones` entry. JSON meta may carry a missing bound as null. */
export interface Zone {
  lower?: number | null
  upper?: number | null
  state: string
  message?: string
}

export type LimitResolution = { ok: true; value: number } | { ok: false; reason: string }

/** Zone states in the alert priority they raise; core defines no such mapping. */
export const ZONE_PRIORITY: Record<ZoneLevel, Priority> = {
  alert: 'caution',
  warn: 'warning',
  alarm: 'alarm',
  emergency: 'emergency'
}

function severity(state: string): number {
  return ZONE_LEVELS.indexOf(state as ZoneLevel)
}

/**
 * The SI limit a detector compares against. A zone limit is the edge of the
 * union of the named level's zones and every more severe one, on the side the
 * condition enters from: the highest upper bound for `below`, the lowest lower
 * bound for `above`.
 */
export function resolveLimit(
  limit: Limit,
  direction: 'above' | 'below',
  zones: readonly Zone[] | null | undefined
): LimitResolution {
  if (limit.kind === 'fixed') return { ok: true, value: limit.value }
  const floor = severity(limit.level)
  const entering = (zones ?? []).filter((z) => severity(z.state) >= floor)
  if (!entering.some((z) => z.state === limit.level)) {
    return { ok: false, reason: `the path has no ${limit.level} zone` }
  }
  const edges = entering.map((z) => (direction === 'below' ? z.upper : z.lower))
  const values = edges.filter((e): e is number => typeof e === 'number')
  if (values.length < edges.length) {
    const side = direction === 'below' ? 'upper' : 'lower'
    return { ok: false, reason: `a ${limit.level} or more severe zone has no ${side} bound` }
  }
  return { ok: true, value: direction === 'below' ? Math.max(...values) : Math.min(...values) }
}

/**
 * The most severe alerting zone containing `value`, with the bound rules of
 * core's zones engine: lower inclusive, upper exclusive, a missing bound
 * unbounded.
 */
export function bandOf(
  value: number,
  zones: readonly Zone[] | null | undefined
): ZoneLevel | undefined {
  let band: ZoneLevel | undefined
  for (const zone of zones ?? []) {
    const level = severity(zone.state)
    if (level < 0) continue
    const above = zone.lower === undefined || zone.lower === null || value >= zone.lower
    const below = zone.upper === undefined || zone.upper === null || value < zone.upper
    if (above && below && (band === undefined || level > severity(band))) band = ZONE_LEVELS[level]
  }
  return band
}

const RANK = [...PRIORITIES].reverse()

export function higherPriority(a: Priority, b: Priority | undefined): Priority {
  return b !== undefined && RANK.indexOf(b) > RANK.indexOf(a) ? b : a
}
