// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  httpApi,
  REQUEST_TIMEOUT_MS,
  type PanelApi,
  type PluginState,
  type RuleSummary
} from '../../src/panel/api'
import { Shell } from '../../src/panel/Shell'
import { DISABLED_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from '../../src/panel/shellState'

interface Server {
  state: PluginState | Error
  enabled: boolean
  rules: RuleSummary[]
}

function mockApi(server: Server) {
  const api = {
    state: vi.fn(() =>
      server.state instanceof Error ? Promise.reject(server.state) : Promise.resolve(server.state)
    ),
    pluginEnabled: vi.fn(() => Promise.resolve(server.enabled)),
    rules: vi.fn(() => Promise.resolve(server.rules))
  } satisfies PanelApi
  return api
}

const running: PluginState = { running: true, securityEnabled: true }
const rule: RuleSummary = { origin: 'user', slug: 'oil-pressure-low' }

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Lets pending promises settle and React commit, without advancing time. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('Shell', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    setVisibility('visible')
  })

  function renderShell(server: Server) {
    vi.useFakeTimers()
    const api = mockApi(server)
    render(<Shell api={api} />)
    return api
  }

  it('shows loading until the first answer', () => {
    renderShell({ state: running, enabled: true, rules: [] })
    expect(screen.getByRole('status').textContent).toMatch(/loading/i)
  })

  it('shows the views and navigation when the plugin runs', async () => {
    renderShell({ state: running, enabled: true, rules: [rule] })
    await settle()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual(['Rules', 'Suppressions', 'Rulesets'])
    expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Suppressions' }))
    expect(screen.getByRole('tabpanel').getAttribute('aria-label')).toBe('Suppressions')
  })

  it('points to rule creation and rulesets when there are no rules', async () => {
    renderShell({ state: running, enabled: true, rules: [] })
    await settle()
    expect(screen.getByText(/no alert rules yet/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /new rule/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /browse rulesets/i }))
    expect(screen.getByRole('tab', { name: 'Rulesets' }).getAttribute('aria-selected')).toBe('true')
  })

  it('retries automatically while the API is unreachable', async () => {
    const server: Server = { state: new Error('Failed to fetch'), enabled: true, rules: [] }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /cannot reach.*failed to fetch.*retrying/i
    )
    server.state = running
    await tick(POLL_INTERVAL_MS)
    expect(screen.queryByText(/cannot reach/i)).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(api.state).toHaveBeenCalledTimes(2)
  })

  it('retries automatically while the plugin restarts', async () => {
    const server: Server = {
      state: { running: false, securityEnabled: true },
      enabled: true,
      rules: []
    }
    renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/restarting.*retrying/i)
    server.state = running
    await tick(POLL_INTERVAL_MS)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('asks to enable a disabled plugin and notices when it is enabled', async () => {
    const server: Server = {
      state: { running: false, securityEnabled: true },
      enabled: false,
      rules: []
    }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/disabled.*enable/i)
    await tick(DISABLED_POLL_INTERVAL_MS - 1)
    expect(api.state).toHaveBeenCalledTimes(1)
    server.enabled = true
    server.state = running
    await tick(1)
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('checks a disabled plugin again at once on request', async () => {
    const server: Server = {
      state: { running: false, securityEnabled: true },
      enabled: false,
      rules: []
    }
    const api = renderShell(server)
    await settle()
    server.enabled = true
    server.state = running
    fireEvent.click(screen.getByRole('button', { name: /check again/i }))
    await settle()
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('shows the start error and that editing is unavailable', async () => {
    const error = 'the server has no alerts API'
    renderShell({
      state: { running: false, error, securityEnabled: true },
      enabled: true,
      rules: []
    })
    await settle()
    const alert = screen.getByRole('alert').textContent
    expect(alert).toContain(error)
    expect(alert).toMatch(/cannot be edited/i)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('warns persistently while server security is disabled', async () => {
    const server: Server = {
      state: { running: true, securityEnabled: false },
      enabled: true,
      rules: [rule]
    }
    renderShell(server)
    await settle()
    expect(screen.getByText(/server security is disabled/i)).toBeTruthy()
    server.state = { running: false, securityEnabled: false }
    await tick(POLL_INTERVAL_MS)
    expect(screen.getByText(/server security is disabled/i)).toBeTruthy()
  })

  it('does not warn about security when it is enabled or unknown', async () => {
    renderShell({ state: { running: true, securityEnabled: null }, enabled: true, rules: [] })
    await settle()
    expect(screen.queryByText(/server security is disabled/i)).toBeNull()
  })

  it('treats a request that never answers as unreachable and polls again', async () => {
    vi.useFakeTimers()
    let hang = true
    const fetchFn = vi.fn<typeof fetch>((_input, init) =>
      hang
        ? new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error)
            })
          })
        : Promise.resolve(Response.json({ running: true, securityEnabled: true }))
    )
    render(<Shell api={httpApi(fetchFn)} />)
    await tick(REQUEST_TIMEOUT_MS)
    expect(screen.getByRole('alert').textContent).toMatch(/cannot reach.*retrying/i)
    hang = false
    await tick(POLL_INTERVAL_MS)
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1)
  })

  it('polls every interval and pauses while the tab is hidden', async () => {
    const api = renderShell({ state: running, enabled: true, rules: [] })
    await settle()
    await tick(POLL_INTERVAL_MS)
    expect(api.state).toHaveBeenCalledTimes(2)
    setVisibility('hidden')
    await tick(POLL_INTERVAL_MS * 3)
    expect(api.state).toHaveBeenCalledTimes(2)
    setVisibility('visible')
    await settle()
    expect(api.state).toHaveBeenCalledTimes(3)
    await tick(POLL_INTERVAL_MS)
    expect(api.state).toHaveBeenCalledTimes(4)
  })
})
