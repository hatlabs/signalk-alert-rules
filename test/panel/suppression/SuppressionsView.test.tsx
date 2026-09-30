// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SessionExpiredError,
  type InputSuppressionPreview,
  type Suppression,
  type SuppressionRequest
} from '../../../src/panel/api'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import { SuppressionsView } from '../../../src/panel/suppression/SuppressionsView'
import { displayUnit } from '../../../src/panel/units'
import { ruleEntry } from '../fixtures'

const RPM = 'propulsion.port.revolutions'
const SINCE = '2026-09-30T12:05:00.000Z'

const rpmHigh = ruleEntry({ slug: 'rpm-high', rule: { name: 'RPM high' } })
const coolant = ruleEntry({ slug: 'coolant-high', rule: { name: 'Coolant high' } })
const oil = ruleEntry()
const rules = [rpmHigh, coolant, oil]

const inputSuppression: Suppression = {
  scope: 'input',
  path: RPM,
  since: SINCE,
  actor: 'skipper',
  note: 'Tachometer sender faulty'
}
const ruleSuppression: Suppression = {
  scope: 'rule',
  rule: 'user.oil-pressure-low',
  origin: 'user',
  slug: 'oil-pressure-low',
  since: '2026-09-30T12:00:00.000Z',
  actor: 'admin',
  autoEndAfter: 600
}

const rpmPreview: InputSuppressionPreview = {
  path: RPM,
  suppresses: [
    { rule: 'user.rpm-high', origin: 'user', slug: 'rpm-high' },
    { rule: 'user.rpm-high', origin: 'user', slug: 'rpm-high', instance: 'x' }
  ],
  freezes: [
    {
      rule: 'user.coolant-high',
      origin: 'user',
      slug: 'coolant-high',
      gate: 0,
      states: [{ holds: false }]
    }
  ]
}

const paths: PathSource = {
  selfPaths: () =>
    Promise.resolve([{ path: RPM, units: 'Hz', unit: displayUnit({ units: 'Hz' }) }]),
  distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
}

