/**
 * The server's History API (`/signalk/v2/api/history`), which answers only
 * while a history provider plugin is installed.
 */
import { resolvePointer, splitPointerPath } from '../../model/pointerPath'
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

/**
 * How a bucket's samples become its one value. A field's object path takes
 * only `last` of these: providers refuse to average or compare objects.
 */
export type Aggregate = 'average' | 'min' | 'max' | 'last'

export interface HistoryQuery {
  /** A path, or a field of one (`navigation.attitude#/roll`). */
  path: string
  /** One series is answered per aggregate, in this order. */
  methods: readonly Aggregate[]
  /** The one source to read, as a rule pinned to it does; absent for whichever the provider records. */
  source?: string
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

/** A series per aggregate, by its name. */
export type HistorySeries = Partial<Record<Aggregate, HistoryPoint[]>>

/** What the chart asks of the server; tests substitute their own. */
export interface HistorySource {
  /** Whether the server has a history provider; false when it cannot tell. */
  hasProvider(): Promise<boolean>
  /** A series for each aggregate asked. */
  values(query: HistoryQuery): Promise<HistorySeries>
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
 * The rows of `GET /values` for a query of one path, as a series per
 * aggregate asked. The body names each column's aggregate, which places it,
 * and an aggregate it does not name has no values; only a body naming none
 * has its columns taken in the order asked. A value that is not a finite
 * number, or a bucket with no samples, is a gap in the line.
 *
 * @param tokens the pointer to the field read from each bucket's object
 *   value; none to read the value itself
 */
export function parseValues(
  body: unknown,
  what: string,
  methods: readonly Aggregate[],
  tokens: readonly string[] = []
): HistorySeries {
  if (!isRecord(body) || !Array.isArray(body.data)) throw malformed(what)
  const listed: unknown[] | undefined = Array.isArray(body.values) ? body.values : undefined
  const rows = body.data.flatMap((row: unknown) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string') return []
    const time = Date.parse(row[0])
    return Number.isNaN(time) ? [] : [{ time, row: row as unknown[] }]
  })
  const series: HistorySeries = {}
  methods.forEach((method, asked) => {
    const at =
      listed === undefined
        ? asked
        : listed.findIndex((v: unknown) => isRecord(v) && v.method === method)
    series[method] = rows.map(({ time, row }) => {
      const value = at === -1 ? undefined : resolvePointer(row[1 + at], tokens)
      return { time, value: typeof value === 'number' && Number.isFinite(value) ? value : null }
    })
  })
  return series
}

/** The History API over HTTP, relative to the admin UI's origin. */
export function httpHistorySource(
  fetchFn: typeof fetch = (input, init) => fetch(input, init)
): HistorySource {
  // Providers are installed as plugins, so an answer holds until a reload. A
  // failed check is not one, as while the server restarts after an install.
  let provider: Promise<boolean> | undefined
  return {
    hasProvider: () => {
      provider ??= getJson(fetchFn, `${HISTORY_API}/_providers`).then(
        (body) => isRecord(body) && Object.keys(body).length > 0,
        () => {
          provider = undefined
          return false
        }
      )
      return provider
    },
    values: async ({ path, methods, source, seconds, resolution }) => {
      // The server strips "#" and "/" from the paths asked, so a field is
      // asked for by its object path, whose buckets carry the whole object.
      const split = splitPointerPath(path)
      const tokens = split.valid ? split.tokens : []
      const pinned = source === undefined ? '' : `|${source}`
      const query = new URLSearchParams({
        paths: methods.map((method) => `${split.basePath}:${method}${pinned}`).join(','),
        duration: `PT${String(seconds)}S`,
        resolution: String(resolution)
      })
      const url = `${HISTORY_API}/values?${query.toString()}`
      return parseValues(await getJson(fetchFn, url), url, methods, tokens)
    }
  }
}
