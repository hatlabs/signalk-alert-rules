/**
 * Alert paths in the Signal K data model: the parent of the data a rule
 * reads, and a segment naming the condition (`electrical.batteries.house` +
 * `voltageLow`). The webapp derives the same paths with this module, so it
 * imports only types.
 */
import type { Detector } from '../model/rule.js'
import { isRecord, own } from '../util.js'

const DELTA_PREFIX = 'alerts.'

/** Core's limits on an alert path (signalk-server src/api/alerts/alertPath.ts). */
export const MAX_ALERT_PATH_LENGTH = 255
/** One segment's characters, as a pattern source, for schemas to build on. */
export const SEGMENT_CHARS = '[A-Za-z0-9_-]+'
export const ALERT_PATH_SEGMENT = new RegExp(`^${SEGMENT_CHARS}$`)
export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
])

export const WILDCARD = '*'

const INVALID_SEGMENT_CHARS = /[^A-Za-z0-9_-]/g
const INVALID_RUNS = /[^A-Za-z0-9_-]+/

/** Whether core accepts the segment in an alert path or a reference. */
export function segmentAccepted(segment: string): boolean {
  return ALERT_PATH_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment)
}

/**
 * Whether core accepts the path as an alert path or a reference; core
 * checks both alike.
 */
export function acceptedByCore(path: string): boolean {
  return path.length <= MAX_ALERT_PATH_LENGTH && path.split('.').every(segmentAccepted)
}

/** The path with an instance's segment or name in place of its wildcard. */
export function fillWildcard(path: string, instance: string): string {
  return path
    .split('.')
    .map((s) => (s === WILDCARD ? instance : s))
    .join('.')
}

/** A name made into one segment core accepts. */
export function sanitiseSegment(name: string): string {
  return name.replace(INVALID_SEGMENT_CHARS, '_')
}

type Of<T extends Detector['type']> = Extract<Detector, { type: T }>

/**
 * What a detector's condition adds to its input's leaf to name the
 * condition: fixed by its type, or chosen by the value of one of its fields.
 */
type Suffix = string | { field: 'direction' | 'op'; by: Readonly<Record<string, string>> }

const SUFFIX: Readonly<Record<Detector['type'], Suffix>> = {
  sustained: {
    field: 'direction',
    by: { above: 'High', below: 'Low' } satisfies Record<Of<'sustained'>['direction'], string>
  },
  projection: {
    field: 'direction',
    by: { rising: 'ProjectedHigh', falling: 'ProjectedLow' } satisfies Record<
      Of<'projection'>['direction'],
      string
    >
  },
  slope: {
    field: 'direction',
    by: { rising: 'Rising', falling: 'Falling' } satisfies Record<Of<'slope'>['direction'], string>
  },
  match: {
    field: 'op',
    by: {
      equals: 'Match',
      notEquals: 'Mismatch',
      changesTo: 'Changed',
      decreases: 'Decreased',
      timedOut: 'TimedOut'
    } satisfies Record<Of<'match'>['op'], string>
  },
  outside: 'OutOfRange',
  accumulator: 'Accumulated',
  count: 'Frequent',
  absence: 'Missing'
}

/**
 * The suffix of a detector document's condition name, or undefined while
 * the document lacks the type or the field its suffix is chosen by. Reads an
 * unvalidated document too, such as the editor's unfinished one.
 */
function conditionSuffix(detector: unknown): string | undefined {
  if (!isRecord(detector) || typeof detector.type !== 'string') return undefined
  const suffix = own(SUFFIX, detector.type)
  if (suffix === undefined || typeof suffix === 'string') return suffix
  const value = detector[suffix.field]
  return typeof value === 'string' ? own(suffix.by, value) : undefined
}

