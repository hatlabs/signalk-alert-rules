import type { CombinatorKind } from '../model/rule.js'
import type { Position, Reading, SignalValue } from './signals.js'

const TWO_PI = 2 * Math.PI
// IUGG mean Earth radius. A sphere is within 0.5 % of the ellipsoid, far
// inside any practical position-disagreement limit.
const EARTH_RADIUS_M = 6371008.8
// Below this mean resultant length the inputs cancel out and have no mean direction.
const MIN_RESULTANT_LENGTH = 1e-9

const UNAVAILABLE: Reading = { available: false, timedOut: false }

function available(value: number): Reading {
  return Number.isFinite(value) ? { available: true, value } : UNAVAILABLE
}

function isPosition(value: SignalValue): value is Position {
  return typeof value === 'object'
}

/** Normalises an angle to [0, 2π). */
function normalise(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI
}

/** Wraps an angle difference to [-π, π). */
function wrap(delta: number): number {
  return normalise(delta + Math.PI) - Math.PI
}

function distance(a: Position, b: Position): number {
  const toRad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * toRad
  const dLon = (b.longitude - a.longitude) * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function positionSpread(positions: readonly Position[]): number {
  let max = 0
  for (const [i, a] of positions.entries()) {
    for (const b of positions.slice(i + 1)) max = Math.max(max, distance(a, b))
  }
  return max
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? Number.NaN
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? Number.NaN) + upper) / 2
}

function circularMean(angles: readonly number[]): number {
  let sin = 0
  let cos = 0
  for (const a of angles) {
    sin += Math.sin(a)
    cos += Math.cos(a)
  }
  if (Math.hypot(sin, cos) / angles.length < MIN_RESULTANT_LENGTH) return Number.NaN
  return normalise(Math.atan2(sin, cos))
}

/** The smallest arc holding every angle: the full circle minus its largest empty gap. */
function circularSpread(angles: readonly number[]): number {
  const sorted = angles.map(normalise).sort((a, b) => a - b)
  const first = sorted[0] ?? 0
  const last = sorted.at(-1) ?? 0
  let largestGap = TWO_PI - last + first
  for (const [i, a] of sorted.slice(1).entries()) {
    largestGap = Math.max(largestGap, a - (sorted[i] ?? a))
  }
  return TWO_PI - largestGap
}

function combineNumbers(kind: CombinatorKind, values: readonly number[], angular: boolean): number {
  const [a = Number.NaN, b = Number.NaN] = values
  switch (kind) {
    case 'difference':
      return angular ? wrap(a - b) : a - b
    case 'absDifference':
      return Math.abs(angular ? wrap(a - b) : a - b)
    case 'ratio':
      return b === 0 ? Number.NaN : a / b
    case 'spread':
      return angular ? circularSpread(values) : Math.max(...values) - Math.min(...values)
    case 'mean':
      return angular ? circularMean(values) : values.reduce((s, v) => s + v, 0) / values.length
    case 'median':
      return median(values)
    case 'distance':
    case 'positionSpread':
      return Number.NaN
  }
}

/**
 * Combines one value per input. Validation guarantees the input count and
 * that position combinators get positions; a value of the wrong kind at run
 * time makes the result unavailable.
 */
export function combine(
  kind: CombinatorKind,
  values: readonly SignalValue[],
  angular: boolean
): Reading {
  if (kind === 'distance' || kind === 'positionSpread') {
    if (!values.every(isPosition)) return UNAVAILABLE
    return available(positionSpread(values))
  }
  if (!values.every((v): v is number => typeof v === 'number')) return UNAVAILABLE
  return available(combineNumbers(kind, values, angular))
}
