/**
 * The server's History API (`/signalk/v2/api/history`), which answers only
 * while a history provider plugin is installed.
 */
import { getJson, isRecord, malformed } from '../api'

const HISTORY_API = '/signalk/v2/api/history'

/** A span the chart offers, from the hour just gone to the week. */
export interface Span {
  seconds: number
  /** The span's chip. */
  label: string
  /** The span as a heading. */
  title: string
  /** Where the time axis starts. */
  start: string
}

const HOUR = 3600

export const SPANS: readonly Span[] = [
  { seconds: HOUR, label: '1 h', title: 'Last hour', start: '1 h ago' },
  { seconds: 6 * HOUR, label: '6 h', title: 'Last 6 hours', start: '6 h ago' },
  { seconds: 24 * HOUR, label: '24 h', title: 'Last 24 hours', start: '24 h ago' },
  { seconds: 7 * 24 * HOUR, label: '7 d', title: 'Last 7 days', start: '7 d ago' }
]

export const DEFAULT_SPAN: Span = SPANS[2]

/** How a bucket's samples become its one value. */
export type Aggregate = 'average' | 'min' | 'max'

export interface HistoryQuery {
  path: string
  method: Aggregate
  /** How far back from now. */
  seconds: number
  /** The bucket length, in seconds. */
  resolution: number
}

/** One bucket: its start in ms since the epoch, and its value in SI or null for none. */
export interface HistoryPoint {
  time: number
  value: number | null
}

/** What the chart asks of the server; tests substitute their own. */
export interface HistorySource {
  /** Whether the server has a history provider; false when it cannot tell. */
  hasProvider(): Promise<boolean>
  values(query: HistoryQuery): Promise<HistoryPoint[]>
}

/**
 * Bucket lengths a query may take. Whole steps keep a small change of width,
 * as from a scrollbar appearing, from asking again for nearly the same rows.
 */
const RESOLUTIONS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400]

/** A line drawn finer than this spends rows on detail no one can see. */
const PIXELS_PER_POINT = 2

/** The bucket length that gives a chart this wide about one point every two pixels. */
export function resolutionFor(seconds: number, widthPx: number): number {
  const wanted = seconds / Math.max(1, widthPx / PIXELS_PER_POINT)
  return RESOLUTIONS.find((r) => r >= wanted) ?? RESOLUTIONS[RESOLUTIONS.length - 1]
}

/**
 * The rows of `GET /values` for a query of one path. A value that is not a
 * finite number, or a bucket with no samples, is a gap in the line.
 */
export function parseValues(body: unknown, what: string): HistoryPoint[] {
  if (!isRecord(body) || !Array.isArray(body.data)) throw malformed(what)
  return body.data.flatMap((row: unknown) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string') return []
    const time = Date.parse(row[0])
    if (Number.isNaN(time)) return []
    const value: unknown = row[1]
    return [{ time, value: typeof value === 'number' && Number.isFinite(value) ? value : null }]
  })
}

/** The History API over HTTP, relative to the admin UI's origin. */
export function httpHistorySource(
  fetchFn: typeof fetch = (input, init) => fetch(input, init)
): HistorySource {
  // Providers are installed as plugins, so the answer holds until a reload.
  let provider: Promise<boolean> | undefined
  return {
    hasProvider: () => {
      provider ??= getJson(fetchFn, `${HISTORY_API}/_providers`).then(
        (body) => isRecord(body) && Object.keys(body).length > 0,
        () => false
      )
      return provider
    },
    values: async ({ path, method, seconds, resolution }) => {
      const query = new URLSearchParams({
        paths: `${path}:${method}`,
        duration: `PT${String(seconds)}S`,
        resolution: String(resolution)
      })
      const url = `${HISTORY_API}/values?${query.toString()}`
      return parseValues(await getJson(fetchFn, url), url)
    }
  }
}
