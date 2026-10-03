import type { RuleForm } from '../editor/formModel'
import type { UnitLookup } from '../signalUnits'
import { HistoryChart } from './HistoryChart'
import type { HistorySource } from './historySource'
import { editorChart } from './ruleChart'

/**
 * The chart beside a rule's form, following its path, kind and limits as they
 * are edited. It stays mounted while the form has nothing to chart, so the
 * span chosen survives a path cleared to type another.
 */
export function FormHistory({
  history,
  form,
  units
}: {
  history: HistorySource | undefined
  form: RuleForm
  units: UnitLookup
}) {
  if (history === undefined) return null
  return <HistoryChart history={history} spec={editorChart(form, units)} />
}