/** The leaf as a camelCase segment: runs of characters core refuses become word breaks. */
function camelSegment(leaf: string): string {
  const [first = '', ...rest] = leaf.split(INVALID_RUNS).filter((part) => part !== '')
  return first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

/**
 * The single data path a signal reads, or undefined for a combined signal,
 * whose inputs have no one parent. Reads an unvalidated document too.
 */
export function singlePath(signal: unknown): string | undefined {
  return isRecord(signal) && !('combinator' in signal) && typeof signal.path === 'string'
    ? signal.path
    : undefined
}

/** A data path's segments as alert path segments: sanitised, the wildcard kept. */
function alertSegments(path: string): string[] {
  return path.split('.').map((s) => (s === WILDCARD ? s : sanitiseSegment(s)))
}

/** The segments the paths all start with. */
function commonPrefix(paths: readonly string[][]): string[] {
  const [first = [], ...rest] = paths
  const length = first.findIndex((s, i) => rest.some((p) => p[i] !== s))
  return length === -1 ? first : first.slice(0, length)
}

/**
 * The segments an alert path's condition name goes under, which the input
 * gives and no one edits: a single input's parent path, or the whole path
 * when its leaf is the wildcard, so that each instance has an alert of its
 * own; for a combined signal, the longest common prefix of its inputs'
 * parents, which may be empty. A wildcard stays for each instance to fill.
 * Undefined for a malformed signal; reads an unvalidated document too.
 */
export function alertParent(signal: unknown): string[] | undefined {
  const path = singlePath(signal)
  if (path !== undefined) {
    const segments = alertSegments(path)
    return segments.at(-1) === WILDCARD ? segments : segments.slice(0, -1)
  }
  if (!isRecord(signal) || !Array.isArray(signal.inputs)) return undefined
  const paths: unknown[] = signal.inputs.map((input) => (isRecord(input) ? input.path : undefined))
  if (!paths.every((p) => typeof p === 'string')) return undefined
  return commonPrefix(paths.map((p) => alertSegments(p).slice(0, -1)))
}

/**
 * The condition name a rule gets when it stores none: its input's leaf
 * plus what its detector adds (`voltage` below a limit is `voltageLow`).
 * Undefined for a combined signal and a wildcard leaf, which have no leaf to
 * name it by, and while the detector is incomplete. Reads an unvalidated
 * document too.
 */
export function defaultCondition(signal: unknown, detector: unknown): string | undefined {
  const leaf = singlePath(signal)?.split('.').at(-1)
  const suffix = conditionSuffix(detector)
  if (leaf === undefined || leaf === WILDCARD || suffix === undefined) return undefined
  return camelSegment(leaf) + suffix
}

/** The parts of a rule its alert path comes from. */
export interface AlertPathParts {
  signal?: unknown
  detector?: unknown
  condition?: unknown
}

/**
 * The path of a rule's alert in core, without the `alerts.` prefix: its
 * condition name, stored or else the default, under its {@link alertParent}
 * (`electrical.batteries.house.voltageLow`). Undefined while there is no
 * condition name to use. Reads an unvalidated document too.
 */
export function alertPathOf(rule: AlertPathParts): string | undefined {
  const parent = alertParent(rule.signal)
  const condition =
    typeof rule.condition === 'string'
      ? rule.condition
      : defaultCondition(rule.signal, rule.detector)
  if (parent === undefined || condition === undefined) return undefined
  return [...parent, condition].join('.')
}

/** The number of wildcard segments in a dot-separated path. */
export function wildcards(path: string): number {
  return path.split('.').filter((s) => s === WILDCARD).length
}

/**
 * Whether two alert paths could name the same alert: equal, or equal once a
 * wildcard in either takes some instance's segment.
 */
export function alertPathsOverlap(a: string, b: string): boolean {
  const x = a.split('.')
  const y = b.split('.')
  return (
    x.length === y.length && x.every((s, i) => s === y[i] || s === WILDCARD || y[i] === WILDCARD)
  )
}

/**
 * The instance segment of a concrete alert path under a rule's alert path,
 * matched at the wildcard. `{}` for a rule without a wildcard whose path it
 * is; undefined when the path is not the rule's.
 */
export function matchAlertPath(pattern: string, path: string): { segment?: string } | undefined {
  const expected = pattern.split('.')
  const actual = path.split('.')
  if (expected.length !== actual.length) return undefined
  let segment: string | undefined
  for (const [i, s] of expected.entries()) {
    const got = actual[i] ?? ''
    if (s === WILDCARD) segment = got
    else if (s !== got) return undefined
  }
  return segment === undefined ? {} : { segment }
}

/**
 * The path, under `alerts.`, of the alert a rule raises: its alert path,
 * with the instance segment in place of the wildcard for a wildcard rule.
 */
export function instanceAlertPath(
  alertPath: string,
  instance?: string
): { ok: true; value: string } | { ok: false } {
  const path = instance === undefined ? alertPath : fillWildcard(alertPath, instance)
  return acceptedByCore(path) ? { ok: true, value: path } : { ok: false }
}

/** The delta path that raises or clears the alert at a core alert path. */
export function deltaPath(path: string): string {
  return DELTA_PREFIX + path
}