function fakeServer(
  initial: Suppression[],
  preview: () => Promise<InputSuppressionPreview> = () => Promise.resolve(rpmPreview)
) {
  const server = { suppressions: initial }
  const api = {
    suppressions: vi.fn(() => Promise.resolve(server.suppressions)),
    previewInputSuppression: vi.fn((_path: string) => preview()),
    suppressRule: vi.fn((_o: string, _s: string, _r: SuppressionRequest) => Promise.resolve(oil)),
    suppressInput: vi.fn((path: string, request: SuppressionRequest) => {
      const made: Suppression = { scope: 'input', path, since: SINCE, actor: 'skipper', ...request }
      server.suppressions = [made, ...server.suppressions]
      return Promise.resolve(made)
    }),
    endRuleSuppression: vi.fn((_o: string, _s: string) => Promise.resolve()),
    endInputSuppression: vi.fn((path: string) => {
      server.suppressions = server.suppressions.filter(
        (s) => s.scope !== 'input' || s.path !== path
      )
      return Promise.resolve()
    })
  }
  const refresh = vi.fn()
  render(
    <SuppressionsView
      api={api}
      rules={rules}
      paths={paths}
      ruleHref={(origin, slug) => `#rule=${origin}/${slug}`}
      refresh={refresh}
    />
  )
  return { api, refresh, server }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const rowOf = (name: RegExp) => screen.getByRole('row', { name })
const cell = (row: HTMLElement, column: string) => {
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
  return row.children[headers.indexOf(column)]
}

describe('SuppressionsView', () => {
  afterEach(cleanup)

  it('lists each suppression with its scope, start, actor, note and end mode', async () => {
    fakeServer([inputSuppression, ruleSuppression])
    await settle()
    const input = rowOf(new RegExp(RPM))
    expect(cell(input, 'Scope').textContent).toBe(`Input ${RPM}affects 2 rules`)
    const started = within(input).getByText(new Date(SINCE).toLocaleString())
    expect(started.tagName).toBe('TIME')
    expect(started.getAttribute('datetime')).toBe(SINCE)
    expect(cell(input, 'By').textContent).toBe('skipper')
    expect(cell(input, 'Note').textContent).toBe('Tachometer sender faulty')
    expect(cell(input, 'Ends').textContent).toBe('Manually')

    const rule = rowOf(/oil pressure low/i)
    const link = within(rule).getByRole('link', { name: 'Oil pressure low' })
    expect(link.getAttribute('href')).toBe('#rule=user/oil-pressure-low')
    expect(cell(rule, 'Ends').textContent).toMatch(
      /by itself after 10 min clear.*waiting for clear/i
    )
  })

  it('lists an input suppression whose affected count cannot be read', async () => {
    fakeServer([inputSuppression], () => Promise.reject(new Error('timed out')))
    await settle()
    expect(cell(rowOf(new RegExp(RPM)), 'Scope').textContent).toBe(`Input ${RPM}`)
  })

  it('counts a rule whose gate it freezes as affected', async () => {
    fakeServer([inputSuppression], () => Promise.resolve({ ...rpmPreview, suppresses: [] }))
    await settle()
    expect(cell(rowOf(new RegExp(RPM)), 'Scope').textContent).toBe(`Input ${RPM}affects 1 rule`)
  })

  it('says when no suppression is in force', async () => {
    fakeServer([])
    await settle()
    expect(screen.getByText(/no suppression is in force/i)).toBeTruthy()
  })

  it('shows why the list could not be read', async () => {
    const { api } = fakeServer([])
    api.suppressions.mockRejectedValue(new SessionExpiredError())
    cleanup()
    render(
      <SuppressionsView
        api={api}
        rules={rules}
        paths={paths}
        ruleHref={() => '#'}
        refresh={vi.fn()}
      />
    )
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/session has expired/i)
  })

  it('ends a suppression after a confirmation and shows the list as it is after', async () => {
    const { api, refresh } = fakeServer([inputSuppression, ruleSuppression])
    await settle()
    const end = within(rowOf(new RegExp(RPM))).getByRole('button', {
      name: `End the suppression of input ${RPM}`
    })
    fireEvent.click(end)
    const confirm = screen.getByRole('alertdialog', { name: /end the suppression of input/i })
    expect(confirm.textContent).toMatch(/raised again as a new alert/i)
    await click(within(confirm).getByRole('button', { name: 'End suppression' }))
    expect(api.endInputSuppression).toHaveBeenCalledWith(RPM)
    expect(refresh).toHaveBeenCalled()
    expect(screen.queryByRole('row', { name: new RegExp(RPM) })).toBeNull()
    expect(rowOf(/oil pressure low/i)).toBeTruthy()
  })

  it('ends a rule suppression by its origin and slug', async () => {
    const { api } = fakeServer([ruleSuppression])
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'End the suppression of Oil pressure low' }))
    await click(screen.getByRole('button', { name: 'End suppression' }))
    expect(api.endRuleSuppression).toHaveBeenCalledWith('user', 'oil-pressure-low')
  })

  it("keeps the confirmation open with the server's message when ending is refused", async () => {
    const { api } = fakeServer([ruleSuppression])
    api.endRuleSuppression.mockRejectedValue(new Error('no such rule'))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /end the suppression/i }))
    await click(screen.getByRole('button', { name: 'End suppression' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('no such rule')
  })

  it('suppresses an input picked by path, then lists it with its start and actor', async () => {
    const { api, refresh } = fakeServer([])
    await settle()
    const trigger = screen.getByRole('button', { name: 'Suppress input…' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Suppress an input' })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Input path' }), {
      target: { value: RPM }
    })
    await click(within(dialog).getByRole('button', { name: /show what it suppresses/i }))
    expect(
      within(within(dialog).getByRole('list', { name: /rules it suppresses/i }))
        .getAllByRole('listitem')
        .map((i) => i.textContent)
    ).toEqual(['RPM high', 'RPM high: instance x'])
    expect(within(dialog).getByRole('list', { name: /gated rules it freezes/i }).textContent).toBe(
      'Coolant high: gate 1 frozen as not holding'
    )
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Tachometer sender faulty' }
    })
    await click(within(dialog).getByRole('button', { name: 'Suppress' }))
    expect(api.suppressInput).toHaveBeenCalledWith(RPM, { note: 'Tachometer sender faulty' })
    expect(refresh).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    const row = rowOf(new RegExp(RPM))
    expect(cell(row, 'Scope').textContent).toMatch(/affects 2 rules/)
    expect(within(row).getByText(new Date(SINCE).toLocaleString())).toBeTruthy()
    expect(cell(row, 'By').textContent).toBe('skipper')
  })
})
