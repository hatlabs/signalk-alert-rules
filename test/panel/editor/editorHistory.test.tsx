// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPoint, HistorySource } from '../../../src/panel/history/historySource'
import {
  button,
  choose,
  click,
  formShown,
  renderEditor,
  select,
  textbox,
  type
} from './editorFixtures'

const HOUSE = 'electrical.batteries.house.voltage'

const day: HistoryPoint[] = Array.from({ length: 144 }, (_, i) => ({
  time: Date.now() - 86_400_000 + i * 600_000,
  value: i === 40 ? 13.02 : 13.4
}))

function fakeHistory(provider = true) {
  return {
    hasProvider: vi.fn(() => Promise.resolve(provider)),
    values: vi.fn(() => Promise.resolve([day]))
  } satisfies HistorySource
}

describe('the editor’s history chart', () => {
  afterEach(cleanup)

  it('charts the path beside the form, with the limit as typed and what it would have done', async () => {
    const history = fakeHistory()
    renderEditor({ start: { path: HOUSE, kind: 'below' }, history })
    await formShown()
    type(textbox('Limit for step 1'), '12.8')
    const chart = await screen.findByRole('img', { name: 'Last 24 hours with the limit' })
    expect(chart.textContent).toContain('limit 12.8 V')
    expect(screen.getByRole('heading', { name: 'Last 24 hours' })).toBeTruthy()
    expect(
      screen.getByText(/^Lowest 13\.02 V at .+\. The rule would not have alerted\.$/)
    ).toBeTruthy()
    expect(history.values).toHaveBeenCalledWith(
      expect.objectContaining({ path: HOUSE, methods: ['min'], seconds: 86_400 })
    )
  })

  it('moves the limit as it is typed without asking for the history again', async () => {
    const history = fakeHistory()
    renderEditor({ start: { path: HOUSE, kind: 'below' }, history })
    await formShown()
    type(textbox('Limit for step 1'), '12.8')
    await screen.findByRole('img')
    type(textbox('Limit for step 1'), '13.1')
    expect(screen.getByRole('img').textContent).toContain('limit 13.1 V')
    expect(screen.getByText(/It went below the limit\.$/)).toBeTruthy()
    expect(history.values).toHaveBeenCalledTimes(1)
  })

  it('asks again for a high limit, as each bucket then keeps its highest', async () => {
    const history = fakeHistory()
    renderEditor({ start: { path: HOUSE, kind: 'below' }, history })
    await formShown()
    await screen.findByRole('group', { name: 'Span' })
    choose(/^Alert when/, 'above')
    await waitFor(() => {
      expect(history.values).toHaveBeenLastCalledWith(expect.objectContaining({ methods: ['max'] }))
    })
  })

  it('keeps the chosen span while the path is cleared and typed again', async () => {
    renderEditor({ start: { path: HOUSE, kind: 'below' }, history: fakeHistory() })
    await formShown()
    click(await screen.findByRole('button', { name: '7 d' }))
    click(button('Change the value to watch'))
    type(select('Search by name or path'), '')
    expect(screen.queryByRole('group', { name: 'Span' })).toBeNull()
    type(select('Search by name or path'), HOUSE)
    const week = await screen.findByRole('button', { name: '7 d' })
    expect(week.getAttribute('aria-pressed')).toBe('true')
  })

  it('has no chart without a provider', async () => {
    const history = fakeHistory(false)
    renderEditor({ start: { path: HOUSE, kind: 'below' }, history })
    await formShown()
    await waitFor(() => {
      expect(history.hasProvider).toHaveBeenCalled()
    })
    expect(screen.queryByRole('group', { name: 'Span' })).toBeNull()
    expect(history.values).not.toHaveBeenCalled()
  })
})
