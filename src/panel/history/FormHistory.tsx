import type { RuleForm } from '../editor/formModel'
import type { UnitLookup } from '../signalUnits'
import { HistoryChart } from './HistoryChart'
import type { HistorySource } from './historySource'
import { editorChart } from './ruleChart'

/** The chart beside a rule's form, following its path, kind and limits as they are edited. */
export function FormHistory({
  history,
  form,
  units
}: {
  history: HistorySource | undefined
  form: RuleForm
  units: UnitLookup
}) {
  const spec = history && editorChart(form, units)
  if (history === undefined || spec === undefined) return null
  return <HistoryChart history={history} spec={spec} />
}
