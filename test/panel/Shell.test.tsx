// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  httpApi,
  REQUEST_TIMEOUT_MS,
  SessionExpiredError,
  type ListedRule,
  type PanelApi,
  type Permissions,
  type PluginState,
  type RuleEntry
} from '../../src/panel/api'
import type { PathSource } from '../../src/panel/paths/selfPaths'
import { Shell } from '../../src/panel/Shell'
import { POLL_INTERVAL_MS } from '../../src/panel/shellState'
import { instance, invalidEntry, noAuthoring, noControls, noTemplates, ruleEntry } from './fixtures'

interface Server {
  state: PluginState | Error
  rules: ListedRule[]
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
    ...noControls,
    ...noTemplates
  } satisfies PanelApi
  return api
}

const noPaths: PathSource = {
  selfPaths: () => Promise.resolve([]),
  distanceUnit: () => Promise.resolve({ symbol: 'm', scale: 1, offset: 0, si: true })
}

const running: PluginState = { running: true, permissions: 'admin', securityEnabled: true }
const as = (permissions: Permissions): PluginState => ({ ...running, permissions })
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

const listShown = () => screen.queryByRole('heading', { name: 'Alert rules' }) !== null

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
    expect(screen.getByRole('link', { name: /oil pressure low/i })).toBeTruthy()
  })

  it('invites starting from a template when there are no rules', async () => {
    renderShell({ state: running, rules: [] })
    await settle()
    expect(screen.getByRole('heading', { name: 'No alert rules yet' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Start from a template' })).toBeTruthy()
  })

  it('retries automatically while the API is unreachable', async () => {
    const server: Server = { state: new Error('Failed to fetch'), rules: [rule] }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(
      'Reconnecting to the plugin (Failed to fetch).'
    )
    server.state = running
    await tick(POLL_INTERVAL_MS)
    expect(screen.queryByText(/reconnecting/i)).toBeNull()
    expect(listShown()).toBe(true)
    expect(api.state).toHaveBeenCalledTimes(2)
  })

  // A disabled plugin is one case: the server serves the webapp's files
  // whether or not the plugin is enabled, so a bookmarked link can open it.
  it('retries at the normal interval while the plugin is not running', async () => {
    const server: Server = {
      state: { running: false, permissions: 'admin', securityEnabled: true },
      rules: [rule]
    }
    const api = renderShell(server)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(
      /the alert rules plugin is not running\. retrying…/i
    )
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull()
    await tick(POLL_INTERVAL_MS - 1)
    expect(api.state).toHaveBeenCalledTimes(1)
    server.state = running
    await tick(1)
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(listShown()).toBe(true)
  })

  it('asks to log in again when the login has expired, and stops polling', async () => {
    const server: Server = { state: new SessionExpiredError(), rules: [rule] }
    const api = renderShell(server)
    await settle()
    const alert = screen.getByRole('alert').textContent
    expect(alert).toMatch(/your login has expired\. log in again/i)
    expect(alert).not.toMatch(/administrator/i)
    await tick(POLL_INTERVAL_MS * 3)
    expect(api.state).toHaveBeenCalledTimes(1)
    server.state = running
    fireEvent.click(screen.getByRole('button', { name: /check again/i }))
    await settle()
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(listShown()).toBe(true)
  })

  it('shows the start error and that editing is unavailable', async () => {
    const error = 'the server has no alerts API'
    renderShell({
      state: { running: false, permissions: 'admin', error, securityEnabled: true },
      rules: []
    })
    await settle()
    const alert = screen.getByRole('alert').textContent
    expect(alert).toContain(error)
    expect(alert).toMatch(/cannot be edited/i)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('warns persistently while server security is disabled', async () => {
    const server: Server = {
      state: { running: true, permissions: 'admin', securityEnabled: false },
      rules: [rule]
    }
    renderShell(server)
    await settle()
    expect(screen.getByText(/server security is disabled/i)).toBeTruthy()
    server.state = { running: false, permissions: 'admin', securityEnabled: false }
    await tick(POLL_INTERVAL_MS)
    expect(screen.getByText(/server security is disabled/i)).toBeTruthy()
  })

  it('does not warn about security when it is enabled or unknown', async () => {
    renderShell({
      state: { running: true, permissions: 'admin', securityEnabled: null },
      rules: []
    })
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
        : Promise.resolve(
            Response.json({ running: true, permissions: 'admin', securityEnabled: true })
          )
    )
    render(<Shell api={httpApi(fetchFn)} paths={noPaths} />)
    await tick(REQUEST_TIMEOUT_MS)
    expect(screen.getByRole('alert').textContent).toMatch(/reconnecting to the plugin/i)
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

describe('Shell views', () => {
  const ADMIN = '#/e/signalk_alert_rules'
  // The rule-level status is its worst instance's, as the server sends it.
  const alertingHours = {
    condition: 'alerting',
    reason: 'alertActive',
    priority: 'caution',
    message: 'Engine service due',
    progress: { kind: 'total', total: 950400, limit: 900000 }
  } as const
  const hours = ruleEntry({
    slug: 'engine-hours',
    rule: { name: 'Engine hours', detector: { type: 'accumulator', measure: 'time' } },
    status: {
      ...alertingHours,
      value: undefined,
      instances: [{ ...alertingHours, gates: [] }]
    }
  })

  function goTo(hash: string) {
    act(() => {
      window.location.hash = hash
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
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

  it('lists the rules in attention order, each linking to its detail after the admin UI route', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}`)
    await renderShell({ state: running, rules: [rule, invalidEntry(), hours] })
    const attention = screen.getByRole('region', { name: 'Needs attention' })
    const links = within(attention).getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      `${ADMIN}#rule=engine-hours`,
      `${ADMIN}#rule=coolant-high`
    ])
    expect(screen.getByText('1 alerting · 1 problem · 1 normal')).toBeTruthy()
    expect(within(links[0]).getByText('264 h of 250 h')).toBeTruthy()
  })

  it('opens the rule the fragment names, and the back link returns to the list', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}#rule=engine-hours`)
    await renderShell({ state: running, rules: [rule, hours] })
    expect(screen.getByRole('heading', { name: 'Engine hours' })).toBeTruthy()
    const back = screen.getByRole('link', { name: 'Alert rules' })
    expect(back.getAttribute('href')).toBe(ADMIN)
    goTo(ADMIN)
    expect(screen.queryByRole('heading', { name: 'Engine hours' })).toBeNull()
    expect(listShown()).toBe(true)
    goTo(`${ADMIN}#rule=oil-pressure-low`)
    expect(screen.getByRole('heading', { name: 'Oil pressure low' })).toBeTruthy()
  })

  it('charts the history of the rule it opens, once the server has a provider', async () => {
    window.history.replaceState(null, '', `/admin/${ADMIN}#rule=oil-pressure-low`)
    vi.useFakeTimers()
    const history = {
      hasProvider: vi.fn(() => Promise.resolve(true)),
      values: vi.fn(() =>
        Promise.resolve({
          min: [
            { time: Date.now() - 1_200_000, value: 250_000 },
            { time: Date.now() - 600_000, value: 240_000 }
          ]
        })
      )
    }
    render(
      <Shell api={mockApi({ state: running, rules: [rule] })} paths={noPaths} history={history} />
    )
    await settle()
    await settle()
    expect(screen.getByRole('img', { name: 'Last 24 hours with the limit' })).toBeTruthy()
    expect(history.values).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'propulsion.port.oilPressure', methods: ['min'] })
    )
  })

  it('lands a link to a rule that is not there on the list, saying so', async () => {
    window.history.replaceState(null, '', '/#rule=gone')
    await renderShell({ state: running, rules: [rule] })
    expect(screen.getByRole('alert').textContent).toMatch(/rule not found.*no rule gone/i)
    expect(screen.getByRole('link', { name: /oil pressure low/i })).toBeTruthy()
  })

  it('shows what is wrong with a stored rule that does not run', async () => {
    window.history.replaceState(null, '', '/#rule=coolant-high')
    await renderShell({ state: running, rules: [invalidEntry()] })
    expect(screen.getByRole('heading', { name: 'Coolant high' })).toBeTruthy()
    expect(screen.getByText(/not valid/i)).toBeTruthy()
    expect(screen.getByText('detector is required')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Fix in the editor' }).getAttribute('href')).toBe(
      '#edit=coolant-high'
    )
  })

  describe('Add rule', () => {
    it('opens Add rule, which offers the data path flow', async () => {
      window.history.replaceState(null, '', `/${ADMIN}#add`)
      await renderShell({ state: running, rules: [rule] })
      expect(screen.getByRole('heading', { name: 'Add rule' })).toBeTruthy()
      expect(screen.getByRole('link', { name: /From a data path/ }).getAttribute('href')).toBe(
        `${ADMIN}#add=path`
      )
      await settle()
      expect(screen.getByText('No template set is installed.')).toBeTruthy()
    })

    it('opens the path search from a data path', async () => {
      window.history.replaceState(null, '', `/${ADMIN}#add=path`)
      await renderShell({ state: running, rules: [rule] })
      expect(screen.getByRole('heading', { name: 'Which value?' })).toBeTruthy()
    })

    it('asks what should alert once the value is chosen', async () => {
      window.history.replaceState(null, '', `/${ADMIN}#add=path&path=a.b`)
      await renderShell({ state: running, rules: [rule] })
      expect(screen.getByRole('heading', { name: 'What should alert?' })).toBeTruthy()
    })

    it('opens the editor once the value and what should alert are chosen', async () => {
      window.history.replaceState(null, '', `/${ADMIN}#add=path&path=a.b&when=below`)
      await renderShell({ state: running, rules: [rule] })
      await settle()
      expect(screen.getByRole('form', { name: 'New rule' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'What should alert?' }).getAttribute('href')).toBe(
        `${ADMIN}#add=path&path=a.b`
      )
    })

    it('says so for a link to a template set that is not installed', async () => {
      window.history.replaceState(null, '', `/${ADMIN}#add=template&set=builtin`)
      await renderShell({ state: running, rules: [rule] })
      await settle()
      expect(screen.getByRole('heading', { name: 'Template not found' })).toBeTruthy()
    })

    it('lands an add link it does not know on the list', async () => {
      window.history.replaceState(null, '', `/${ADMIN}#add=elsewhere`)
      await renderShell({ state: running, rules: [rule] })
      expect(listShown()).toBe(true)
      expect(screen.queryByRole('heading', { name: 'Add rule' })).toBeNull()
    })
  })

  describe('by access level', () => {
    it('gives an administrator every control', async () => {
      window.history.replaceState(null, '', '/#rule=engine-hours')
      await renderShell({ state: running, rules: [hours] })
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
      expect(screen.getByRole('button', { name: /disable/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Reset total…' })).toBeTruthy()
    })

    it('gives a read/write user disable and enable only', async () => {
      window.history.replaceState(null, '', '/#rule=engine-hours')
      await renderShell({ state: as('readwrite'), rules: [hours] })
      expect(screen.getByRole('button', { name: /disable/i })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
      expect(screen.queryByRole('button', { name: /reset/i })).toBeNull()
      goTo('#')
      expect(screen.queryByRole('link', { name: /add rule/i })).toBeNull()
    })

    it('gives a read-only user no controls at all', async () => {
      window.history.replaceState(null, '', '/#rule=engine-hours')
      await renderShell({ state: as('readonly'), rules: [hours] })
      expect(screen.getByRole('heading', { name: 'Engine hours' })).toBeTruthy()
      expect(screen.queryAllByRole('button')).toEqual([])
      goTo('#')
      expect(screen.queryByRole('link', { name: /add rule/i })).toBeNull()
    })

    it.each([
      ['readonly', '#add'],
      ['readonly', '#add=path'],
      ['readonly', '#edit=engine-hours'],
      ['readwrite', '#add'],
      ['readwrite', '#add=path'],
      ['readwrite', '#edit=engine-hours']
    ] as const)(
      'tells a %s user following %s that it needs an administrator',
      async (level, fragment) => {
        window.history.replaceState(null, '', `/${fragment}`)
        await renderShell({ state: as(level), rules: [hours] })
        expect(screen.getByText(/needs an administrator/i)).toBeTruthy()
        expect(screen.queryByRole('form')).toBeNull()
      }
    )
  })

  // Signal K refuses an expired login and a level too low for the route alike
  // with 401; reading /state again tells them apart.
  describe('a refused action', () => {
    const refused = () => Promise.reject(new SessionExpiredError())

    /** Refuses a disable, with the state answering `after` from then on. */
    async function disableRefused(after: PluginState | Error) {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      const server: Server = { state: as('readwrite'), rules: [rule] }
      const api = await renderShell(server)
      Object.assign(api, { disableRule: vi.fn(refused) })
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      server.state = after
      fireEvent.click(screen.getByRole('button', { name: 'Disable rule' }))
      await settle()
      return api
    }

    // A lowered level and, where the server lets anyone read, an expired
    // login both read as read-only, so the notice offers both ways out.
    it('offers a new login or an administrator when the state answers read-only, and drops the control', async () => {
      const api = await disableRefused(as('readonly'))
      expect(screen.getByRole('alert').textContent).toBe(
        'Log in again, or ask an administrator: this action needs more rights than your login has.'
      )
      expect(api.state).toHaveBeenCalledTimes(3)
      expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
    })

    it('drops the notice once the operator moves on, and does not show it on coming back', async () => {
      await disableRefused(as('readonly'))
      expect(screen.getByText(/ask an administrator/i)).toBeTruthy()
      goTo('#')
      expect(screen.queryByText(/ask an administrator/i)).toBeNull()
      goTo('#rule=oil-pressure-low')
      expect(screen.getByRole('heading', { name: 'Oil pressure low' })).toBeTruthy()
      expect(screen.queryByText(/ask an administrator/i)).toBeNull()
    })

    it('says the login has expired when the state is refused too', async () => {
      await disableRefused(new SessionExpiredError())
      const message = within(screen.getByRole('alertdialog')).getByRole('alert').textContent
      expect(message).toMatch(/your login has expired/i)
      expect(message).not.toMatch(/administrator/i)
    })

    it.each([
      // An administrator lowered to read/write: the login is valid.
      [
        as('readwrite'),
        /^Your login does not have the rights for this; it needs an administrator\.$/
      ],
      [new SessionExpiredError(), /your login has expired/i]
    ])('tells a refused reset apart by the state read after it (%o)', async (after, message) => {
      window.history.replaceState(null, '', '/#rule=engine-hours')
      const server: Server = { state: running, rules: [hours] }
      const api = await renderShell(server)
      api.resetAccumulator.mockImplementation(refused)
      fireEvent.click(screen.getByRole('button', { name: 'Reset total…' }))
      server.state = after
      fireEvent.click(screen.getByRole('button', { name: 'Reset total' }))
      await settle()
      // In the dialog while it stays, in a notice once the level takes the control away.
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContainEqual(
        expect.stringMatching(message)
      )
    })
  })

  describe('focus on navigation', () => {
    it('moves to the heading of the view opened, not on first load', async () => {
      await renderShell({ state: running, rules: [rule, hours] })
      expect(document.activeElement).toBe(document.body)
      goTo('#rule=engine-hours')
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Engine hours' }))
      goTo('#')
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alert rules' }))
    })

    it('moves to the notice of a rule that is not found', async () => {
      await renderShell({ state: running, rules: [rule] })
      goTo('#rule=gone')
      expect(document.activeElement).toBe(screen.getByRole('alert'))
    })

    it('leaves focus alone when a poll re-renders the view', async () => {
      await renderShell({ state: running, rules: [rule] })
      goTo('#rule=oil-pressure-low')
      const back = screen.getByRole('link', { name: 'Alert rules' })
      back.focus()
      await tick(POLL_INTERVAL_MS)
      expect(document.activeElement).toBe(back)
    })
  })

  describe('instance links', () => {
    const itemOf = (name: string) => {
      const item = screen.getByText(name).closest('li')
      if (item === null) throw new Error(`no item for ${name}`)
      return item
    }

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
      goTo(`${ADMIN}#rule=battery-low&instance=Start%201`)
      const row = itemOf('Start 1')
      expect(row.getAttribute('aria-current')).toBe('true')
      expect(document.activeElement).toBe(row)
      expect(itemOf('house').getAttribute('aria-current')).toBeNull()
    })

    it('finds the instance by its alert path segment too', async () => {
      window.history.replaceState(null, '', '/#rule=battery-low&instance=Start_1')
      await renderShell({ state: running, rules: [batteries] })
      expect(itemOf('Start 1').getAttribute('aria-current')).toBe('true')
      // Not on first load, which must not take focus from the admin UI.
      expect(document.activeElement).toBe(document.body)
    })

    it('shows the rule with a notice for an instance it does not have', async () => {
      await renderShell({ state: running, rules: [batteries] })
      goTo('#rule=battery-low&instance=aft')
      expect(screen.getByRole('heading', { name: 'Battery low' })).toBe(document.activeElement)
      expect(screen.getByText(/no instance aft/i)).toBeTruthy()
    })
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
    fireEvent.click(screen.getByRole('button', { name: 'Reset total…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset total' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    fireEvent.change(screen.getByRole('textbox', { name: /why/i }), {
      target: { value: 'fouled' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Disable rule' }))
    await settle()
    expect(disableRule).toHaveBeenCalledWith('oil-pressure-low', 'fouled')
    expect(screen.getByRole('button', { name: 'Enable rule' })).toBeTruthy()
  })

  describe('Disable, Enable and Delete', () => {
    const alerting = ruleEntry({
      status: {
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        instances: [instance({ condition: 'alerting', reason: 'alertActive', priority: 'alarm' })]
      }
    })
    const disabledPresent = ruleEntry({
      disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'skipper' },
      status: { condition: 'present', reason: 'conditionPresent' }
    })

    it('disables an alerting rule in three interactions from the list', async () => {
      const server: Server = { state: as('readwrite'), rules: [alerting] }
      const api = await renderShell(server)
      const disableRule = vi.fn(() => {
        server.rules = [disabledPresent]
        return Promise.resolve(disabledPresent)
      })
      Object.assign(api, { disableRule })
      // 1: the rule's row in the list.
      goTo(screen.getByRole('link', { name: /oil pressure low/i }).getAttribute('href') ?? '')
      // 2: Disable; 3: Disable rule in the sheet.
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      fireEvent.click(screen.getByRole('button', { name: 'Disable rule' }))
      await settle()
      expect(disableRule).toHaveBeenCalledWith('oil-pressure-low', '')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.getByRole('group', { name: 'State' }).textContent).toBe('Disabled')
      expect(screen.getByText(/^Disabled by skipper/)).toBeTruthy()
    })

    it('leaves the rule enabled when the sheet is cancelled', async () => {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      const api = await renderShell({ state: running, rules: [alerting] })
      const disableRule = vi.fn()
      Object.assign(api, { disableRule })
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(disableRule).not.toHaveBeenCalled()
      expect(screen.getByRole('group', { name: 'State' }).textContent).toBe('AlertingAlarm')
    })

    it('enables a rule whose condition holds, which shows Alerting after the next poll', async () => {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      const server: Server = { state: running, rules: [disabledPresent] }
      const api = await renderShell(server)
      const enableRule = vi.fn(() => {
        server.rules = [alerting]
        return Promise.resolve(alerting)
      })
      Object.assign(api, { enableRule })
      fireEvent.click(screen.getByRole('button', { name: 'Enable rule' }))
      await settle()
      expect(enableRule).toHaveBeenCalledWith('oil-pressure-low')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.getByRole('group', { name: 'State' }).textContent).toBe('AlertingAlarm')
      expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
    })

    it('deletes a rule after confirming and returns to the list without it', async () => {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      const server: Server = { state: running, rules: [alerting, hours] }
      const api = await renderShell(server)
      let answer: () => void = () => undefined
      const deleteRule = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            answer = resolve
          })
      )
      Object.assign(api, { deleteRule })
      // The next read still has the rule, as one that raced the delete would.
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }))
      await act(async () => {
        answer()
        await Promise.resolve()
      })
      expect(deleteRule).toHaveBeenCalledWith('oil-pressure-low')
      expect(listShown()).toBe(true)
      expect(screen.queryByRole('link', { name: /oil pressure low/i })).toBeNull()
      expect(screen.queryByText(/rule not found/i)).toBeNull()
      server.rules = [hours]
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('link', { name: /engine hours/i })).toBeTruthy()
    })

    it('says nothing is missing when a read during the delete no longer has the rule', async () => {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      const server: Server = { state: running, rules: [alerting, hours] }
      const api = await renderShell(server)
      let answer: () => void = () => undefined
      Object.assign(api, {
        deleteRule: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              answer = resolve
            })
        )
      })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }))
      server.rules = [hours]
      await tick(POLL_INTERVAL_MS)
      expect(screen.queryByText(/rule not found/i)).toBeNull()
      await act(async () => {
        answer()
        await Promise.resolve()
      })
      await settle()
      expect(listShown()).toBe(true)
      expect(screen.queryByText(/rule not found/i)).toBeNull()
    })

    it('keeps the rule and the sheet when the delete fails', async () => {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      const api = await renderShell({ state: running, rules: [alerting] })
      Object.assign(api, { deleteRule: vi.fn(() => Promise.reject(new Error('no such rule'))) })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }))
      await settle()
      expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toBe(
        'no such rule'
      )
      expect(screen.getByRole('heading', { name: 'Oil pressure low' })).toBeTruthy()
    })

    it('gives Delete only to an administrator', async () => {
      window.history.replaceState(null, '', '/#rule=oil-pressure-low')
      await renderShell({ state: as('readwrite'), rules: [alerting] })
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    })
  })

  describe('problems found while loading', () => {
    const issues = ['stored rule file broken.json could not be read']

    it('lists them above the rules', async () => {
      await renderShell({ state: { ...running, issues }, rules: [rule] })
      const problems = screen.getByRole('region', { name: /problems/i })
      expect(problems.textContent).toContain(issues[0])
      expect(
        problems.compareDocumentPosition(screen.getByRole('region', { name: 'Normal' })) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('lists them when no rule loaded, without claiming there are none', async () => {
      await renderShell({ state: { ...running, issues }, rules: [] })
      expect(screen.getByRole('region', { name: /problems/i }).textContent).toContain(issues[0])
      expect(screen.queryByText(/no alert rules yet/i)).toBeNull()
      expect(screen.getByRole('heading', { name: /no alert rule is listed/i })).toBeTruthy()
    })

    it('shows no problems section when there are none', async () => {
      await renderShell({ state: { ...running, issues: [] }, rules: [rule] })
      expect(screen.queryByRole('region', { name: /problems/i })).toBeNull()
    })
  })

  describe('while the plugin is briefly out of reach', () => {
    it('keeps the same list, marked as reconnecting, and recovers without remounting it', async () => {
      const server: Server = { state: running, rules: [rule, hours] }
      const api = await renderShell(server)
      const row = screen.getByRole('link', { name: /engine hours/i })
      server.state = new Error('Failed to fetch')
      await tick(POLL_INTERVAL_MS)
      const banner = screen.getByRole('status')
      expect(banner.textContent).toMatch(
        /^Reconnecting to the plugin \(Failed to fetch\)\. Showing states from \d{1,2}:\d{2}/
      )
      // The same element: the list was not remounted, so its scroll stays where it was.
      expect(screen.getByRole('link', { name: /engine hours/i })).toBe(row)
      await tick(POLL_INTERVAL_MS)
      expect(api.state).toHaveBeenCalledTimes(3)

      server.state = running
      await tick(POLL_INTERVAL_MS)
      expect(screen.queryByText(/reconnecting/i)).toBeNull()
      expect(screen.getByRole('link', { name: /engine hours/i })).toBe(row)
    })

    it('marks the empty state as reconnecting too, still without buttons for a read-only user', async () => {
      const server: Server = { state: as('readonly'), rules: [] }
      await renderShell(server)
      server.state = new Error('Failed to fetch')
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('status').textContent).toMatch(/reconnecting/i)
      expect(screen.getByRole('heading', { name: 'No alert rules yet' })).toBeTruthy()
      expect(screen.queryAllByRole('button')).toEqual([])
    })

    it('shows one banner over the list a link to a missing rule lands on', async () => {
      window.history.replaceState(null, '', '/#rule=gone')
      const server: Server = { state: running, rules: [rule] }
      await renderShell(server)
      server.state = new Error('Failed to fetch')
      await tick(POLL_INTERVAL_MS)
      expect(screen.getAllByText(/reconnecting/i)).toHaveLength(1)
      expect(screen.getByText(/rule not found/i)).toBeTruthy()
    })

    it('keeps the last rules read while the plugin is not running', async () => {
      const server: Server = { state: running, rules: [rule] }
      await renderShell(server)
      server.state = { running: false, permissions: 'admin', securityEnabled: true }
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('status').textContent).toMatch(/not running.*showing states from/i)
      expect(screen.getByRole('link', { name: /oil pressure low/i })).toBeTruthy()
      server.state = running
      await tick(POLL_INTERVAL_MS)
      expect(screen.queryByText(/not running/i)).toBeNull()
    })

    it('shows the banner over a rule detail, keeping an open confirmation that still resets', async () => {
      window.history.replaceState(null, '', '/#rule=engine-hours')
      const server: Server = { state: running, rules: [hours] }
      const api = await renderShell(server)
      api.resetAccumulator.mockImplementation(() => Promise.resolve(hours))
      fireEvent.click(screen.getByRole('button', { name: 'Reset total…' }))
      server.state = new Error('Failed to fetch')
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('status').textContent).toMatch(/reconnecting/i)
      const dialog = screen.getByRole('alertdialog')
      server.state = running
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reset total' }))
      await settle()
      expect(api.resetAccumulator).toHaveBeenCalledWith('engine-hours')
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('drops the views when the plugin fails to start', async () => {
      const server: Server = { state: running, rules: [rule] }
      await renderShell(server)
      server.state = {
        running: false,
        permissions: 'admin',
        error: 'the server has no alerts API',
        securityEnabled: true
      }
      await tick(POLL_INTERVAL_MS)
      expect(screen.getByRole('alert').textContent).toMatch(/could not start/i)
      expect(listShown()).toBe(false)
    })
  })

  it('lists the rules with no control to clear every alert or pause evaluation', async () => {
    await renderShell({ state: running, rules: [rule, hours] })
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /evaluation/i })).toBeNull()
    expect(screen.queryByText(/evaluation is off/i)).toBeNull()
  })
})
