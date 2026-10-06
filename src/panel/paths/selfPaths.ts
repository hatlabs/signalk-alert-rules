import { useEffect, useState } from 'react'
import { canonicalSourceRef } from '../../engine/sourceRefs'
import { splitPointerPath } from '../../model/pointerPath'
import { getJson, isRecord, type SignalValue } from '../api'
import { displayUnit, type DisplayUnit, type UnitMeta } from '../units'

/** A `vessels.self` path the server has a value for, as the picker lists it. */
export interface PathEntry {
  path: string
  displayName?: string
  description?: string
  /** The SI unit from meta, when the path declares one. */
  units?: string
  unit: DisplayUnit
  /**
   * The `$source`s reporting the path, for a rule input restricted to one,
   * in the canonical form rules store them in (src/engine/sourceRefs.ts).
   */
  sources?: string[]
  /** The source whose value the server reports as the path's, canonical as well. */
  preferredSource?: string
  /** The value when the paths were read, in SI; absent while it is unavailable. */
  value?: SignalValue
  /** `meta.zones`, in SI; an absent bound is open. */
  zones?: Zone[]
  /** A field's type as its metadata declares it, which holds while it has no value. */
  valueType?: FieldType
}

export type FieldType = 'number' | 'string' | 'boolean'

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

function isSignalValue(value: unknown): value is SignalValue {
  if (['number', 'string', 'boolean'].includes(typeof value)) return true
  return (
    isRecord(value) && typeof value.latitude === 'number' && typeof value.longitude === 'number'
  )
}

/**
 * Only values a rule can read (docs/rules.md, Signals) are listed: numbers,
 * strings, booleans and positions. `null` is a reading that is currently
 * unavailable, except on an object path other than a position, whose fields
 * are listed instead. Other objects, such as notifications or attitude,
 * never are.
 */
function isReadable(value: unknown, meta: Record<string, unknown>): boolean {
  if (value === null) {
    const properties = propertiesOf(meta)
    return properties === undefined || ('latitude' in properties && 'longitude' in properties)
  }
  return isSignalValue(value)
}

/** The value a display unit is resolved for, from the user's unit preferences, by SI unit. */
export type DisplayUnitsFor = (units: string) => UnitMeta['displayUnits']

function unitMeta(meta: Record<string, unknown>, displayUnitsFor?: DisplayUnitsFor): UnitMeta {
  const units = optionalString(meta.units)
  const shown = meta.displayUnits
  const formula = isRecord(shown) ? optionalString(shown.formula) : undefined
  const symbol = isRecord(shown) ? optionalString(shown.symbol) : undefined
  const displayUnits =
    formula === undefined || symbol === undefined
      ? units === undefined
        ? undefined
        : displayUnitsFor?.(units)
      : { formula, symbol }
  return {
    ...(units === undefined ? {} : { units }),
    ...(displayUnits === undefined ? {} : { displayUnits })
  }
}

/** What a path or field takes from its own meta. */
function describedBy(meta: Record<string, unknown>, displayUnitsFor?: DisplayUnitsFor) {
  const units = unitMeta(meta, displayUnitsFor)
  const displayName = optionalString(meta.displayName)
  const description = optionalString(meta.description)
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(units.units === undefined ? {} : { units: units.units }),
    unit: displayUnit(units)
  }
}

/** The sources of a node, as the paths it holds and their fields share them. */
function sourcedBy(node: Record<string, unknown>, canonical: (ref: string) => string) {
  const sources = [...new Set(sourcesOf(node).map(canonical))].sort()
  const preferred = optionalString(node.$source)
  return {
    ...(sources.length === 0 ? {} : { sources }),
    ...(preferred === undefined ? {} : { preferredSource: canonical(preferred) })
  }
}

function entry(
  path: string,
  node: Record<string, unknown>,
  canonical: (ref: string) => string
): PathEntry {
  const meta = isRecord(node.meta) ? node.meta : {}
  const zones = zonesOf(meta.zones)
  return {
    path,
    ...describedBy(meta),
    ...sourcedBy(node, canonical),
    ...(isSignalValue(node.value) ? { value: node.value } : {}),
    ...(zones.length === 0 ? {} : { zones })
  }
}

function propertiesOf(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(meta.properties) ? meta.properties : undefined
}

function fieldType(property: Record<string, unknown>): FieldType | undefined {
  switch (property.type) {
    case 'number':
    case 'integer':
      return 'number'
    case 'string':
    case 'boolean':
      return property.type
    default:
      return undefined
  }
}

