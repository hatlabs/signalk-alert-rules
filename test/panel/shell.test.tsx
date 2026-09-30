// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  httpApi,
  REQUEST_TIMEOUT_MS,
  SessionExpiredError,
  type PanelApi,
  type PluginState,
  type RuleEntry
} from '../../src/panel/api'
import { Shell } from '../../src/panel/Shell'
import { DISABLED_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from '../../src/panel/shellState'
import { ruleEntry } from './fixtures'

interface Server {
  state: PluginState | Error
  enabled: boolean
  rules: RuleEntry[]
}

function mockApi(server: Server) {
  const api = {
    state: vi.fn(() =>
      server.state instanceof Error ? Promise.reject(server.state) : Promise.resolve(server.state)
    ),
    pluginEnabled: vi.fn(() => Promise.resolve(server.enabled)),
    rules: vi.fn(() => Promise.resolve(server.rules)),
    resetAccumulator: vi.fn((_origin: string, _slug: string): Promise<RuleEntry> =>
      Promise.reject(new Error('not expected'))
    ),
    setEvaluation: vi.fn((enabled: boolean) => Promise.resolve({ enabled }))
  } satisfies PanelApi
  return api
}

const running: PluginState = { running: true, securityEnabled: true }
const rule = ruleEntry()

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

  it('asks to log in again when the session has expired, and stops polling', async () => {
    const server: Server = { state: new SessionExpiredError(), enabled: true, rules: [] }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /your session has expired or lacks administrator rights; log in as an administrator/i
    )
    await tick(DISABLED_POLL_INTERVAL_MS * 3)
    expect(api.state).toHaveBeenCalledTimes(1)
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

  it('stops polling when unmounted', async () => {
    const api = renderShell({ state: running, enabled: true, rules: [] })
    await settle()
    expect(api.state).toHaveBeenCalledTimes(1)
    cleanup()
    await tick(POLL_INTERVAL_MS * 5)
    expect(api.state).toHaveBeenCalledTimes(1)
  })

  it('does not start a second probe when the tab reappears during one', async () => {
    vi.useFakeTimers()
    let answerFirst: (state: PluginState) => void = () => undefined
    const api = mockApi({ state: running, enabled: true, rules: [] })
    api.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerFirst = resolve
        })
    )
    render(<Shell api={api} />)
    setVisibility('hidden')
    setVisibility('visible')
    await settle()
    expect(api.state).toHaveBeenCalledTimes(1)
    answerFirst(running)
    await settle()
    expect(api.state).toHaveBeenCalledTimes(1)
    await tick(POLL_INTERVAL_MS)
    expect(api.state).toHaveBeenCalledTimes(2)
    await tick(POLL_INTERVAL_MS)
    expect(api.state).toHaveBeenCalledTimes(3)
  })
})

describe('Shell rules', () => {
  const ADMIN = '#/apps/configuration/signalk-alert-rules'
  const hours = ruleEntry({
    slug: 'engine-hours',
    rule: { name: 'Engine hours', detector: { type: 'accumulator', measure: 'time' } },
    status: {
      instances: [
        {
          badge: 'alertActive',
          active: true,
          subLabels: [],
          gates: [],
          progress: { kind: 'total', total: 7200, limit: 3600 }
        }
      ]
    }
  })

  function goTo(hash: string) {
    window.location.hash = hash
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    window.history.replaceState(null, '', '/')
  })

  async function renderShell(server: Server) {
    vi.useFakeTimers()
    const api = mockApi(server)
    render(<Shell api={api} />)
    await settle()
    return api
  }

  it('lists the rules, each linking to its detail after the admin UI route', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}`)
    await renderShell({ state: running, enabled: true, rules: [rule, hours] })
    expect(screen.getByRole('link', { name: 'Oil pressure low' }).getAttribute('href')).toBe(
      `${ADMIN}#rule=user/oil-pressure-low`
    )
  })

  it('opens the rule the fragment names and goes back to the list', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}#rule=user/engine-hours`)
    await renderShell({ state: running, enabled: true, rules: [rule, hours] })
    expect(screen.getByRole('heading', { name: 'Engine hours' })).toBeTruthy()
    const back = screen.getByRole('link', { name: /all rules/i })
    expect(back.getAttribute('href')).toBe(ADMIN)
    act(() => {
      goTo(ADMIN)
    })
    expect(screen.queryByRole('heading', { name: 'Engine hours' })).toBeNull()
    act(() => {
      goTo(`${ADMIN}#rule=user/oil-pressure-low`)
    })
    expect(screen.getByRole('heading', { name: 'Oil pressure low' })).toBeTruthy()
  })

  it('shows the rules tab when a fragment names a rule', async () => {
    await renderShell({ state: running, enabled: true, rules: [rule] })
    fireEvent.click(screen.getByRole('tab', { name: 'Suppressions' }))
    act(() => {
      goTo('#rule=user/oil-pressure-low')
    })
    expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Oil pressure low' })).toBeTruthy()
  })

  it('says when the rule the fragment names does not exist', async () => {
    window.history.replaceState(null, '', '/#rule=user/gone')
    await renderShell({ state: running, enabled: true, rules: [rule] })
    expect(screen.getByText(/no rule user\/gone/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /all rules/i })).toBeTruthy()
  })

  it('resets an accumulator and shows the rule as it is after', async () => {
    window.history.replaceState(null, '', '/#rule=user/engine-hours')
    const server: Server = { state: running, enabled: true, rules: [hours] }
    const api = await renderShell(server)
    const after = { ...hours, status: { ...hours.status, badge: 'idle' as const, instances: [] } }
    api.resetAccumulator.mockImplementation(() => {
      server.rules = [after]
      return Promise.resolve(after)
    })
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    fireEvent.click(screen.getByRole('button', { name: /reset total/i }))
    await settle()
    expect(api.resetAccumulator).toHaveBeenCalledWith('user', 'engine-hours')
    expect(api.rules).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('Idle')).toBeTruthy()
  })

  it('does not offer to clear all alerts while evaluation is off', async () => {
    await renderShell({
      state: { ...running, evaluation: { enabled: false } },
      enabled: true,
      rules: [rule, hours]
    })
    expect(screen.getByText(/evaluation is off/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /clear all skar alerts/i })).toBeNull()
  })

  it('clears all alerts by turning evaluation off, then offers to turn it on', async () => {
    const server: Server = { state: running, enabled: true, rules: [rule, hours] }
    const api = await renderShell(server)
    api.setEvaluation.mockImplementation((enabled: boolean) => {
      server.state = { ...running, evaluation: { enabled } }
      return Promise.resolve({ enabled })
    })
    fireEvent.click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    expect(screen.getByRole('alertdialog').textContent).toMatch(/1 active alert\b/)
    fireEvent.click(screen.getByRole('button', { name: /clear all alerts/i }))
    await settle()
    expect(api.setEvaluation).toHaveBeenCalledWith(false)
    expect(screen.getByText(/evaluation is off/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /turn evaluation on/i }))
    await settle()
    expect(api.setEvaluation).toHaveBeenLastCalledWith(true)
    expect(screen.queryByText(/evaluation is off/i)).toBeNull()
  })
})
