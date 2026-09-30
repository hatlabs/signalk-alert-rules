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

type Side = 'low' | 'high'

const NORMAL_STATES: readonly string[] = ['normal', 'nominal']

function bound(value: number | null | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/**
 * Tells each zone's side of the path's range. A zone open below is low and one
 * open above is high. A zone bounded on both sides is placed against the outer
 * edges of the normal and nominal zones; without any, a path whose one-sided
 * zones all lie on one side is taken to be one-sided, since a zone graded
 * towards an open-ended one lies on its side.
 */
function sideOf(zones: readonly Zone[]): (zone: Zone) => { side: Side } | { reason: string } {
  const normal = zones.filter((z) => NORMAL_STATES.includes(z.state))
  const normalLow = Math.min(...normal.map((z) => bound(z.lower) ?? -Infinity))
  const normalHigh = Math.max(...normal.map((z) => bound(z.upper) ?? Infinity))
  const levelled = zones.filter((z) => isLevel(z.state))
  const openLow = levelled.some((z) => bound(z.lower) === undefined && bound(z.upper) !== undefined)
  const openHigh = levelled.some(
    (z) => bound(z.upper) === undefined && bound(z.lower) !== undefined
  )
  const onlySide: Side | undefined = openLow === openHigh ? undefined : openLow ? 'low' : 'high'

  return (zone) => {
    const lower = bound(zone.lower)
    const upper = bound(zone.upper)
    if (lower === undefined && upper === undefined) {
      return { reason: `the ${zone.state} zone has neither bound, so its side cannot be told` }
    }
    if (lower === undefined) return { side: 'low' }
    if (upper === undefined) return { side: 'high' }
    if (normal.length > 0) {
      if (upper <= normalLow) return { side: 'low' }
      if (lower >= normalHigh) return { side: 'high' }
    } else if (onlySide !== undefined) {
      return { side: onlySide }
    }
    return {
      reason:
        `the side of the ${zone.state} zone from ${String(lower)} to ${String(upper)} ` +
        'cannot be told; add a normal zone that separates the low zones from the high ones'
    }
  }
}

/**
 * The SI limit a detector compares against. A zone limit is the edge of the
 * union of the named level's zones and every more severe one on the rule's
 * direction side (low for `below`, high for `above`), on the side the
 * condition enters from: the highest upper bound for `below`, the lowest
 * lower bound for `above`. A zone at or above the named level whose side
 * cannot be told fails the resolution, as it could move either edge.
 */
export function resolveLimit(
  limit: Limit,
  direction: 'above' | 'below',
  zones: readonly Zone[] | null | undefined
): LimitResolution {
  if (limit.kind === 'fixed') return { ok: true, value: limit.value }
  const all = zones ?? []
  const floor = severity(limit.level)
  const side: Side = direction === 'below' ? 'low' : 'high'
  const classify = sideOf(all)
  const entering: Zone[] = []
  for (const zone of all) {
    if (!isLevel(zone.state) || severity(zone.state) < floor) continue
    const classified = classify(zone)
    if ('reason' in classified) return { ok: false, reason: classified.reason }
    if (classified.side === side) entering.push(zone)
  }
  if (!entering.some((z) => z.state === limit.level)) {
    return { ok: false, reason: `the path has no ${limit.level} zone on the ${side} side` }
  }
  // A low-side zone always has an upper bound and a high-side one a lower
  // bound, so no edge is dropped here.
  const edges = entering.flatMap((z) => bound(direction === 'below' ? z.upper : z.lower) ?? [])
  return { ok: true, value: direction === 'below' ? Math.max(...edges) : Math.min(...edges) }
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
