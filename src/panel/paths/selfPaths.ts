import { useEffect, useState } from 'react'
import { getJson, isRecord } from '../api'
import { displayUnit, type DisplayUnit, type UnitMeta } from '../units'

/** A `vessels.self` path the server has a value for, as the picker lists it. */
export interface PathEntry {
  path: string
  displayName?: string
  description?: string
  /** The SI unit from meta, when the path declares one. */
  units?: string
  unit: DisplayUnit
  /** The `$source`s reporting the path, for a rule input restricted to one. */
  sources?: string[]
  /** `meta.zones`, in SI; an absent bound is open. */
  zones?: Zone[]
}

export interface Zone {
  lower?: number
  upper?: number
  state: string
}

/** What the path picker and unit fields ask of the server; tests substitute their own. */
export interface PathSource {
  selfPaths(): Promise<PathEntry[]>
  /** The unit distances (the distance and position spread combinators) are entered in. */
  distanceUnit(): Promise<DisplayUnit>
}

/** Keys of a Signal K tree node that hold data about the path rather than child paths. */
const LEAF_KEYS = new Set(['value', 'values', 'meta', '$source', 'timestamp', 'pgn', 'sentence'])

const SI_METRES: DisplayUnit = displayUnit({ units: 'm' })

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Only values a rule can read (docs/rules.md, Signals) are listed: numbers,
 * strings, booleans and positions. `null` is a reading that is currently
 * unavailable. Other objects, such as notifications or attitude, never are.
 */
function isReadable(value: unknown): boolean {
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return true
  return (
    isRecord(value) && typeof value.latitude === 'number' && typeof value.longitude === 'number'
  )
}

function unitMeta(meta: Record<string, unknown>): UnitMeta {
  const units = optionalString(meta.units)
  const shown = meta.displayUnits
  const formula = isRecord(shown) ? optionalString(shown.formula) : undefined
  const symbol = isRecord(shown) ? optionalString(shown.symbol) : undefined
  return {
    ...(units === undefined ? {} : { units }),
    ...(formula === undefined || symbol === undefined ? {} : { displayUnits: { formula, symbol } })
  }
}

function entry(path: string, node: Record<string, unknown>): PathEntry {
  const meta = isRecord(node.meta) ? node.meta : {}
  const units = unitMeta(meta)
  const displayName = optionalString(meta.displayName)
  const description = optionalString(meta.description)
  const sources = sourcesOf(node)
  const zones = zonesOf(meta.zones)
  return {
    path,
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(units.units === undefined ? {} : { units: units.units }),
    unit: displayUnit(units),
    ...(sources.length === 0 ? {} : { sources }),
    ...(zones.length === 0 ? {} : { zones })
  }
}

function zonesOf(value: unknown): Zone[] {
  if (!Array.isArray(value)) return []
  const bound = (v: unknown) => v === undefined || v === null || typeof v === 'number'
  return value.flatMap((z): Zone[] => {
    if (!isRecord(z) || typeof z.state !== 'string' || !bound(z.lower) || !bound(z.upper)) {
      return []
    }
    return [
      {
        ...(typeof z.lower === 'number' ? { lower: z.lower } : {}),
        ...(typeof z.upper === 'number' ? { upper: z.upper } : {}),
        state: z.state
      }
    ]
  })
}

/**
 * The server keeps a path's reading from each source under `values` once a
 * second source reports it; a path with one source carries only `$source`.
 */
function sourcesOf(node: Record<string, unknown>): string[] {
  if (isRecord(node.values)) return Object.keys(node.values).sort()
  const only = optionalString(node.$source)
  return only === undefined ? [] : [only]
}

/** The readable paths in a `GET /signalk/v1/api/vessels/self` body, sorted by path. */
export function parseSelfPaths(tree: unknown): PathEntry[] {
  if (!isRecord(tree)) throw new Error('unexpected response from /signalk/v1/api/vessels/self')
  const paths: PathEntry[] = []
  const walk = (node: Record<string, unknown>, prefix: string[]) => {
    if ('value' in node && prefix.length > 0 && isReadable(node.value)) {
      paths.push(entry(prefix.join('.'), node))
    }
    for (const [key, child] of Object.entries(node)) {
      if (!LEAF_KEYS.has(key) && isRecord(child)) walk(child, [...prefix, key])
    }
  }
  walk(tree, [])
  return paths.sort((a, b) => a.path.localeCompare(b.path))
}

type Fetch = typeof fetch

async function presetName(fetchFn: Fetch, url: string): Promise<string | undefined> {
  try {
    const body = await getJson(fetchFn, url)
    return isRecord(body) ? optionalString(body.activePreset) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolves the distance category of the user's unit preset the way the admin
 * UI does (packages/server-admin-ui/src/store/slices/unitPreferencesSlice.ts):
 * the user's own preset, else the server's. Per-path meta arrives already
 * resolved, but a combined distance has no path to carry it.
 */
async function loadDistanceUnit(fetchFn: Fetch): Promise<DisplayUnit> {
  const name =
    (await presetName(fetchFn, '/signalk/v1/applicationData/user/unitpreferences/1.0.0')) ??
    (await presetName(fetchFn, '/signalk/v1/unitpreferences/config'))
  if (name === undefined) return SI_METRES
  try {
    const [preset, definitions] = await Promise.all([
      getJson(fetchFn, `/signalk/v1/unitpreferences/presets/${encodeURIComponent(name)}`),
      getJson(fetchFn, '/signalk/v1/unitpreferences/definitions')
    ])
    const category =
      isRecord(preset) && isRecord(preset.categories) ? preset.categories.distance : undefined
    const target = isRecord(category) ? optionalString(category.targetUnit) : undefined
    const metres = isRecord(definitions) ? definitions.m : undefined
    const conversions = isRecord(metres) ? metres.conversions : undefined
    const conversion =
      target !== undefined && isRecord(conversions) ? conversions[target] : undefined
    if (!isRecord(conversion)) return SI_METRES
    return displayUnit(unitMeta({ units: 'm', displayUnits: conversion }))
  } catch {
    return SI_METRES
  }
}

/** The source over HTTP, relative to the admin UI's origin. */
export function httpPathSource(fetchFn: Fetch = (input, init) => fetch(input, init)): PathSource {
  return {
    selfPaths: async () => parseSelfPaths(await getJson(fetchFn, '/signalk/v1/api/vessels/self')),
    distanceUnit: () => loadDistanceUnit(fetchFn)
  }
}

export type PathList =
  | { status: 'loading' }
  | { status: 'ready'; paths: PathEntry[] }
  | { status: 'failed'; error: string }

/** Loads the self paths once per source, for every picker on a form to share. */
export function useSelfPaths(source: PathSource): PathList {
  const [list, setList] = useState<PathList>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    setList({ status: 'loading' })
    source.selfPaths().then(
      (paths) => {
        if (!cancelled) setList({ status: 'ready', paths })
      },
      (error: unknown) => {
        if (!cancelled) {
          setList({
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [source])
  return list
}
