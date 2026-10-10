import type { Detector, Limit, Signal, ZoneLimit } from '../model/rule.js'
import { ZONE_LEVELS, type ZoneLevel } from '../model/zoneLevels.js'

/** A `meta.zones` entry. JSON meta may carry a missing bound as null. */
export interface Zone {
  lower?: number | null
  upper?: number | null
  state: string
  message?: string
}

/** A zone level a path lacks, on the rule's side when the level exists only on the other. */
export interface MissingZone {
  level: ZoneLevel
  side?: 'low' | 'high'
}

export type LimitResolution = { ok: true; value: number } | { ok: false; missing: MissingZone }

/** The path whose zones a zone limit reads: its own, else the signal's, which a combined signal lacks. */
export function zonePath(limit: ZoneLimit, signal: Signal): string | undefined {
  return limit.path ?? ('combinator' in signal ? undefined : signal.path)
}

/** The side of its limit a detector alerts past: a rising projection's is above. */
export function limitDirection(
  detector: Extract<Detector, { type: 'sustained' | 'projection' }>
): 'above' | 'below' {
  if (detector.type === 'sustained') return detector.direction
  return detector.direction === 'rising' ? 'above' : 'below'
}

/** A zone level's rank; a more severe level ranks higher. */
function severity(level: ZoneLevel): number {
  return ZONE_LEVELS.indexOf(level)
}

function isLevel(state: string): state is ZoneLevel {
  return (ZONE_LEVELS as readonly string[]).includes(state)
}

/** Touching or overlapping zones merged into one stretch of the range. */
interface Run {
  lower: number
  upper: number
}

/**
 * Merges the zones at `level` or more severe into runs, lowest first. A
 * missing bound is open.
 */
function runsFrom(zones: readonly Zone[], level: ZoneLevel): Run[] {
  const floor = severity(level)
  const spans = zones
    .filter((z) => isLevel(z.state) && severity(z.state) >= floor)
    .map((z) => ({
      lower: z.lower ?? -Infinity,
      upper: z.upper ?? Infinity
    }))
    .sort((a, b) => a.lower - b.lower)
  const runs: Run[] = []
  for (const span of spans) {
    const last = runs.at(-1)
    if (last !== undefined && span.lower <= last.upper) {
      last.upper = Math.max(last.upper, span.upper)
    } else {
      runs.push({ ...span })
    }
  }
  return runs
}

/**
 * The SI limit a detector compares against. A zone limit comes from the runs
 * of touching or overlapping zones at the named level or more severe: the
 * upper edge of the lowest run for `below`, the lower edge of the highest run
 * for `above`. The outermost run lies on the rule's side of the range whatever
 * else the path defines, so no normal zone is needed to tell the sides apart.
 * The edge must be finite and supplied only by zones of the named level: a
 * run graded from the named level outward has that level alone at its inner
 * edge, while one whose inner edge is also a more severe level's, adjacent or
 * nested, lies on the far side of a path zoned only there, and taking its
 * edge would put the whole range past the limit.
 * Otherwise the level is missing on the rule's side.
 */
export function resolveLimit(
  limit: Limit,
  direction: 'above' | 'below',
  zones: readonly Zone[] | null | undefined
): LimitResolution {
  if (limit.kind === 'fixed') return { ok: true, value: limit.value }
  const all = zones ?? []
  if (!all.some((z) => z.state === limit.level)) {
    return { ok: false, missing: { level: limit.level } }
  }
  const runs = runsFrom(all, limit.level)
  const outer = direction === 'below' ? runs[0] : runs.at(-1)
  const edge = direction === 'below' ? outer?.upper : outer?.lower
  const edgeOf = (z: Zone) =>
    direction === 'below' ? (z.upper ?? Infinity) : (z.lower ?? -Infinity)
  const floor = severity(limit.level)
  const suppliers = all.filter(
    (z) => isLevel(z.state) && severity(z.state) >= floor && edgeOf(z) === edge
  )
  const graded = suppliers.every((z) => z.state === limit.level)
  if (!graded || edge === undefined || !Number.isFinite(edge)) {
    return {
      ok: false,
      missing: { level: limit.level, side: direction === 'below' ? 'low' : 'high' }
    }
  }
  return { ok: true, value: edge }
}

/**
 * The thresholds of every zone level more severe than the limit's own that
 * the zones define, least severe first, each resolved as {@link resolveLimit}
 * resolves the limit's own level. A threshold short of the limit's own in the
 * rule's direction comes from the far side of the range, so it is no
 * escalation step.
 */
export function severerLevels(
  limit: ZoneLimit,
  direction: 'above' | 'below',
  zones: readonly Zone[] | null | undefined
): { level: ZoneLevel; value: number }[] {
  const base = resolveLimit(limit, direction, zones)
  if (!base.ok) return []
  const beyond = (value: number) =>
    direction === 'below' ? value <= base.value : value >= base.value
  return ZONE_LEVELS.slice(severity(limit.level) + 1).flatMap((level) => {
    const resolved = resolveLimit({ ...limit, level }, direction, zones)
    return resolved.ok && beyond(resolved.value) ? [{ level, value: resolved.value }] : []
  })
}
