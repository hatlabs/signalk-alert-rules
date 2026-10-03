import { useEffect, useId, useLayoutEffect, useState } from 'react'
import { formatNumber } from '../../format'
import type { Measure } from '../signalUnits'
import { fromSI } from '../units'
import {
  AXIS_LABEL_Y,
  CHART_HEIGHT,
  chartGeometry,
  historySummary,
  type SummaryLimit,
  type SummaryRule
} from './chart'
import {
  DEFAULT_SPAN,
  resolutionFor,
  SPANS,
  type Aggregate,
  type HistorySeries,
  type HistorySource,
  type Span
} from './historySource'

/** What to chart: one path, how its buckets aggregate, and the limits to draw. */
export interface ChartSpec {
  path: string
  /** A line per aggregate: an outside rule's lowest and highest, in that order, else one. */
  methods: readonly Aggregate[]
  /** The source the rule is pinned to; absent for the preferred one. */
  source?: string
  /** How the recorded SI values are shown. */
  measure: Measure
  /** The limits in display units, in step order, each with its priority when there are several. */
  limits: SummaryLimit[]
  /** The side the rule alerts on, whose extreme the summary names; absent for none. */
  side?: SummaryRule['side']
  /** Whether the summary may say the rule would not have alerted; see `SummaryRule`. */
  verdict: boolean
}

export interface HistoryChartProps {
  history: HistorySource
  /**
   * Undefined while there is nothing to chart, as while the editor's path is
   * cleared to type another; the chart then shows nothing but keeps its span.
   */
  spec: ChartSpec | undefined
  /** The heading; the span's own when absent. */
  title?: string
}

interface ChartProps {
  history: HistorySource
  spec: ChartSpec
  title: string | undefined
  span: Span
  onSpan: (span: Span) => void
}

/** The width drawn for until the chart's own is known, as where nothing is laid out. */
const FALLBACK_WIDTH = 360

/** Room between a limit's label and the chart's right edge. */
const LIMIT_LABEL_INSET = 4

/**
 * An answer and the frame it was asked in: the span ending when it arrived,
 * and the bucket length asked for. `of` names the path, aggregates, source and
 * span, but not the bucket length, so an answer for another width still fits.
 */
type Loaded =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready'
      series: HistorySeries
      of: string
      to: number
      seconds: number
      resolution: number
    }

/** The chart's width, following it as the layout changes; observed once per element. */
function useWidth(): [(element: HTMLDivElement | null) => void, number | undefined] {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (element === null) return undefined
    const measure = () => {
      setWidth(element.clientWidth > 0 ? element.clientWidth : FALLBACK_WIDTH)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [element])
  return [setElement, width]
}

function timeOf(span: Span): (ms: number) => string {
  const options: Intl.DateTimeFormatOptions =
    span.seconds > DEFAULT_SPAN.seconds
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }
  return (ms) => new Date(ms).toLocaleString(undefined, options)
}

/**
 * Whether the server has a history provider, asked after the page around the
 * chart has rendered; undefined until it answers.
 */
function useProvider(history: HistorySource): boolean | undefined {
  const [provider, setProvider] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void history.hasProvider().then((has) => {
      if (!cancelled) setProvider(has)
    })
    return () => {
      cancelled = true
    }
  }, [history])
  return provider
}

/**
 * The path's recorded values over a chosen span with the rule's limits
 * across them. Without a history provider it shows nothing; a query that
 * fails says so quietly, as the chart only adds to the page around it.
 */
export function HistoryChart({ history, spec, title }: HistoryChartProps) {
  const provider = useProvider(history)
  const [span, setSpan] = useState<Span>(DEFAULT_SPAN)
  if (provider !== true || spec === undefined) return null
  return <Chart history={history} spec={spec} title={title} span={span} onSpan={setSpan} />
}

