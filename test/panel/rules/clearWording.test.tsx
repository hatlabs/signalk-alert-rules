// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RuleDetail } from '../../../src/panel/detail/RuleDetail'
import { withKind } from '../../../src/panel/editor/conditionKinds'
import { emptyForm, emptyStep } from '../../../src/panel/editor/formModel'
import { hysteresisHint, ladderText } from '../../../src/panel/editor/live'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { ruleEntry } from '../fixtures'

/**
 * The rule detail, the editor's steps summary and its hysteresis hint word
 * where an alert ends from the same hysteresis; one table runs through all
 * three so they cannot disagree.
 */

const HOUSE = 'electrical.batteries.house.voltage'
const units = unitLookup(
  [
    {
      path: HOUSE,
      units: 'V',
      unit: displayUnit({ units: 'V', displayUnits: { formula: 'value', symbol: 'V' } })
    }
  ],
  displayUnit({ units: 'm' })
)

interface Row {
  kind: 'below' | 'above' | 'outside'
  /** The first two steps: a limit each, or a range each for outside. */
  steps: [number, number] | [[number, number], [number, number]]
  margin?: number
  eased: boolean
  where: string
}

const rows: Row[] = [
  { kind: 'below', steps: [12.2, 11.8], eased: false, where: 'above 12.2 V' },
  { kind: 'below', steps: [12.2, 11.8], margin: 0, eased: false, where: 'above 12.2 V' },
  { kind: 'below', steps: [12.2, 11.8], margin: 0.2, eased: true, where: 'above 12.4 V' },
  { kind: 'above', steps: [15, 15.5], margin: 0.1, eased: true, where: 'below 14.9 V' },
  {
    kind: 'outside',
    steps: [
      [11.5, 14.8],
      [11, 15.2]
    ],
    margin: 0.2,
    eased: true,
    where: 'between 11.7 and 14.6 V'
  },
  {
    kind: 'outside',
    steps: [
      [11.5, 14.8],
      [11, 15.2]
    ],
    eased: false,
    where: 'between 11.5 and 14.8 V'
  }
]

const PRIORITIES = ['warning', 'alarm'] as const

/** The detail's Ends row for an eased rule, else the ladder's end hint. */
function detailEnds(row: Row): string {
  const steps = row.steps.map((s, i) =>
    typeof s === 'number'
      ? { limit: s, priority: PRIORITIES[i] }
      : { low: s[0], high: s[1], priority: PRIORITIES[i] }
  )
  const entry = ruleEntry({
    rule: {
      steps,
      detector:
        row.kind === 'outside' ? { type: 'outside' } : { type: 'sustained', direction: row.kind },
      signal: { paths: [HOUSE] },
      hysteresis: row.margin
    }
  })
  render(<RuleDetail entry={entry} backHref="#/list" units={units} now={0} />)
  return row.eased
    ? screen.getByRole('definition', { name: /^ends/i }).textContent
    : screen.getByText(/^Ends once/).textContent
}

function editorForm(row: Row) {
  const f = withKind(emptyForm(), row.kind)
  f.signal.slots[0].path = HOUSE
  f.steps = row.steps.map((s, i) =>
    typeof s === 'number'
      ? { ...emptyStep(PRIORITIES[i]), limit: String(s) }
      : { ...emptyStep(PRIORITIES[i]), low: String(s[0]), high: String(s[1]) }
  )
  f.detector.hysteresis = row.margin === undefined ? '' : String(row.margin)
  return f
}

/** The summary's last sentence, telling where the alert ends. */
function editorEnds(row: Row): string {
  return /It ends .*$/.exec(ladderText(editorForm(row), units) ?? '')?.[0] ?? ''
}

/** The hint's level is the same point, worded as a place: "at 12.4 V", "inside 11.7–14.6 V". */
const hintLevel = (where: string) =>
  where.replace(/^(above|below) /, 'at ').replace(/^between (\S+) and /, 'inside $1–')

describe('where an alert ends, as the detail and the editor word it', () => {
  afterEach(cleanup)

  it.each(rows)('$kind $steps, hysteresis $margin: $where', (row) => {
    expect(detailEnds(row)).toBe(
      row.eased ? `once back ${row.where}` : `Ends once the value is back ${row.where}.`
    )
    expect(editorEnds(row)).toBe(
      row.eased ? `It ends only once back ${row.where}.` : `It ends once back ${row.where}.`
    )
    expect(hysteresisHint(editorForm(row), units)).toBe(`Alert ends ${hintLevel(row.where)}.`)
  })
})