// An own-key lookup, so a field named like an Object.prototype member reads as absent.
function ownField(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
}

// RFC 6901 escapes "~" before "/", so that "/" never becomes "~01".
function escapeToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * The fields of an object path, one per number, string or boolean property
 * its metadata declares, walked recursively as Skip does: their unit and
 * type from the property, their value from the object, their sources the
 * object's. A field no rule path can hold is left out.
 */
function fieldEntries(
  path: string,
  node: Record<string, unknown>,
  canonical: (ref: string) => string,
  displayUnitsFor?: DisplayUnitsFor
): PathEntry[] {
  const meta = isRecord(node.meta) ? node.meta : {}
  const sourced = sourcedBy(node, canonical)
  const fields: PathEntry[] = []
  const walk = (properties: Record<string, unknown>, value: unknown, pointer: string) => {
    for (const [key, property] of Object.entries(properties)) {
      if (!isRecord(property)) continue
      const fieldPointer = `${pointer}/${escapeToken(key)}`
      const fieldValue = ownField(value, key)
      const nested = propertiesOf(property)
      if (nested !== undefined) walk(nested, fieldValue, fieldPointer)
      const type = fieldType(property)
      const fieldPath = `${path}#${fieldPointer}`
      if (type === undefined || !splitPointerPath(fieldPath).valid) continue
      fields.push({
        path: fieldPath,
        ...describedBy(property, displayUnitsFor),
        valueType: type,
        ...sourced,
        ...(typeof fieldValue === type ? { value: fieldValue as SignalValue } : {})
      })
    }
  }
  const properties = propertiesOf(meta)
  if (properties !== undefined) walk(properties, node.value, '')
  return fields
}