function Chart({ history, spec, title, span, onSpan }: ChartProps) {
  const titleId = useId()
  const [ref, width] = useWidth()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const resolution = width === undefined ? undefined : resolutionFor(span.seconds, width)
  const { path, methods, source, measure } = spec
  // A spec is built afresh on each render, so its list of aggregates is too; their names are not.
  const asked = methods.join(',')
  const of = `${path}:${asked}|${source ?? ''}:${String(span.seconds)}`

  useEffect(() => {
    if (resolution === undefined) return undefined
    let cancelled = false
    let next: ReturnType<typeof setTimeout> | undefined
    const { seconds } = span
    // A new width asks for finer or coarser buckets of the same line; the
    // line drawn stays until they come, rather than blinking out.
    setLoaded((last) => (last.status === 'ready' && last.of === of ? last : { status: 'loading' }))
    // Once a bucket's length has passed a new bucket may have closed, so a
    // chart left open asks again, keeping the line drawn while it does.
    const ask = () => {
      const again = () => {
        if (!cancelled) next = setTimeout(ask, resolution * 1000)
      }
      history.values({ path, methods, source, seconds, resolution }).then(
        (series) => {
          if (cancelled) return
          setLoaded({ status: 'ready', series, of, to: Date.now(), seconds, resolution })
          again()
        },
        () => {
          if (cancelled) return
          // A refresh that fails leaves the line already drawn: its data still holds.
          setLoaded((last) =>
            last.status === 'ready' && last.of === of ? last : { status: 'failed' }
          )
          again()
        }
      )
    }
    ask()
    return () => {
      cancelled = true
      clearTimeout(next)
    }
  }, [history, path, asked, source, span, resolution, of])

  // Until the effect above has asked for a changed spec, as on the render
  // after an editor's kind or path changes, the last answer is of another.
  const current: Loaded =
    loaded.status === 'ready' && loaded.of !== of ? { status: 'loading' } : loaded

  const symbol = measure.kind === 'ratio' ? '' : measure.unit.symbol
  const shown = (v: number) => (symbol === '' ? formatNumber(v) : `${formatNumber(v)} ${symbol}`)
  const series: HistorySeries = {}
  if (current.status === 'ready') {
    for (const method of methods) {
      series[method] = current.series[method]?.map((p) => ({
        time: p.time,
        value: p.value === null ? null : fromSI(measure.kind, p.value, measure.unit)
      }))
    }
  }
  const drawn = methods.map((method) => series[method] ?? [])
  const recorded = drawn.some((points) => points.some((p) => p.value !== null))
  const several = spec.limits.length > 1
  const limits = spec.limits.map((l) => ({
    value: l.value,
    label: `${several ? (l.priority ?? 'step') : 'limit'} ${shown(l.value)}`,
    tone: several ? (l.priority ?? 'limit') : 'limit',
    bound: l.bound
  }))
  const drawnWidth = width ?? FALLBACK_WIDTH
  // Drawn in the frame the answer was asked in, so the line holds still
  // between answers however often the page around it renders.
  const geometry =
    current.status === 'ready'
      ? chartGeometry(drawn, limits, {
          from: current.to - current.seconds * 1000,
          to: current.to,
          width: drawnWidth,
          resolution: current.resolution
        })
      : { lines: [], limits: [] }
  const summary =
    spec.side === undefined
      ? undefined
      : historySummary(
          series,
          { side: spec.side, limits: spec.limits, verdict: spec.verdict },
          { value: shown, time: timeOf(span) }
        )
  const withLimits = limits.length === 0 ? '' : several ? ' with the limits' : ' with the limit'
  const note =
    current.status === 'failed'
      ? 'History unavailable.'
      : current.status === 'ready' && !recorded
        ? `Nothing recorded in the ${span.title.toLowerCase()}.`
        : undefined

  return (
    <section className="skar-card skar-history" aria-labelledby={titleId}>
      <div className="skar-history-head">
        <h3 id={titleId} className="skar-card-title">
          {title ?? span.title}
        </h3>
        <div role="group" aria-label="Span" className="skar-spans">
          {SPANS.map((s) => (
            <button
              key={s.label}
              type="button"
              className="skar-span"
              aria-pressed={s === span}
              onClick={() => {
                onSpan(s)
              }}
            >
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div ref={ref} className="skar-history-plot">
        {current.status === 'loading' && (
          <p className="skar-history-note" style={{ height: CHART_HEIGHT }}>
            Loading history…
          </p>
        )}
        {recorded && (
          <svg
            width={drawnWidth}
            height={CHART_HEIGHT}
            viewBox={`0 0 ${String(drawnWidth)} ${String(CHART_HEIGHT)}`}
            role="img"
            aria-label={`${span.title}${withLimits}`}
          >
            {/* Steps may share a label, so their place in the list is their key. */}
            {geometry.limits.map((l, i) => (
              <g key={i} className={`skar-history-limit skar-history-limit-${l.tone}`}>
                <line x1={0} y1={l.y} x2={drawnWidth} y2={l.y} />
              </g>
            ))}
            {/* An outside rule's lowest and highest can draw the same points, so they key by place. */}
            {geometry.lines.map((runs, s) =>
              runs.map((line, r) => (
                <polyline
                  key={`${String(s)}-${String(r)}`}
                  className="skar-history-line"
                  points={line}
                />
              ))
            )}
            {/* The labels go over the line, so it never hides one. */}
            {geometry.limits.map((l, i) => (
              <g key={i} className={`skar-history-limit skar-history-limit-${l.tone}`}>
                {l.labelY !== undefined && (
                  <text x={drawnWidth - LIMIT_LABEL_INSET} y={l.labelY} textAnchor="end">
                    {l.label}
                  </text>
                )}
              </g>
            ))}
            <text className="skar-history-axis" x={0} y={AXIS_LABEL_Y}>
              {span.start}
            </text>
            <text className="skar-history-axis" x={drawnWidth} y={AXIS_LABEL_Y} textAnchor="end">
              now
            </text>
          </svg>
        )}
        {/* One region, mounted throughout, so each answer's words are announced. */}
        <div role="status" className="skar-history-status">
          {note !== undefined && (
            <p className="skar-history-note" style={{ height: CHART_HEIGHT }}>
              {note}
            </p>
          )}
          {note === undefined && summary !== undefined && <p className="skar-hint">{summary}</p>}
        </div>
      </div>
    </section>
  )
}
