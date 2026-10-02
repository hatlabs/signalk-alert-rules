/**
 * Where the history chart draws its line and limits, and what it says about
 * them, from values already in display units.
 */
import type { HistoryPoint } from './historySource'

/** The chart's height in pixels; its width is the space it is given. */
export const CHART_HEIGHT = 110

/** The band the values are drawn in; below it go the time labels. */
const PLOT_TOP = 10
const PLOT_BOTTOM = 88
/** Room each limit's label takes above or below its line. */
const LABEL_RISE = 5
const LABEL_DROP = 14
const LABEL_HEIGHT = 12

/** A bucket this many lengths after the last is past a stretch nothing was recorded in. */
const GAP_BUCKETS = 2

/** Share of the value range left free above and below, so the line does not touch the edges. */
const HEADROOM = 0.12

export interface ChartLimit {
  value: number
  label: string
  /** The step's priority, or `limit` for a rule with one step. */
  tone: string
}

export interface ChartFrame {
  from: number
  to: number
  width: number
  /** The bucket length, in seconds. */
  resolution: number
}

export interface PlacedLimit extends ChartLimit {
  y: number
  labelY: number
}

export interface ChartGeometry {
  /** Each unbroken run of values, as a polyline's points. */
  lines: string[]
  limits: PlacedLimit[]
}

type Valued = HistoryPoint & { value: number }

const hasValue = (p: HistoryPoint): p is Valued => p.value !== null

/** The runs of values the line draws unbroken. */
function runs(points: readonly HistoryPoint[], resolution: number): Valued[][] {
  const maxStep = GAP_BUCKETS * resolution * 1000
  const out: Valued[][] = []
  let current: Valued[] = []
  let last: number | undefined
  for (const point of points) {
    const broken = !hasValue(point) || (last !== undefined && point.time - last > maxStep)
    if (broken && current.length > 0) {
      out.push(current)
      current = []
    }
    if (hasValue(point)) current.push(point)
    last = point.time
  }
  if (current.length > 0) out.push(current)
  return out
}

/** The value range drawn: the values and limits, with headroom, never empty. */
function domain(values: readonly number[]): [number, number] {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const range = hi - lo || Math.max(Math.abs(hi) * 0.1, 1)
  const pad = range * HEADROOM
  return hi === lo ? [lo - range / 2, hi + range / 2] : [lo - pad, hi + pad]
}

const round = (n: number) => Math.round(n * 10) / 10

export function chartGeometry(
  points: readonly HistoryPoint[],
  limits: readonly ChartLimit[],
  frame: ChartFrame
): ChartGeometry {
  const valued = points.filter(hasValue)
  if (valued.length === 0) return { lines: [], limits: [] }
  const [lo, hi] = domain([...valued.map((p) => p.value), ...limits.map((l) => l.value)])
  const y = (v: number) => round(PLOT_BOTTOM - ((v - lo) / (hi - lo)) * (PLOT_BOTTOM - PLOT_TOP))
  const span = frame.to - frame.from
  const x = (t: number) =>
    round(Math.min(frame.width, Math.max(0, ((t - frame.from) / span) * frame.width)))

  const lines = runs(points, frame.resolution).map((run) => {
    const vertices = run.map((p) => `${String(x(p.time))},${String(y(p.value))}`)
    // A polyline of one vertex draws nothing; a value alone between gaps shows as a dot.
    if (run.length === 1) {
      const at = x(run[0].time)
      return `${String(at - 1)},${String(y(run[0].value))} ${String(at + 1)},${String(y(run[0].value))}`
    }
    return vertices.join(' ')
  })

  // Labels go above their lines, top first; one that would overlap the
  // label before it goes below its line instead.
  let lowestLabel = -Infinity
  const placed = limits
    .map((limit) => ({ ...limit, y: y(limit.value) }))
    .sort((a, b) => a.y - b.y)
    .map((limit) => {
      const above = limit.y - LABEL_RISE
      const labelY =
        above - LABEL_HEIGHT >= lowestLabel && above - LABEL_HEIGHT >= 0
          ? above
          : limit.y + LABEL_DROP
      lowestLabel = labelY
      return { ...limit, labelY }
    })
  return { lines, limits: placed }
}

/** A limit to compare the history with, in step order, and its step's priority when there are several. */
export interface SummaryLimit {
  value: number
  priority?: string
}

/**
 * The extreme on the rule's side and when it was, and whether it passed a
 * limit. Passing one is not saying the rule would have alerted: the buckets
 * do not tell whether it held for the rule's duration. Not passing one does
 * say it, as each bucket keeps its extreme.
 */
export function historySummary(
  points: readonly HistoryPoint[],
  side: 'below' | 'above',
  limits: readonly SummaryLimit[],
  words: { value: (v: number) => string; time: (ms: number) => string }
): string | undefined {
  const valued = points.filter(hasValue)
  if (valued.length === 0) return undefined
  const beyond = (a: number, b: number) => (side === 'below' ? a < b : a > b)
  const extreme = valued.reduce((best, p) => (beyond(p.value, best.value) ? p : best))
  const found = `${side === 'below' ? 'Lowest' : 'Highest'} ${words.value(extreme.value)} at ${words.time(extreme.time)}.`
  if (limits.length === 0) return found
  const passed = limits.filter((l) => beyond(extreme.value, l.value))
  const furthest = passed.at(-1)
  if (furthest === undefined) return `${found} The rule would not have alerted.`
  const which = limits.length > 1 && furthest.priority !== undefined ? `${furthest.priority} ` : ''
  return `${found} It went ${side} the ${which}limit.`
}
