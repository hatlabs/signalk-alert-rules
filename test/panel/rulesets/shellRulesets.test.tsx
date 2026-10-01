// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelApi, PluginState, RuleEntry } from '../../../src/panel/api'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import type { RulesetEntry, RulesetsApi } from '../../../src/panel/rulesets/api'
import { Shell } from '../../../src/panel/Shell'
import { POLL_INTERVAL_MS } from '../../../src/panel/shellState'
import { instance, noAuthoring, noControls, ruleEntry } from '../fixtures'

const running: PluginState = { running: true, securityEnabled: true }
const DEFAULT_LOW = 12

const noPaths: PathSource = {
  selfPaths: () => Promise.resolve([]),
  distanceUnit: () => Promise.resolve({ symbol: 'm', scale: 1, offset: 0, si: true })
}

/**
 * A server with one discovered ruleset whose rule takes its limit from the
 * lowVoltage parameter, as the plugin resolves it.
 */
function fakeServer() {
  const stored = { enabled: false, values: {} as Record<string, number | string> }

  const ruleset = (): RulesetEntry => ({
    slug: 'batteries',
    name: 'Battery monitoring',
    version: '1.0.0',
    source: 'package signalk-alert-ruleset-example',
    package: { name: 'signalk-alert-ruleset-example', version: '1.0.0' },
    enabled: stored.enabled,
    parameters: [
      { name: 'lowVoltage', type: 'number', unit: 'V', default: DEFAULT_LOW, minimum: 10 }
    ],
    values: { ...stored.values },
    rules: ['low'],
    missingPaths: [],
    notices: []
  })

  const rule = (): RuleEntry => {
    const limit = 'lowVoltage' in stored.values ? stored.values.lowVoltage : DEFAULT_LOW
    return ruleEntry({
      origin: 'batteries',
      slug: 'low',
      ruleset: { name: 'Battery monitoring', version: '1.0.0' },
      rule: { name: 'Battery low', signal: { paths: ['electrical.batteries.house.voltage'] } },
      status: stored.enabled
        ? { badge: 'idle', instances: [instance({ value: 13.4, limit: Number(limit) })] }
        : {
            badge: 'disabled',
            reason: 'ruleset is disabled',
            instances: [instance({ badge: 'disabled', reason: 'ruleset is disabled' })]
          }
    })
  }

  const api = {
    state: vi.fn(() => Promise.resolve(running)),
    rules: vi.fn(() => Promise.resolve([rule()])),
    resetAccumulator: vi.fn(() => Promise.reject(new Error('not expected'))),
    setEvaluation: vi.fn((enabled: boolean) => Promise.resolve({ enabled })),
    ...noAuthoring,
    ...noControls
  } satisfies PanelApi

  const rulesets = {
    list: vi.fn(() => Promise.resolve({ rulesets: [ruleset()], problems: [] })),
    rescan: vi.fn(() => Promise.resolve({ rulesets: [ruleset()], problems: [] })),
    setEnabled: vi.fn((_slug: string, enabled: boolean) => {
      stored.enabled = enabled
      return Promise.resolve(ruleset())
    }),
    setParameters: vi.fn((_slug: string, values: Record<string, number | string>) => {
      stored.values = values
      return Promise.resolve(ruleset())
    }),
    dismissNotices: vi.fn(() => Promise.resolve())
  } satisfies RulesetsApi

  return { api, rulesets }
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

function goTo(hash: string) {
  window.location.hash = hash
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

async function renderShell() {
  vi.useFakeTimers()
  const server = fakeServer()
  render(<Shell api={server.api} rulesets={server.rulesets} paths={noPaths} />)
  await settle()
  return server
}

async function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }))
  await settle()
}

/** The limit shown in the rule's one instance row. */
function shownLimit(): string | null {
  const [, row] = screen.getAllByRole('row')
  const limitColumn = 2
  return within(row).getAllByRole('cell')[limitColumn].textContent
}

describe('Shell with rulesets', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    window.history.replaceState(null, '', '/')
  })

  it('enables a ruleset, changes a parameter the rule takes, and resets it', async () => {
    const { rulesets } = await renderShell()
    await openTab('Rulesets')

    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    await settle()
    expect(rulesets.setEnabled).toHaveBeenCalledWith('batteries', true)

    fireEvent.change(screen.getByRole('textbox', { name: 'lowVoltage' }), {
      target: { value: '11.5' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }))
    await settle()

    const link = screen.getByRole('link', { name: 'Battery low' })
    act(() => {
      goTo(link.getAttribute('href') ?? '')
    })
    await settle()
    expect(screen.getByRole('heading', { name: 'Battery low' })).toBeTruthy()
    expect(shownLimit()).toBe('11.5')

    await openTab('Rulesets')
    fireEvent.click(screen.getByRole('button', { name: 'Reset lowVoltage to default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }))
    await settle()
    expect(rulesets.setParameters).toHaveBeenLastCalledWith('batteries', {})

    act(() => {
      goTo(screen.getByRole('link', { name: 'Battery low' }).getAttribute('href') ?? '')
    })
    await settle()
    expect(shownLimit()).toBe(String(DEFAULT_LOW))
  })

  it('keeps a failed rescan on screen through the next poll', async () => {
    const { rulesets } = await renderShell()
    await openTab('Rulesets')
    rulesets.rescan.mockRejectedValueOnce(new Error('the data directory could not be written'))
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))
    await settle()
    const listed = rulesets.list.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(rulesets.list.mock.calls.length).toBeGreaterThan(listed)
    expect(screen.getByRole('alert').textContent).toMatch(/could not be written/)
  })

  it('shows a ruleset rule as provided, read-only, with a way to its ruleset', async () => {
    window.history.replaceState(null, '', '/#rule=batteries/low')
    await renderShell()
    expect(screen.getByText('Provided by Battery monitoring v1.0.0')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Open ruleset Battery monitoring' }))
    await settle()
    expect(screen.getByRole('tab', { name: 'Rulesets' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Battery monitoring' }))
    // A browser fires no hashchange for a link to the hash it already shows.
    const back = screen.getByRole('link', { name: 'Battery low' }).getAttribute('href')
    expect(back).not.toBe(window.location.hash)
  })
})
