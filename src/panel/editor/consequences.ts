/**
 * What saving an edit does to a rule's alerts and totals, in words, for the
 * confirmation shown before an edit that clears an alert or discards a total.
 */
import type { EditPreview } from '../api'
import { joined } from './words'

const CHANGE_WORDS: Readonly<Partial<Record<string, string>>> = {
  alertPath: 'alert path',
  signal: 'input',
  gates: 'gates',
  latching: 'latching',
  'detector.type': 'detector',
  'detector.op': 'match operator',
  'detector.steps.value': 'match values',
  'detector.direction': 'direction',
  'detector.limit': 'limit kind',
  'detector.limit.level': 'zone level',
  'detector.measure': 'measure',
  'detector.while': 'accumulating condition',
  'detector.resetOn': 'reset event',
  'detector.event': 'event'
}

function changeWord(change: string): string {
  return CHANGE_WORDS[change] ?? change.replace(/^detector\./, '')
}

/** One sentence per consequence the operator must confirm; none for an edit applied in place. */
export function editConsequences(preview: EditPreview, totals: string[]): string[] {
  const lines: string[] = []
  if (preview.clearsActiveAlert) {
    const alerts =
      preview.activeAlerts === 1
        ? 'the active alert'
        : `${String(preview.activeAlerts)} active alerts`
    const why =
      preview.changes.length === 0
        ? ''
        : `, because its ${joined([...new Set(preview.changes.map(changeWord))])} changed`
    lines.push(
      `Saving clears ${alerts} of this rule and restarts it${why}. It raises again once its condition holds.`
    )
  }
  if (preview.discardsTotal) {
    lines.push(
      totals.length === 0
        ? 'Saving discards the accumulated total.'
        : `Saving discards the accumulated total${totals.length === 1 ? '' : 's'} ${totals.join(', ')}.`
    )
  }
  return lines
}
