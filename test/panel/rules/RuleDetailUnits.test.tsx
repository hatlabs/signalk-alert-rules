// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { formatDuration } from '../../../src/panel/rules/describe'
import { RuleDetail } from '../../../src/panel/rules/RuleDetail'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { instance, ruleEntry } from '../fixtures'

const paths: PathEntry[] = [
  {
    path: 'propulsion.port.coolantTemperature',
    units: 'K',
    unit: displayUnit({ units: 'K', displayUnits: { formula: 'value - 273.15', symbol: '°C' } })
  },
  {
    path: 'propulsion.port.revolutions',
    units: 'Hz',
    unit: displayUnit({ units: 'Hz', displayUnits: { formula: 'value * 60', symbol: 'rpm' } })
  }
]
const units = unitLookup(paths, displayUnit({ units: 'm' }))

function renderDetail(entry: RuleEntry) {
  render(
    <RuleDetail entry={entry} backHref="#/" reset={vi.fn(() => Promise.resolve())} units={units} />
  )
}

const coolant = ruleEntry({
  rule: {
    name: 'Coolant hot',
    detector: { type: 'sustained', direction: 'above' },
    signal: { paths: ['propulsion.*.coolantTemperature'] }
  },
  status: {
    instances: [
      instance({
        instance: { name: 'port', segment: 'port' },
        value: 368.15,
        limit: 373.15,
        progress: { kind: 'timer', toward: 'set', elapsed: 150, target: 300 }
      })
    ]
  }
})

describe('RuleDetail in display units', () => {
  afterEach(cleanup)

  it("shows values and limits in the input's display unit, with no SI notice", () => {
    renderDetail(coolant)
    const row = screen.getByRole('rowheader', { name: 'port' }).closest('tr')
    expect(row?.textContent).toContain('95 °C')
    expect(row?.textContent).toContain('100 °C')
    expect(screen.queryByText(/values are in SI units/i)).toBeNull()
  })

  it('shows timers in minutes once they run past two minutes', () => {
    renderDetail(coolant)
    expect(screen.getByText('2.5 min of 5 min toward set')).toBeTruthy()
  })

  it('shows a difference through the linear part of the unit', () => {
    renderDetail(
      ruleEntry({
        rule: {
          detector: { type: 'sustained', direction: 'above' },
          signal: {
            combinator: 'absDifference',
            paths: ['propulsion.port.revolutions', 'propulsion.starboard.revolutions']
          }
        },
        status: { instances: [instance({ value: 0.5, limit: 3 })] }
      })
    )
    expect(screen.getByText('30 rpm')).toBeTruthy()
    expect(screen.getByText('180 rpm')).toBeTruthy()
  })

  it('shows accumulated running time in hours in the reset confirmation', () => {
    renderDetail(
      ruleEntry({
        rule: {
          detector: { type: 'accumulator', measure: 'time' },
          signal: { paths: ['propulsion.port.revolutions'] }
        },
        status: {
          instances: [instance({ progress: { kind: 'total', total: 900000, limit: 900000 } })]
        }
      })
    )
    expect(screen.getByText('250 h of 250 h')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    expect(screen.getByRole('alertdialog').textContent).toMatch(/discards the total of 250 h/)
  })

  it("shows an integral's total in the input's unit times seconds", () => {
    renderDetail(
      ruleEntry({
        rule: {
          detector: { type: 'accumulator', measure: 'integral' },
          signal: { paths: ['propulsion.port.revolutions'] }
        },
        status: {
          instances: [instance({ progress: { kind: 'total', total: 10, limit: 20 } })]
        }
      })
    )
    expect(screen.getByText('600 rpm·s of 1200 rpm·s')).toBeTruthy()
  })
})

describe('formatDuration', () => {
  it('uses seconds, minutes or hours by size', () => {
    expect(formatDuration(20)).toBe('20 s')
    expect(formatDuration(119)).toBe('119 s')
    expect(formatDuration(150)).toBe('2.5 min')
    expect(formatDuration(7200)).toBe('2 h')
    expect(formatDuration(900000)).toBe('250 h')
  })

  it('shows seconds whole, as a timer has run them', () => {
    expect(formatDuration(0.0367)).toBe('0 s')
    expect(formatDuration(43.05)).toBe('43 s')
    expect(formatDuration(59.6)).toBe('60 s')
  })
})
