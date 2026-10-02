// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  httpApi,
  REQUEST_TIMEOUT_MS,
  SessionExpiredError,
  type PanelApi,
  type PluginState,
  type RuleEntry
} from '../../src/panel/api'
import type { PathSource } from '../../src/panel/paths/selfPaths'
import { Shell } from '../../src/panel/Shell'
import { POLL_INTERVAL_MS } from '../../src/panel/shellState'
import { instance, noAuthoring, noControls, ruleEntry } from './fixtures'

interface Server {
  state: PluginState | Error
  rules: RuleEntry[]
}

function mockApi(server: Server) {
  const api = {
    state: vi.fn(() =>
      server.state instanceof Error ? Promise.reject(server.state) : Promise.resolve(server.state)
    ),
    rules: vi.fn(() => Promise.resolve(server.rules)),
    resetAccumulator: vi.fn((_slug: string): Promise<RuleEntry> =>
      Promise.reject(new Error('not expected'))
    ),
    ...noAuthoring,
    ...noControls
  } satisfies PanelApi
  return api
}

const noPaths: PathSource = {
  selfPaths: () => Promise.resolve([]),
  distanceUnit: () => Promise.resolve({ symbol: 'm', scale: 1, offset: 0, si: true })
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
    render(<Shell api={api} paths={noPaths} />)
    return api
  }

  it('shows loading until the first answer', () => {
    renderShell({ state: running, rules: [] })
    expect(screen.getByRole('status').textContent).toMatch(/loading/i)
  })

  it('shows the rules when the plugin runs', async () => {
    renderShell({ state: running, rules: [rule] })
    await settle()
    expect(screen.getByRole('link', { name: 'Oil pressure low' })).toBeTruthy()
  })

  it('points to rule creation when there are no rules', async () => {
    renderShell({ state: running, rules: [] })
    await settle()
    expect(screen.getByText(/no alert rules yet/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /new rule/i })).toBeTruthy()
  })

  it('retries automatically while the API is unreachable', async () => {
    const server: Server = { state: new Error('Failed to fetch'), rules: [] }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /cannot reach.*failed to fetch.*retrying/i
    )
    server.state = running
    await tick(POLL_INTERVAL_MS)
    expect(screen.queryByText(/cannot reach/i)).toBeNull()
    expect(screen.getAllByRole('button', { name: /new rule/i })).toHaveLength(1)
    expect(api.state).toHaveBeenCalledTimes(2)
  })

  // A disabled plugin is one case: the server serves the webapp's files
  // whether or not the plugin is enabled, so a bookmarked link can open it.
  it('retries at the normal interval while the plugin is not running', async () => {
    const server: Server = { state: { running: false, securityEnabled: true }, rules: [] }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /the alert rules plugin is not running\. retrying…/i
    )
    expect(screen.queryByText(/disabled/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull()
    await tick(POLL_INTERVAL_MS - 1)
    expect(api.state).toHaveBeenCalledTimes(1)
    server.state = running
    await tick(1)
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('button', { name: /new rule/i })).toHaveLength(1)
  })

  it('asks to log in again when the session has expired, and stops polling', async () => {
    const server: Server = { state: new SessionExpiredError(), rules: [] }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /your session has expired or lacks administrator rights; log in as an administrator/i
    )
    await tick(POLL_INTERVAL_MS * 3)
    expect(api.state).toHaveBeenCalledTimes(1)
    server.state = running
    fireEvent.click(screen.getByRole('button', { name: /check again/i }))
    await settle()
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('button', { name: /new rule/i })).toHaveLength(1)
  })

  it('shows the start error and that editing is unavailable', async () => {
    const error = 'the server has no alerts API'
    renderShell({
      state: { running: false, error, securityEnabled: true },
      rules: []
    })
    await settle()
    const alert = screen.getByRole('alert').textContent
    expect(alert).toContain(error)
    expect(alert).toMatch(/cannot be edited/i)
    expect(screen.queryAllByRole('button', { name: /new rule/i })).toHaveLength(0)
  })

  it('warns persistently while server security is disabled', async () => {
    const server: Server = {
      state: { running: true, securityEnabled: false },
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
    renderShell({ state: { running: true, securityEnabled: null }, rules: [] })
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
    render(<Shell api={httpApi(fetchFn)} paths={noPaths} />)
    await tick(REQUEST_TIMEOUT_MS)
    expect(screen.getByRole('alert').textContent).toMatch(/cannot reach.*retrying/i)
    hang = false
    await tick(POLL_INTERVAL_MS)
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1)
  })

  it('polls every interval and pauses while the tab is hidden', async () => {
    const api = renderShell({ state: running, rules: [] })
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
    const api = renderShell({ state: running, rules: [] })
    await settle()
    expect(api.state).toHaveBeenCalledTimes(1)
    cleanup()
    await tick(POLL_INTERVAL_MS * 5)
    expect(api.state).toHaveBeenCalledTimes(1)
  })

  it('does not start a second probe when the tab reappears during one', async () => {
    vi.useFakeTimers()
    let answerFirst: (state: PluginState) => void = () => undefined
    const api = mockApi({ state: running, rules: [] })
    api.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerFirst = resolve
        })
    )
    render(<Shell api={api} paths={noPaths} />)
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
  const ADMIN = '#/e/signalk_alert_rules'
  const hours = ruleEntry({
    slug: 'engine-hours',
    rule: { name: 'Engine hours', detector: { type: 'accumulator', measure: 'time' } },
    status: {
      condition: 'alerting',
      reason: 'alertActive',
      instances: [
        {
          condition: 'alerting',
          reason: 'alertActive',
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
    render(<Shell api={api} paths={noPaths} />)
    await settle()
    return api
  }

  it('lists the rules, each linking to its detail after the admin UI route', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}`)
    await renderShell({ state: running, rules: [rule, hours] })
    expect(screen.getByRole('link', { name: 'Oil pressure low' }).getAttribute('href')).toBe(
      `${ADMIN}#rule=oil-pressure-low`
    )
  })

  it('opens the rule the fragment names and goes back to the list', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}#rule=engine-hours`)
    await renderShell({ state: running, rules: [rule, hours] })
    expect(screen.getByRole('heading', { name: 'Engine hours' })).toBeTruthy()
    const back = screen.getByRole('link', { name: /all rules/i })
    expect(back.getAttribute('href')).toBe(ADMIN)
    act(() => {
      goTo(ADMIN)
    })
    expect(screen.queryByRole('heading', { name: 'Engine hours' })).toBeNull()
    act(() => {
      goTo(`${ADMIN}#rule=oil-pressure-low`)
    })
    expect(screen.getByRole('heading', { name: 'Oil pressure low' })).toBeTruthy()
  })

  describe('focus on navigation', () => {
    it('moves to the heading of the view opened, not on first load', async () => {
      await renderShell({ state: running, rules: [rule, hours] })
      expect(document.activeElement).toBe(document.body)
      act(() => {
        goTo('#rule=engine-hours')
      })
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Engine hours' }))
      act(() => {
        goTo('#')
      })
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'All rules' }))
    })

    it('moves to the heading of a rule that is not found', async () => {
      await renderShell({ state: running, rules: [rule] })
      act(() => {
        goTo('#rule=gone')
      })
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: /not found/i }))
    })

    it('leaves focus alone when a poll re-renders the view', async () => {
      await renderShell({ state: running, rules: [rule] })
      act(() => {
        goTo('#rule=oil-pressure-low')
      })
      const back = screen.getByRole('link', { name: /all rules/i })
      back.focus()
      await tick(POLL_INTERVAL_MS)
      expect(document.activeElement).toBe(back)
    })
  })

  describe('instance links', () => {
    const batteries = ruleEntry({
      slug: 'battery-low',
      rule: { name: 'Battery low', signal: { paths: ['electrical.batteries.*.voltage'] } },
      status: {
        instances: [
          instance({ instance: { name: 'house', segment: 'house' } }),
          instance({ instance: { name: 'Start 1', segment: 'Start_1' }, value: 11.5 })
        ]
      }
    })

    it('highlights the instance a link names and focuses its row', async () => {
      await renderShell({ state: running, rules: [rule, batteries] })
      act(() => {
        goTo(`${ADMIN}#rule=battery-low&instance=Start%201`)
      })
      const row = screen.getByRole('row', { name: /start 1/i })
      expect(row.getAttribute('aria-current')).toBe('true')
      expect(document.activeElement).toBe(row)
      expect(screen.getByRole('row', { name: /house/i }).getAttribute('aria-current')).toBeNull()
    })

    it('finds the instance by its alert path segment too', async () => {
      window.history.replaceState(null, '', '/#rule=battery-low&instance=Start_1')
      await renderShell({ state: running, rules: [batteries] })
      expect(screen.getByRole('row', { name: /start 1/i }).getAttribute('aria-current')).toBe(
        'true'
      )
      // Not on first load, which must not take focus from the admin UI.
      expect(document.activeElement).toBe(document.body)
    })

    it('shows the rule with a notice for an instance it does not have', async () => {
      await renderShell({ state: running, rules: [batteries] })
      act(() => {
        goTo('#rule=battery-low&instance=aft')
      })
      expect(screen.getByRole('heading', { name: 'Battery low' })).toBe(document.activeElement)
      expect(screen.getByText(/no instance aft/i)).toBeTruthy()
      expect(
        screen.getAllByRole('row').filter((r) => r.getAttribute('aria-current') === 'true')
      ).toEqual([])
    })
  })

  it('says when the rule the fragment names does not exist', async () => {
    window.history.replaceState(null, '', '/#rule=gone')
    await renderShell({ state: running, rules: [rule] })
    expect(screen.getByText(/no rule gone/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /all rules/i })).toBeTruthy()
  })

  it('resets an accumulator and shows the rule as it is after', async () => {
    window.history.replaceState(null, '', '/#rule=engine-hours')
    const server: Server = { state: running, rules: [hours] }
    const api = await renderShell(server)
    const after = {
      ...hours,
      status: { ...hours.status, condition: 'normal' as const, instances: [] }
    }
    api.resetAccumulator.mockImplementation(() => {
      server.rules = [after]
      return Promise.resolve(after)
    })
    fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
    fireEvent.click(screen.getByRole('button', { name: /reset total/i }))
    await settle()
    expect(api.resetAccumulator).toHaveBeenCalledWith('engine-hours')
    expect(api.rules).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('Normal')).toBeTruthy()
  })

  it('disables a rule and shows it as the server answers after', async () => {
    window.history.replaceState(null, '', '/#rule=oil-pressure-low')
    const server: Server = { state: running, rules: [rule] }
    const api = await renderShell(server)
    const disabled = ruleEntry({
      disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'skipper', note: 'fouled' },
      status: { condition: 'present', reason: 'conditionPresent' }
    })
    const disableRule = vi.fn(() => {
      server.rules = [disabled]
      return Promise.resolve(disabled)
    })
    Object.assign(api, { disableRule })
    fireEvent.click(screen.getByRole('button', { name: 'Disable…' }))
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), {
      target: { value: 'fouled' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await settle()
    expect(disableRule).toHaveBeenCalledWith('oil-pressure-low', 'fouled')
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  describe('problems found while loading', () => {
    const issues = ['stored rule broken is not valid and does not run: /signal: required']

    it('lists them above the rules', async () => {
      await renderShell({ state: { ...running, issues }, rules: [rule] })
      const problems = screen.getByRole('region', { name: /problems/i })
      expect(problems.textContent).toContain(issues[0])
      expect(screen.getByRole('link', { name: 'Oil pressure low' })).toBeTruthy()
      expect(
        problems.compareDocumentPosition(screen.getByRole('searchbox')) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('lists them when no rule loaded, without claiming there are none', async () => {
      await renderShell({ state: { ...running, issues }, rules: [] })
      expect(screen.getByRole('region', { name: /problems/i }).textContent).toContain(issues[0])
      expect(screen.queryByText(/no alert rules yet/i)).toBeNull()
      expect(screen.getByText(/no alert rule is listed/i)).toBeTruthy()
    })

    it('shows no problems section when there are none', async () => {
      await renderShell({ state: { ...running, issues: [] }, rules: [rule] })
      expect(screen.queryByRole('region', { name: /problems/i })).toBeNull()
    })
  })

  describe('while the plugin is briefly out of reach', () => {
    it('keeps the filters and shows the condition above the last rules read', async () => {
      const server: Server = { state: running, rules: [rule, hours] }
      await renderShell(server)
      fireEvent.change(screen.getByRole('searchbox', { name: /filter/i }), {
        target: { value: 'engine' }
      })
      server.state = new Error('Failed to fetch')
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('alert').textContent).toMatch(/cannot reach.*failed to fetch/i)
      expect(screen.getByRole('alert').textContent).toMatch(/last read/i)
      const filter = () => screen.getByRole<HTMLInputElement>('searchbox', { name: /filter/i })
      expect(filter().value).toBe('engine')
      expect(screen.getByRole('link', { name: 'Engine hours' })).toBeTruthy()
      expect(screen.queryByRole('link', { name: 'Oil pressure low' })).toBeNull()

      server.state = running
      await tick(POLL_INTERVAL_MS)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(filter().value).toBe('engine')
    })

    it('keeps the last rules read while the plugin is not running', async () => {
      const server: Server = { state: running, rules: [rule] }
      const api = await renderShell(server)
      server.state = { running: false, securityEnabled: true }
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('alert').textContent).toMatch(/not running.*last read/i)
      expect(screen.queryByRole('button', { name: /check again/i })).toBeNull()
      expect(screen.getByRole('link', { name: 'Oil pressure low' })).toBeTruthy()
      server.state = running
      await tick(POLL_INTERVAL_MS)
      expect(api.state).toHaveBeenCalledTimes(3)
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('keeps an open reset confirmation through a failed poll, and it still resets', async () => {
      window.history.replaceState(null, '', '/#rule=engine-hours')
      const server: Server = { state: running, rules: [hours] }
      const api = await renderShell(server)
      api.resetAccumulator.mockImplementation(() => Promise.resolve(hours))
      fireEvent.click(screen.getByRole('button', { name: /reset accumulator/i }))
      server.state = new Error('Failed to fetch')
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('alert').textContent).toMatch(/cannot reach/i)
      const dialog = screen.getByRole('alertdialog')
      server.state = running
      fireEvent.click(within(dialog).getByRole('button', { name: /reset total/i }))
      await settle()
      expect(api.resetAccumulator).toHaveBeenCalledWith('engine-hours')
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('drops the views when the plugin fails to start', async () => {
      const server: Server = { state: running, rules: [rule] }
      await renderShell(server)
      server.state = {
        running: false,
        error: 'the server has no alerts API',
        securityEnabled: true
      }
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('alert').textContent).toMatch(/could not start/i)
      expect(screen.queryAllByRole('button', { name: /new rule/i })).toHaveLength(0)
    })
  })

  it('lists the rules with no control to clear every alert or pause evaluation', async () => {
    await renderShell({ state: running, rules: [rule, hours] })
    expect(screen.getByText('Oil pressure low')).toBeTruthy()
    expect(screen.getByText('Engine hours')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /evaluation/i })).toBeNull()
    expect(screen.queryByText(/evaluation is off/i)).toBeNull()
  })
})
