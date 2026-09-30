// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import { RuleDetail } from '../../../src/panel/rules/RuleDetail'
import { instance, ruleEntry } from '../fixtures'

const batteries = ruleEntry({
  slug: 'battery-low',
  note: 'House bank replaced in spring',
  rule: {
    name: 'Battery low',
    priority: undefined,
    detector: { type: 'sustained', direction: 'below', zoneLevel: 'warn' },
    signal: { paths: ['electrical.batteries.*.voltage'] },
    gates: [{ paths: ['electrical.chargers.shore.state'] }]
  },
  status: {
    badge: 'timerRunning',
    subLabels: ['gateInputUnavailable'],
    issues: ['instance a.b was not admitted'],
    instances: [
      instance({
        instance: { name: 'house', segment: 'house' },
        badge: 'timerRunning',
        value: 12.1,
        limit: 12.2,
        progress: { kind: 'timer', toward: 'set', elapsed: 20, target: 60 },
        gates: [{ holds: true, input: 'unavailable' }],
        subLabels: ['gateInputUnavailable']
      }),
      instance({
        instance: { name: 'start', segment: 'start' },
        badge: 'inputUnavailable',
        input: 'unavailable',
        value: undefined,
        limit: 12.2,
        gates: [{ holds: true, input: 'value' }]
      })
    ]
  }
})

const engineHours = ruleEntry({
  slug: 'engine-hours',
  rule: {
    name: 'Engine service due',
    detector: { type: 'accumulator', measure: 'time' },
    signal: { paths: ['propulsion.*.revolutions'] }
  },
  status: {
    badge: 'idle',
    instances: [
      instance({
        instance: { name: 'port', segment: 'port' },
        progress: { kind: 'total', total: 7200, limit: 360000 }
      }),
      instance({
        instance: { name: 'stbd', segment: 'stbd' },
        progress: { kind: 'total', total: 3600, limit: 360000 }
      })
    ]
  }
})

function renderDetail(entry: RuleEntry, reset = vi.fn(() => Promise.resolve())) {
  render(<RuleDetail entry={entry} backHref="#/config" reset={reset} />)
  return reset
}

const rowOf = (instanceName: string) => {
  const row = screen.getByRole('rowheader', { name: instanceName }).closest('tr')
  if (row === null) throw new Error(`no row for ${instanceName}`)
  return row
}

/** The cell of `row` under the column headed `column`. */
const cell = (row: HTMLElement, column: string) => {
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
  return row.children[headers.indexOf(column)]
}

