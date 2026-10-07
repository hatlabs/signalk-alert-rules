// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RuleDetail } from '../../../src/panel/detail/RuleDetail'
import { withKind } from '../../../src/panel/editor/conditionKinds'
import { durationFrom, emptyForm, emptyStep } from '../../../src/panel/editor/formModel'
import { ladderText } from '../../../src/panel/editor/live'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { ruleEntry } from '../fixtures'

/**
 * The rule detail and the editor word when an alert clears from the same
 * clear margin and delay; one table runs through both so they cannot
 * disagree.
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
  delay?: number
  eased: boolean
  where: string
}

const rows: Row[] = [
  { kind: 'below', steps: [12.2, 11.8], eased: false, where: 'above 12.2 V' },
  { kind: 'below', steps: [12.2, 11.8], margin: 0, delay: 0, eased: false, where: 'above 12.2 V' },
  { kind: 'below', steps: [12.2, 11.8], margin: 0.2, delay: 0, eased: true, where: 'above 12.4 V' },
  {
    kind: 'below',
    steps: [12.2, 11.8],
    margin: 0,
    delay: 30,
    eased: true,
    where: 'above 12.2 V for 30 s'
  },
  {
    kind: 'below',
    steps: [12.2, 11.8],
    margin: 0.2,
    delay: 30,
    eased: true,
    where: 'above 12.4 V for 30 s'
  },
  { kind: 'above', steps: [15, 15.5], margin: 0.1, eased: true, where: 'below 14.9 V' },
  { kind: 'above', steps: [15, 15.5], delay: 120, eased: true, where: 'below 15 V for 2 min' },
  {
    kind: 'outside',
    steps: [
      [11.5, 14.8],
      [11, 15.2]
    ],
    margin: 0.2,
    delay: 0,
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

/** The detail's Clears row for an eased rule, else the ladder's clear hint. */
function detailClears(row: Row): string {
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
      hysteresis: row.margin,
      clearDuration: row.delay
    }
  })
  render(<RuleDetail entry={entry} backHref="#/list" units={units} now={0} />)
  return row.eased
    ? screen.getByRole('definition', { name: /^clears/i }).textContent
    : screen.getByText(/^Clears when/).textContent
}

function editorClause(row: Row): string {
  const f = withKind(emptyForm(), row.kind)
  f.signal.slots[0].path = HOUSE
  f.steps = row.steps.map((s, i) =>
    typeof s === 'number'
      ? { ...emptyStep(PRIORITIES[i]), limit: String(s) }
      : { ...emptyStep(PRIORITIES[i]), low: String(s[0]), high: String(s[1]) }
  )
  f.detector.hysteresis = row.margin === undefined ? '' : String(row.margin)
  f.detector.clearDuration = durationFrom(row.delay)
  return /It clears only (.*)\.$/.exec(ladderText(f, units) ?? '')?.[1] ?? ''
}

describe('when an alert clears, as the detail and the editor word it', () => {
  afterEach(cleanup)

  it.each(rows)('$kind $steps, margin $margin, delay $delay: $where', (row) => {
    expect(detailClears(row)).toBe(
      row.eased ? `once back ${row.where}` : `Clears when the value is back ${row.where}.`
    )
    expect(editorClause(row)).toBe(row.eased ? `once back ${row.where}` : row.where)
  })
})
