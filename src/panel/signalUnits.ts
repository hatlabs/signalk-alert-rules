/**
 * The unit a signal's values are shown and entered in, and the instances of
 * a wildcard path. Shared by the rule detail view and the authoring form.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CombinatorKind } from '../model/rule'
import { useSelfPaths, type PathEntry, type PathList, type PathSource } from './paths/selfPaths'
import { displayUnit, type DisplayUnit, type QuantityKind } from './units'

/** Finds what the server reports about a path, and the user's distance unit. */
export interface UnitLookup {
  /** The reported path, or for a wildcard path the first reported path it matches. */
  entry(path: string): PathEntry | undefined
  distance: DisplayUnit
}

/** A signal as the parts that decide its unit: its input paths and combinator. */
export interface SignalShape {
  paths: string[]
  combinator?: string
}

/**
 * How a signal's value, and a limit or match value on it, converts: through
 * the full formula for a level, through the linear part for a difference.
 */
export interface Measure {
  kind: Extract<QuantityKind, 'absolute' | 'interval' | 'ratio'>
  unit: DisplayUnit
}

/** A path the server has not reported: SI, with no unit known. */
export const UNKNOWN_UNIT: DisplayUnit = displayUnit({})

const DIFFERENCES = new Set(['difference', 'absDifference', 'spread'])
/** The combinators over positions; a test keeps this equal to the model's. */
export const POSITION_KINDS: ReadonlySet<string> = new Set<CombinatorKind>([
  'distance',
  'positionSpread'
])

function segments(path: string): string[] {
  return path.split('.')
}

/** Whether `path` is `pattern` with its wildcard segment, if any, filled in. */
export function matchesPattern(pattern: string, path: string): boolean {
  const want = segments(pattern)
  const have = segments(path)
  return want.length === have.length && want.every((s, i) => s === '*' || s === have[i])
}

export function unitLookup(paths: readonly PathEntry[], distance: DisplayUnit): UnitLookup {
  const exact = new Map(paths.map((p) => [p.path, p]))
  return {
    entry: (path) =>
      exact.get(path) ??
      (path.includes('*') ? paths.find((p) => matchesPattern(path, p.path)) : undefined),
    distance
  }
}

/**
 * The reported paths and the units they resolve to, loaded once per source.
 * Until the paths arrive, or when they cannot be read, values are in SI.
 * With `pollMs` the paths, and their values, are read again that often.
 */
export function useUnits(
  source: PathSource,
  pollMs?: number
): {
  paths: PathList
  units: UnitLookup
  /** Paths and distance unit have both answered, or the paths failed to load. */
  ready: boolean
} {
  const paths = useSelfPaths(source, pollMs)
  const [distance, setDistance] = useState<DisplayUnit | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void source.distanceUnit().then((unit) => {
      if (!cancelled) setDistance(unit)
    })
    return () => {
      cancelled = true
    }
  }, [source])
  const units = useMemo(
    () => unitLookup(paths.status === 'ready' ? paths.paths : [], distance ?? NO_UNITS.distance),
    [paths, distance]
  )
  return { paths, units, ready: paths.status !== 'loading' && distance !== undefined }
}

/** No path reported yet and no distance preference: everything in SI. */
export const NO_UNITS: UnitLookup = unitLookup([], displayUnit({ units: 'm' }))

export function signalMeasure(signal: SignalShape, lookup: UnitLookup): Measure {
  const { combinator } = signal
  if (combinator !== undefined && POSITION_KINDS.has(combinator)) {
    return { kind: 'absolute', unit: lookup.distance }
  }
  if (combinator === 'ratio') return { kind: 'ratio', unit: UNKNOWN_UNIT }
  const unit =
    signal.paths.map((p) => lookup.entry(p)?.unit).find((u) => u !== undefined) ?? UNKNOWN_UNIT
  const kind = combinator !== undefined && DIFFERENCES.has(combinator) ? 'interval' : 'absolute'
  return { kind, unit }
}

/**
 * The Signal K groups whose children are instances, as the specification
 * names them; `null` stands for any one segment, such as a tank's type.
 */
const INSTANCE_GROUPS: readonly (readonly (string | null)[])[] = [
  ['propulsion'],
  ['electrical', 'batteries'],
  ['electrical', 'inverters'],
  ['electrical', 'chargers'],
  ['electrical', 'alternators'],
  ['electrical', 'solar'],
  ['electrical', 'ac'],
  ['electrical', 'switches'],
  ['tanks', null],
  ['environment', 'inside'],
  ['sails', 'inventory']
]

/**
 * The index of a path's instance segment, when it lies in a group with
 * instances and a leaf follows it. A path elsewhere has no segment that is
 * reliably an instance; the operator can still type `*` in its place.
 */
export function instanceSegment(path: string): number | undefined {
  const parts = segments(path)
  const group = INSTANCE_GROUPS.find(
    (g) => parts.length > g.length + 1 && g.every((s, i) => s === null || s === parts[i])
  )
  return group?.length
}

/** The path with its instance segment replaced by `*`, if it has one. */
export function withInstanceWildcard(path: string): string | undefined {
  const at = instanceSegment(path)
  if (at === undefined) return undefined
  return segments(path)
    .map((s, i) => (i === at ? '*' : s))
    .join('.')
}

/** The instance names a wildcard path matches among the reported paths, sorted. */
export function matchedInstances(pattern: string, paths: readonly PathEntry[]): string[] {
  const at = segments(pattern).indexOf('*')
  if (at < 0) return []
  const names = paths
    .filter((p) => matchesPattern(pattern, p.path))
    .map((p) => segments(p.path)[at])
  return [...new Set(names)].sort()
}