describe('RuleDetail', () => {
  afterEach(cleanup)

  it('shows the rule, its status and a way back to the list', () => {
    renderDetail(batteries)
    expect(screen.getByRole('heading', { name: 'Battery low' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /all rules/i }).getAttribute('href')).toBe('#/config')
    const facts = screen.getByRole('definition', { name: /detector/i })
    expect(facts.textContent).toBe('sustained below')
    expect(screen.getByRole('definition', { name: /input/i }).textContent).toBe(
      'electrical.batteries.*.voltage'
    )
    expect(screen.getByRole('definition', { name: /priority/i }).textContent).toBe('zone warn')
    expect(screen.getByRole('definition', { name: /gates/i }).textContent).toBe(
      'electrical.chargers.shore.state'
    )
    expect(screen.getByRole('definition', { name: /note/i }).textContent).toBe(
      'House bank replaced in spring'
    )
    expect(screen.getByText('instance a.b was not admitted')).toBeTruthy()
  })

  it('shows each instance with its value, limit, timer progress and gate state', () => {
    renderDetail(batteries)
    const house = rowOf('house')
    expect(house.textContent).toContain('Timer running')
    expect(cell(house, 'Value').textContent).toBe('12.1')
    expect(cell(house, 'Limit').textContent).toBe('12.2')
    const timer = within(house).getByRole('progressbar')
    expect(timer.getAttribute('value')).toBe('20')
    expect(timer.getAttribute('max')).toBe('60')
    expect(house.textContent).toContain('20 s of 60 s toward set')
    expect(house.textContent).toMatch(/gate 1: holds, input unavailable/i)

    const start = rowOf('start')
    expect(cell(start, 'Value').textContent).toBe('unavailable')
    expect(start.textContent).toMatch(/gate 1: holds/i)
  })

  it('shows the priority an active instance is at, and none for an inactive one', () => {
    renderDetail({
      ...batteries,
      status: {
        ...batteries.status,
        instances: [
          instance({
            instance: { name: 'house', segment: 'house' },
            badge: 'alertActive',
            active: true,
            level: 'alarm',
            priority: 'alarm'
          }),
          instance({ instance: { name: 'start', segment: 'start' }, priority: 'warn' })
        ]
      }
    })
    expect(cell(rowOf('house'), 'Status').textContent).toMatch(/at alarm$/)
    expect(cell(rowOf('start'), 'Status').textContent).not.toMatch(/\bat\b/)
  })

  it('shows the event count toward the limit', () => {
    renderDetail(
      ruleEntry({
        rule: { detector: { type: 'count' } },
        status: {
          instances: [instance({ progress: { kind: 'events', count: 2, limit: 5 } })]
        }
      })
    )
    const row = screen.getAllByRole('row')[1]
    expect(cell(row, 'Progress').textContent).toBe('2 of 5 events')
  })

  it("shows the rule's suppression with its actor and note", () => {
    renderDetail(
      ruleEntry({
        suppression: {
          since: '2026-09-30T12:00:00.000Z',
          actor: 'skipper',
          note: 'sender being replaced'
        },
        status: { badge: 'suppressed', suppression: { scope: 'rule' } }
      })
    )
    expect(screen.getByRole('definition', { name: /suppressed/i }).textContent).toBe(
      'since 2026-09-30T12:00:00.000Z by skipper: sender being replaced'
    )
  })

  it('marks a disabled or suppressed rule when the badge does not already say so', () => {
    const { container } = render(
      <RuleDetail
        entry={ruleEntry({
          enabled: false,
          suppression: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' },
          status: { badge: 'disabled', reason: 'evaluation is off' }
        })}
        backHref="#/config"
        reset={() => Promise.resolve()}
      />
    )
    const shown = [...container.querySelectorAll('.skar-marker')].map((m) => m.textContent)
    expect(shown).toEqual(['disabled', 'suppressed'])
  })

  it('says values are in SI units', () => {
    renderDetail(batteries)
    expect(screen.getByText(/values are in SI units/i)).toBeTruthy()
  })

  it('shows the errors of an errored rule', () => {
    renderDetail(
      ruleEntry({
        status: {
          badge: 'errored',
          reason: 'evaluation threw',
          errors: ['evaluation threw', 'subscription refused']
        }
      })
    )
    const errors = screen.getByRole('list', { name: /errors/i })
    expect(
      within(errors)
        .getAllByRole('listitem')
        .map((i) => i.textContent)
    ).toEqual(['evaluation threw', 'subscription refused'])
  })

  it('offers editing, not yet available', () => {
    renderDetail(batteries)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /edit/i }).disabled).toBe(true)
  })

  it('offers an accumulator reset only for an accumulator', () => {
    renderDetail(batteries)
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull()
  })

  it('confirms a reset, showing the totals it discards, before resetting', async () => {
    const reset = renderDetail(engineHours)
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toMatch(/port: 7200 s/)
    expect(dialog.textContent).toMatch(/stbd: 3600 s/)
    expect(dialog.textContent).toMatch(/clears its active alerts/i)
    expect(reset).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^reset/i }))
      await Promise.resolve()
    })
    expect(reset).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a single total without an instance name', () => {
    renderDetail(
      ruleEntry({
        rule: { detector: { type: 'accumulator', measure: 'integral' } },
        status: { instances: [instance({ progress: { kind: 'total', total: 42.5, limit: 100 } })] }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    expect(screen.getByRole('alertdialog').textContent).toMatch(/discards the total of 42\.5\b/)
  })

  it('cancels a reset without resetting', () => {
    const reset = renderDetail(engineHours)
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(reset).not.toHaveBeenCalled()
  })

  it('keeps the confirmation open with the error when the reset fails', async () => {
    renderDetail(
      engineHours,
      vi.fn(() => Promise.reject(new Error('only an accumulator rule can be reset')))
    )
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: /^reset/i })
      )
      await Promise.resolve()
    })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('only an accumulator rule can be reset')
  })
})
