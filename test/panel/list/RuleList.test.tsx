// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ListedRule, Permissions, RuleStatus } from '../../../src/panel/api'
import { RuleList } from '../../../src/panel/list/RuleList'
import { hashWithRoute } from '../../../src/panel/route'
import { NO_UNITS } from '../../../src/panel/signalUnits'
import { invalidEntry, ruleEntry } from '../fixtures'

const ADMIN = '#/e/signalk_alert_rules'
const NOW = Date.parse('2026-09-30T14:00:00.000Z')

function renderList(rules: ListedRule[], permissions: Permissions = 'admin') {
  render(
    <RuleList
      rules={rules}
      permissions={permissions}
      units={NO_UNITS}
      now={NOW}
      routeHref={(route) => hashWithRoute(ADMIN, route)}
    />
  )
}

function rule(slug: string, name: string, status: Partial<RuleStatus> = {}) {
  return ruleEntry({ slug, rule: { name }, status })
}

const alerting = rule('house-low', 'House bank voltage low', {
  condition: 'alerting',
  reason: 'alertActive',
  priority: 'alarm',
  message: 'House bank at 11.6 V'
})
const quiet = rule('depth', 'Depth below 3.0 m', { value: 12.4 })
const paddlewheel = ruleEntry({
  slug: 'stw',
  rule: { name: 'Speed through water stuck' },
  disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin', note: 'paddlewheel fouled' },
  status: { ruleState: 'disabled', condition: 'present', reason: 'conditionPresent', value: 0 }
})

const rowNames = (group: HTMLElement) =>
  within(group)
    .getAllByRole('link')
    .map((link) => link.querySelector('.skar-row-name')?.textContent)

describe('RuleList', () => {
  afterEach(cleanup)

  it('groups the rules needing attention above the normal ones, in attention order', () => {
    renderList([quiet, paddlewheel, invalidEntry(), alerting])
    const attention = screen.getByRole('region', { name: 'Needs attention' })
    const normal = screen.getByRole('region', { name: 'Normal' })
    expect(rowNames(attention)).toEqual([
      'House bank voltage low',
      'Coolant high',
      'Speed through water stuck'
    ])
    expect(rowNames(normal)).toEqual(['Depth below 3.0 m'])
    expect(
      attention.compareDocumentPosition(normal) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('counts the rules per state in the summary line', () => {
    renderList([quiet, paddlewheel, invalidEntry(), alerting])
    expect(screen.getByText('1 alerting · 1 problem · 1 disabled · 1 normal')).toBeTruthy()
  })

  it('leaves out a group no rule is in', () => {
    renderList([quiet])
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull()
  })

  it('links each row to its rule, with the current fact and a state chip', () => {
    renderList([alerting, paddlewheel])
    const row = screen.getByRole('link', { name: /house bank voltage low/i })
    expect(row.getAttribute('href')).toBe(`${ADMIN}#rule=house-low`)
    expect(within(row).getByText('House bank at 11.6 V')).toBeTruthy()
    expect(within(row).getByText('Alerting')).toBeTruthy()
    const off = screen.getByRole('link', { name: /speed through water/i })
    expect(within(off).getByText('“paddlewheel fouled”. Condition still present: 0')).toBeTruthy()
    expect(within(off).getByText('Disabled')).toBeTruthy()
  })

  it('shows the priority an alert has reached', () => {
    renderList([alerting])
    const row = screen.getByRole('link', { name: /house bank voltage low/i })
    expect(within(row).getByText('Alarm')).toBeTruthy()
  })

  it('offers Add rule to an administrator only', () => {
    renderList([quiet], 'admin')
    expect(screen.getByRole('link', { name: 'Add rule' }).getAttribute('href')).toBe(`${ADMIN}#add`)
    cleanup()
    for (const level of ['readwrite', 'readonly'] as const) {
      renderList([quiet], level)
      expect(screen.queryByRole('link', { name: /add rule/i })).toBeNull()
      cleanup()
    }
  })

  describe('with no rules', () => {
    it('invites an administrator to start from a template or a data path', () => {
      renderList([])
      expect(screen.getByRole('heading', { name: 'No alert rules yet' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Start from a template' }).getAttribute('href')).toBe(
        `${ADMIN}#add=template`
      )
      expect(
        screen.getByRole('link', { name: 'Start from a data path' }).getAttribute('href')
      ).toBe(`${ADMIN}#add=path`)
      expect(screen.queryByText(/alerting|normal/)).toBeNull()
    })

    it.each(['readonly', 'readwrite'] as const)(
      'shows a %s user the empty state without buttons or a notice',
      (level) => {
        renderList([], level)
        expect(screen.getByRole('heading', { name: 'No alert rules yet' })).toBeTruthy()
        expect(screen.queryAllByRole('link')).toEqual([])
        expect(screen.queryAllByRole('button')).toEqual([])
        expect(screen.queryByText(/administrator/i)).toBeNull()
      }
    )
  })

  it('renders 150 rules as rows, split between the two groups', () => {
    const many = Array.from({ length: 150 }, (_, n) =>
      rule(
        `rule-${String(n)}`,
        `Rule ${String(n)}`,
        n % 10 === 0 ? { condition: 'noData', reason: 'neverReported' } : {}
      )
    )
    renderList(many)
    const attention = screen.getByRole('region', { name: 'Needs attention' })
    const normal = screen.getByRole('region', { name: 'Normal' })
    expect(within(attention).getAllByRole('link')).toHaveLength(15)
    expect(within(normal).getAllByRole('link')).toHaveLength(135)
  })
})
