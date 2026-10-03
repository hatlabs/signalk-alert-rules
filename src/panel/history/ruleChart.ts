/**
 * Which rules get a history chart, and what it draws: one concrete numeric
 * path, compared with a limit or watched for its rate of change. The
 * History API records paths, not a rule's combined or per-instance signal.
 */
import type { RuleInfo } from '../api'
import type { Aggregate } from './historySource'
import {
  isZoneLimited,
  parsedNumber,
  signalShape,
  type RuleForm,
  type StepForm
} from '../editor/formModel'
import { signalMeasure, type SignalShape, type UnitLookup } from '../signalUnits'
import { fromSI } from '../units'
import type { SummaryLimit } from './chart'
import type { ChartSpec } from './HistoryChart'

type Side = NonNullable<ChartSpec['side']>

/** The detectors whose condition is on the value itself, by their direction. */
const SIDES: Readonly<Partial<Record<string, Partial<Record<string, Side>>>>> = {
  sustained: { below: 'below', above: 'above' },
  projection: { falling: 'below', rising: 'above' },
  slope: { falling: 'below', rising: 'above' }
}

/** The side a rule alerts on, or undefined for a kind whose condition is not on the value. */
function sideOf(type: string, direction: string | undefined): Side | undefined {
  return type === 'outside' ? 'outside' : SIDES[type]?.[direction ?? '']
}

/** A slope's limit is a rate, which has no place on the value axis. */
const VALUE_LIMITED = new Set(['sustained', 'projection', 'outside'])

/** The detectors that alert on the recorded value itself, rather than one ahead of it. */
const JUDGED = new Set(['sustained', 'outside'])

/**
 * Each bucket keeps its extreme on the rule's side, so a dip shorter than a
 * bucket still shows, and a limit never passed was never passed; an outside
 * rule's has both.
 */
const EXTREMES: Readonly<Record<Side, readonly Aggregate[]>> = {
  below: ['min'],
  above: ['max'],
  outside: ['min', 'max']
}

const AVERAGE: readonly Aggregate[] = ['average']

function specOf(
  signal: SignalShape,
  type: string,
  side: Side | undefined,
  /** Each step's limits, in step order. */
  steps: SummaryLimit[][],
  source: string | undefined,
  units: UnitLookup
): ChartSpec | undefined {
  const [path] = signal.paths
  if (signal.combinator !== undefined || signal.paths.length !== 1 || path === '') return undefined
  if (path.split('.').includes('*')) return undefined
  if (side === undefined) return undefined
  const reported = units.entry(path)?.value
  if (reported !== undefined && typeof reported !== 'number') return undefined
  const limited = VALUE_LIMITED.has(type) ? steps.filter((limits) => limits.length > 0) : []
  return {
    path,
    methods: type === 'slope' ? AVERAGE : EXTREMES[side],
    source,
    measure: signalMeasure(signal, units),
    limits: limited.flat(),
    steps: limited.length,
    side,
    verdict: JUDGED.has(type)
  }
}

/** The chart in a rule's detail, from the rule as the server lists it. */
export function detailChart(rule: RuleInfo, units: UnitLookup): ChartSpec | undefined {
  const { kind, unit } = signalMeasure(rule.signal, units)
  const { type, direction } = rule.detector
  const steps = rule.steps.map(({ priority, limit, low, high }) => {
    const shown = (value: number) => fromSI(kind, value, unit)
    if (type === 'outside') {
      return low === undefined || high === undefined
        ? []
        : [
            { value: shown(low), priority, bound: 'low' as const },
            { value: shown(high), priority, bound: 'high' as const }
          ]
    }
    return limit === undefined ? [] : [{ value: shown(limit), priority }]
  })
  return specOf(rule.signal, type, sideOf(type, direction), steps, rule.source, units)
}

/** The chart beside the editor, following the form's path, kind and limits as typed. */
export function editorChart(form: RuleForm, units: UnitLookup): ChartSpec | undefined {
  if (form.signal.mode !== 'single') return undefined
  const { detector } = form
  const outside = detector.type === 'outside'
  const direction = detector.type === 'sustained' ? detector.direction : detector.trend
  const typed = (step: StepForm, text: string, bound?: 'low' | 'high'): SummaryLimit[] => {
    const value = parsedNumber(text)
    if (value === undefined) return []
    const priority = step.priority === '' ? {} : { priority: step.priority }
    return [{ value, ...priority, ...(bound === undefined ? {} : { bound }) }]
  }
  const steps = isZoneLimited(detector)
    ? []
    : form.steps.map((step) =>
        outside
          ? [...typed(step, step.low, 'low'), ...typed(step, step.high, 'high')]
          : typed(step, step.limit)
      )
  const source = form.signal.slots[0]?.source.trim() ?? ''
  const spec = specOf(
    signalShape(form.signal),
    detector.type,
    sideOf(detector.type, direction),
    steps,
    source === '' ? undefined : source,
    units
  )
  // With one side of a range missing, a verdict would miss what passing that side does.
  const halfTyped =
    outside &&
    form.steps.some(
      ({ low, high }) => (parsedNumber(low) === undefined) !== (parsedNumber(high) === undefined)
    )
  return spec !== undefined && halfTyped ? { ...spec, verdict: false } : spec
}
