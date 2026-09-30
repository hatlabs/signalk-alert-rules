// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import { RulesView } from '../../../src/panel/rules/RulesView'
import { instance, ruleEntry } from '../fixtures'

const oil = ruleEntry()

const batteries = ruleEntry({
  slug: 'battery-low',
  rule: {
    name: 'Battery low',
    priority: undefined,
    detector: { type: 'sustained', direction: 'below', zoneLevel: 'warn' },
    signal: { paths: ['electrical.batteries.*.voltage'] }
  },
  status: {
    badge: 'alertActive',
    subLabels: ['waitingForClear'],
    instances: [
      instance({ instance: { name: 'house', segment: 'house' } }),
      instance({
        instance: { name: 'start', segment: 'start' },
        badge: 'alertActive',
        active: true,
        subLabels: ['waitingForClear']
      }),
      instance({ instance: { name: 'bow', segment: 'bow' } })
    ]
  }
})

const engineHours = ruleEntry({
  origin: 'engine-pack',
  slug: 'engine-hours',
  enabled: false,
  rule: {
    name: 'Engine service due',
    priority: 'caution',
    detector: { type: 'accumulator', measure: 'time' },
    signal: {
      combinator: 'max',
      paths: ['propulsion.port.revolutions', 'propulsion.stbd.revolutions']
    }
  },
  status: { badge: 'disabled', reason: 'disabled', instances: [] }
})

function renderView(rules: RuleEntry[]) {
  return render(<RulesView rules={rules} ruleHref={(origin, slug) => `#rule=${origin}/${slug}`} />)
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole('link', { name }).closest('tr')
  if (row === null) throw new Error(`no row for ${name}`)
  return row
}

const names = () => screen.queryAllByRole('link').map((link) => link.textContent)

describe('RulesView', () => {
  afterEach(cleanup)

  it('groups rules by origin, user rules first and rulesets collapsible', () => {
    renderView([engineHours, oil])
    const groups = screen.getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Your rules',
      'Ruleset engine-pack'
    ])
    const ruleset = groups[1]
    expect(ruleset.tagName).toBe('DETAILS')
    expect(ruleset.hasAttribute('open')).toBe(true)
    expect(within(groups[0]).getByRole('link', { name: 'Oil pressure low' })).toBeTruthy()
    expect(within(ruleset).getByRole('link', { name: 'Engine service due' })).toBeTruthy()
  })

  it('shows name, detector, input, badge and priority in a row', () => {
    renderView([oil])
    const row = rowOf('Oil pressure low')
    expect(within(row).getByRole('link').getAttribute('href')).toBe('#rule=user/oil-pressure-low')
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => c.textContent)
    expect(cells).toEqual([
      'Oil pressure low',
      '✓ Idle',
      'sustained below',
      'propulsion.port.oilPressure',
      'alarm'
    ])
  })

  it('lets an input path break only after its dots', () => {
    renderView([oil])
    const input = within(rowOf('Oil pressure low')).getAllByRole('cell')[3]
    expect(input.innerHTML).toBe('propulsion.<wbr>port.<wbr>oilPressure')
  })

  it('shows a combined input and a zone priority', () => {
    renderView([engineHours, batteries])
    expect(rowOf('Engine service due').textContent).toContain(
      'max of propulsion.port.revolutions, propulsion.stbd.revolutions'
    )
    expect(rowOf('Engine service due').textContent).toContain('accumulator (time)')
    expect(rowOf('Battery low').textContent).toContain('zone warn')
  })

  it('marks a disabled or suppressed rule when the badge does not already say so', () => {
    const suppressedAndDisabled = ruleEntry({
      enabled: false,
      suppression: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' },
      status: { badge: 'disabled', reason: 'disabled' }
    })
    const offDuringEvaluationOff = ruleEntry({
      slug: 'b',
      rule: { name: 'Off' },
      enabled: false,
      status: { badge: 'disabled', reason: 'evaluation is off' }
    })
    renderView([suppressedAndDisabled, offDuringEvaluationOff])
    const shownMarkers = (name: string) =>
      [...rowOf(name).querySelectorAll('.skar-marker')].map((m) => m.textContent)
    expect(shownMarkers('Oil pressure low')).toEqual(['suppressed'])
    expect(shownMarkers('Off')).toEqual(['disabled'])
  })

  it('summarises the instances of a wildcard rule by precedence', () => {
    renderView([batteries])
    const row = rowOf('Battery low')
    expect(row.textContent).toContain('3 instances: 1 alert active, 2 idle')
    expect(row.textContent).toContain('waiting for clear')
  })

  it('says when a wildcard rule has no instance yet', () => {
    renderView([{ ...batteries, status: { ...batteries.status, instances: [] } }])
    expect(rowOf('Battery low').textContent).toContain('no instances yet')
  })

  it('filters by name, slug and path, ignoring case', () => {
    renderView([oil, batteries, engineHours])
    const filter = screen.getByRole('searchbox', { name: /filter/i })
    fireEvent.change(filter, { target: { value: 'OIL' } })
    expect(names()).toEqual(['Oil pressure low'])
    fireEvent.change(filter, { target: { value: 'engine-hours' } })
    expect(names()).toEqual(['Engine service due'])
    fireEvent.change(filter, { target: { value: 'batteries.*' } })
    expect(names()).toEqual(['Battery low'])
  })

  it('filters by the rule status', () => {
    renderView([oil, batteries, engineHours])
    const status = screen.getByRole('combobox', { name: /status/i })
    fireEvent.change(status, { target: { value: 'alertActive' } })
    expect(names()).toEqual(['Battery low'])
    fireEvent.change(status, { target: { value: '' } })
    expect(names()).toHaveLength(3)
  })

  it('says when no rule matches the filters', () => {
    renderView([oil])
    fireEvent.change(screen.getByRole('searchbox', { name: /filter/i }), {
      target: { value: 'nothing' }
    })
    expect(screen.getByText(/no rules match/i)).toBeTruthy()
    expect(screen.queryAllByRole('group')).toHaveLength(0)
  })

  it('offers rule creation only where it is wired', () => {
    renderView([oil])
    const button = screen.getByRole('button', { name: /new rule/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the authoring form from New rule', () => {
    const onNew = vi.fn()
    render(<RulesView rules={[oil]} ruleHref={() => '#'} onNew={onNew} />)
    fireEvent.click(screen.getByRole('button', { name: /new rule/i }))
    expect(onNew).toHaveBeenCalledOnce()
  })
})
