import { ZONE_LEVELS, type Limit, type ZoneLevel, type ZoneLimit } from '../model/rule.js'

/** A `meta.zones` entry. JSON meta may carry a missing bound as null. */
export interface Zone {
  lower?: number | null
  upper?: number | null
  state: string
  message?: string
}

export type LimitResolution = { ok: true; value: number } | { ok: false; reason: string }

/** A zone level's rank; a more severe level ranks higher. */
export function severity(level: ZoneLevel): number {
  return ZONE_LEVELS.indexOf(level)
}

function isLevel(state: string): state is ZoneLevel {
  return (ZONE_LEVELS as readonly string[]).includes(state)
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
  const entering = (zones ?? []).filter((z) => isLevel(z.state) && severity(z.state) >= floor)
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
 * The thresholds of every zone level more severe than the limit's own that
 * the zones define, least severe first, each resolved as {@link resolveLimit}
 * resolves the limit's own level.
 */
export function severerLevels(
  limit: ZoneLimit,
  direction: 'above' | 'below',
  zones: readonly Zone[] | null | undefined
): { level: ZoneLevel; value: number }[] {
  return ZONE_LEVELS.slice(severity(limit.level) + 1).flatMap((level) => {
    const resolved = resolveLimit({ ...limit, level }, direction, zones)
    return resolved.ok ? [{ level, value: resolved.value }] : []
  })
}
