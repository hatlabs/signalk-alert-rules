/**
 * Which rules get a history chart, and what it draws: one concrete numeric
 * path, compared with a limit or watched for its rate of change. The
 * History API records paths, not a rule's combined or per-instance signal.
 */
import type { RuleInfo } from '../api'
import { isZoneLimited, signalShape, type RuleForm } from '../editor/formModel'
import { signalMeasure, type SignalShape, type UnitLookup } from '../signalUnits'
import { fromSI } from '../units'
import type { SummaryLimit } from './chart'
import type { ChartSpec } from './HistoryChart'

/** The detectors whose condition is on the value itself, by their direction. */
const SIDES: Readonly<Partial<Record<string, Partial<Record<string, 'below' | 'above'>>>>> = {
  sustained: { below: 'below', above: 'above' },
  projection: { falling: 'below', rising: 'above' },
  slope: { falling: 'below', rising: 'above' }
}

/** A slope's limit is a rate, which has no place on the value axis. */
const VALUE_LIMITED = new Set(['sustained', 'projection'])

function specOf(
  signal: SignalShape,
  type: string,
  direction: string,
  limits: SummaryLimit[],
  units: UnitLookup
): ChartSpec | undefined {
  const [path] = signal.paths
  if (signal.combinator !== undefined || signal.paths.length !== 1 || path === '') return undefined
  if (path.split('.').includes('*')) return undefined
  const side = SIDES[type]?.[direction]
  if (side === undefined) return undefined
  const reported = units.entry(path)?.value
  if (reported !== undefined && typeof reported !== 'number') return undefined
  return {
    path,
    // Each bucket keeps its extreme on the rule's side, so a dip shorter than
    // a bucket still shows, and a limit never passed was never passed.
    method: type === 'slope' ? 'average' : side === 'below' ? 'min' : 'max',
    measure: signalMeasure(signal, units),
    limits: VALUE_LIMITED.has(type) ? limits : [],
    side,
    verdict: type === 'sustained'
  }
}

/** The chart in a rule's detail, from the rule as the server lists it. */
export function detailChart(rule: RuleInfo, units: UnitLookup): ChartSpec | undefined {
  const { kind, unit } = signalMeasure(rule.signal, units)
  const limits = rule.steps.flatMap((step) =>
    step.limit === undefined
      ? []
      : [{ value: fromSI(kind, step.limit, unit), priority: step.priority }]
  )
  return specOf(rule.signal, rule.detector.type, rule.detector.direction ?? '', limits, units)
}

/** The chart beside the editor, following the form's path, kind and limits as typed. */
export function editorChart(form: RuleForm, units: UnitLookup): ChartSpec | undefined {
  const { detector } = form
  const direction = detector.type === 'sustained' ? detector.direction : detector.trend
  const limits = isZoneLimited(detector)
    ? []
    : form.steps.flatMap((step) => {
        const typed = step.limit.trim().replace(',', '.')
        const value = typed === '' ? NaN : Number(typed)
        if (!Number.isFinite(value)) return []
        return [{ value, ...(step.priority === '' ? {} : { priority: step.priority }) }]
      })
  const signal =
    form.signal.mode === 'single' ? signalShape(form.signal) : { paths: [], combinator: '' }
  return specOf(signal, detector.type, direction, limits, units)
}