/** By base path, a path before its fields, so fields sit among their siblings. */
function byPath(a: PathEntry, b: PathEntry): number {
  const [baseA, baseB] = [splitPointerPath(a.path).basePath, splitPointerPath(b.path).basePath]
  return baseA === baseB ? a.path.localeCompare(b.path) : baseA.localeCompare(baseB)
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

/**
 * The readable paths and fields in a `GET /signalk/v1/api/vessels/self`
 * body, sorted by path, their sources named canonically through the `GET
 * /signalk/v1/api/sources` body when there is one. The server resolves a
 * path's display unit but not a field's, so `displayUnitsFor` gives the
 * field's from its SI unit.
 */
export function parseSelfPaths(
  tree: unknown,
  sources?: unknown,
  displayUnitsFor?: DisplayUnitsFor
): PathEntry[] {
  if (!isRecord(tree)) throw new Error('unexpected response from /signalk/v1/api/vessels/self')
  const canonical = (ref: string) => canonicalSourceRef(sources, ref)
  const paths: PathEntry[] = []
  const walk = (node: Record<string, unknown>, prefix: string[]) => {
    if ('value' in node && prefix.length > 0) {
      const path = prefix.join('.')
      if (isReadable(node.value, isRecord(node.meta) ? node.meta : {})) {
        paths.push(entry(path, node, canonical))
      }
      paths.push(...fieldEntries(path, node, canonical, displayUnitsFor))
    }
    for (const [key, child] of Object.entries(node)) {
      if (!LEAF_KEYS.has(key) && isRecord(child)) walk(child, [...prefix, key])
    }
  }
  walk(tree, [])
  return paths.sort(byPath)
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

/** The user's unit preset and the conversions it names; undefined when unreadable. */
interface Preset {
  preset: unknown
  definitions: unknown
}

/**
 * Reads the user's unit preset the way the admin UI does
 * (packages/server-admin-ui/src/store/slices/unitPreferencesSlice.ts): the
 * user's own preset, else the server's.
 */
async function loadPreset(fetchFn: Fetch): Promise<Preset | undefined> {
  const name =
    (await presetName(fetchFn, '/signalk/v1/applicationData/user/unitpreferences/1.0.0')) ??
    (await presetName(fetchFn, '/signalk/v1/unitpreferences/config'))
  if (name === undefined) return undefined
  try {
    const [preset, definitions] = await Promise.all([
      getJson(fetchFn, `/signalk/v1/unitpreferences/presets/${encodeURIComponent(name)}`),
      getJson(fetchFn, '/signalk/v1/unitpreferences/definitions')
    ])
    return { preset, definitions }
  } catch {
    return undefined
  }
}

/** The conversion the preset picks for a category whose values are in `units`. */
function conversionFor(
  { preset, definitions }: Preset,
  category: string,
  units: string
): UnitMeta['displayUnits'] {
  const chosen =
    isRecord(preset) && isRecord(preset.categories)
      ? ownField(preset.categories, category)
      : undefined
  const target = isRecord(chosen) ? optionalString(chosen.targetUnit) : undefined
  const conversions = isRecord(definitions)
    ? ownField(ownField(definitions, units), 'conversions')
    : undefined
  const conversion = target === undefined ? undefined : ownField(conversions, target)
  return isRecord(conversion)
    ? unitMeta({ units, displayUnits: conversion }).displayUnits
    : undefined
}

/**
 * Per-path meta arrives already resolved, but a combined distance has no
 * path to carry it.
 */
async function loadDistanceUnit(fetchFn: Fetch): Promise<DisplayUnit> {
  const preset = await loadPreset(fetchFn)
  const displayUnits = preset === undefined ? undefined : conversionFor(preset, 'distance', 'm')
  return displayUnits === undefined ? SI_METRES : displayUnit({ units: 'm', displayUnits })
}

/**
 * A field's category the way the server picks one for a path with units
 * alone (getCategoryForBaseUnit in src/unitpreferences/loader.ts): the one
 * category of its SI unit, or for a unit several share, such as metres for
 * depth and distance, the primary one, else the first by name.
 */
async function loadFieldUnits(fetchFn: Fetch): Promise<DisplayUnitsFor> {
  const [preset, categories, primary] = await Promise.all([
    loadPreset(fetchFn),
    getJson(fetchFn, '/signalk/v1/unitpreferences/categories').catch(() => undefined),
    getJson(fetchFn, '/signalk/v1/unitpreferences/primary-categories').catch(() => undefined)
  ])
  const toBase =
    isRecord(categories) && isRecord(categories.categoryToBaseUnit)
      ? categories.categoryToBaseUnit
      : {}
  const primaries =
    isRecord(primary) && isRecord(primary.effectivePrimary) ? primary.effectivePrimary : {}
  return (units) => {
    if (preset === undefined) return undefined
    const candidates = Object.keys(toBase)
      .filter((c) => toBase[c] === units)
      .sort()
    const wanted = optionalString(ownField(primaries, units))
    const category = wanted !== undefined && candidates.includes(wanted) ? wanted : candidates.at(0)
    return category === undefined ? undefined : conversionFor(preset, category, units)
  }
}

/** The source over HTTP, relative to the admin UI's origin. */
export function httpPathSource(fetchFn: Fetch = (input, init) => fetch(input, init)): PathSource {
  // Read once: the paths are read again every few seconds, the preferences rarely change.
  let fieldUnits: Promise<DisplayUnitsFor> | undefined
  return {
    selfPaths: async () => {
      fieldUnits ??= loadFieldUnits(fetchFn)
      // Without the sources tree, sources are named as reported.
      const [tree, sources, displayUnitsFor] = await Promise.all([
        getJson(fetchFn, '/signalk/v1/api/vessels/self'),
        getJson(fetchFn, '/signalk/v1/api/sources').catch(() => undefined),
        fieldUnits
      ])
      return parseSelfPaths(tree, sources, displayUnitsFor)
    },
    distanceUnit: () => loadDistanceUnit(fetchFn)
  }
}

export type PathList =
  | { status: 'loading' }
  | { status: 'ready'; paths: PathEntry[] }
  | { status: 'failed'; error: string }

/** How often a view showing values as they are reads the paths again. */
export const LIVE_POLL_MS = 5000

/**
 * Loads the self paths once per source, for every picker on a form to share,
 * and again `pollMs` after each read answers when given, so the values shown
 * stay current without slow reads overlapping. A read that fails after the
 * paths have loaded keeps the paths read before.
 */
export function useSelfPaths(source: PathSource, pollMs?: number): PathList {
  const [list, setList] = useState<PathList>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setList({ status: 'loading' })
    const read = () => {
      source
        .selfPaths()
        .then(
          (paths) => {
            if (!cancelled) setList({ status: 'ready', paths })
          },
          (error: unknown) => {
            if (cancelled) return
            setList((last) =>
              last.status === 'ready'
                ? last
                : {
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error)
                  }
            )
          }
        )
        .finally(() => {
          if (!cancelled && pollMs !== undefined) timer = setTimeout(read, pollMs)
        })
    }
    read()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, pollMs])
  return list
}
