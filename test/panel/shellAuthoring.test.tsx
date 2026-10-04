// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from '../../src/model/rule'
import {
  SessionExpiredError,
  type PanelApi,
  type ListedRule,
  type PluginState
} from '../../src/panel/api'
import type { PathSource } from '../../src/panel/paths/selfPaths'
import { Shell } from '../../src/panel/Shell'
import { displayUnit } from '../../src/panel/units'
import { invalidEntry, noControls, noTemplates, ruleEntry } from './fixtures'

const EXAMPLES = join(import.meta.dirname, '../../examples/rules')
const stored = JSON.parse(readFileSync(join(EXAMPLES, 'house-battery-low.json'), 'utf8')) as Rule

const running: PluginState = { running: true, permissions: 'admin', securityEnabled: true }
const battery = ruleEntry({ slug: stored.slug, rule: { name: stored.name } })

const paths: PathSource = {
  selfPaths: () =>
    Promise.resolve([
      {
        path: 'electrical.batteries.house.voltage',
        displayName: 'House battery voltage',
        units: 'V',
        unit: displayUnit({ units: 'V' }),
        value: 13.3
      },
      {
        path: 'electrical.batteries.bowThruster.voltage',
        displayName: 'Bow thruster battery voltage',
        units: 'V',
        unit: displayUnit({ units: 'V' }),
        value: 12.9
      }
    ]),
  distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
}

function mockApi(rules: ListedRule[]) {
  const server = { rules }
  const api = {
    state: vi.fn(() => Promise.resolve(running)),
    rules: vi.fn(() => Promise.resolve(server.rules)),
    resetAccumulator: vi.fn(() => Promise.reject(new Error('not expected'))),
    ruleDefinition: vi.fn((_slug: string) => Promise.resolve(stored)),
    createRule: vi.fn((rule: Rule) => {
      const entry = ruleEntry({ slug: rule.slug, rule: { name: rule.name } })
      server.rules = [...server.rules, entry]
      return Promise.resolve(entry)
    }),
    updateRule: vi.fn((slug: string, _rule: Rule) => Promise.resolve(ruleEntry({ slug }))),
    previewRule: vi.fn(() =>
      Promise.resolve({
        restarts: false,
        changes: [],
        activeAlerts: 0,
        clearsActiveAlert: false,
        discardsTotal: false
      })
    ),
    ...noControls,
    ...noTemplates
  } satisfies PanelApi
  return api
}

function renderShell(rules: ListedRule[]) {
  const api = mockApi(rules)
  render(<Shell api={api} paths={paths} />)
  return api
}

const change = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } })
}

/** Add rule, From a data path, the value, Below a limit: the way to the editor until templates land. */
async function openNewRule() {
  fireEvent.click(await screen.findByRole('link', { name: 'Add rule' }))
  fireEvent.click(await screen.findByRole('link', { name: /From a data path/ }))
  change(
    await screen.findByRole('searchbox', { name: 'Search by name or path' }),
    'bow thruster volt'
  )
  fireEvent.click(await screen.findByRole('link', { name: /Bow thruster battery voltage/ }))
  fireEvent.click(await screen.findByRole('radio', { name: /Below a limit/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('form', { name: 'New rule' })
}

/** Fills the new rule with a warning below 11.8 V, named Thruster battery low. */
function fillLow() {
  change(screen.getByRole('combobox', { name: 'Priority for step 1' }), 'warning')
  change(screen.getByRole('textbox', { name: 'Limit for step 1' }), '11.8')
  change(screen.getByRole('textbox', { name: /^Name/ }), 'Thruster battery low')
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Shell rule authoring', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('creates a rule from a path and opens it once saved', async () => {
    const api = renderShell([battery])
    await openNewRule()
    fillLow()
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByRole('heading', { name: 'Thruster battery low' })).toBeTruthy()
    expect(window.location.hash).toBe('#rule=thruster-battery-low')
    expect(api.createRule).toHaveBeenCalledWith({
      name: 'Thruster battery low',
      slug: 'thruster-battery-low',
      message: 'Bow thruster battery voltage below 11.8 V: {value}',
      signal: { path: 'electrical.batteries.bowThruster.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 11.8, priority: 'warning' }]
      }
    })
  })

  it('goes back from the editor to the kinds, and from there to the search', async () => {
    renderShell([battery])
    await openNewRule()
    fireEvent.click(screen.getByRole('link', { name: 'What should alert?' }))
    expect(await screen.findByRole('heading', { name: 'What should alert?' })).toBeTruthy()
    // The picker reads the units again when it remounts, so the lead follows
    // the heading by a render.
    expect(await screen.findByText(/Bow thruster battery voltage, now/)).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Which value?' }))
    expect(await screen.findByRole('heading', { name: 'Which value?' })).toBeTruthy()
  })

  it('edits a rule from its detail, reading the whole stored rule', async () => {
    window.history.replaceState(null, '', '/#rule=house-battery-low')
    const api = renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByRole('form', { name: /edit/i })
    expect(api.ruleDefinition).toHaveBeenCalledWith('house-battery-low')
    expect(screen.getByRole('textbox', { name: 'Clear margin' })).toHaveProperty('value', '0.2')
    change(screen.getByRole('textbox', { name: /^Message/ }), 'Battery low')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.updateRule).toHaveBeenCalled()
    })
    expect(api.updateRule.mock.calls[0]?.[1]).toEqual({ ...stored, message: 'Battery low' })
  })

  it('shows a saved rule before the refreshed list has it', async () => {
    const api = renderShell([battery])
    // The list read after the save predates the new rule.
    api.createRule.mockImplementationOnce((rule: Rule) =>
      Promise.resolve(ruleEntry({ slug: rule.slug, rule: { name: rule.name } }))
    )
    await openNewRule()
    fillLow()
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByRole('heading', { name: 'Thruster battery low' })).toBeTruthy()
    await waitFor(() => {
      expect(api.rules).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByRole('heading', { name: 'Thruster battery low' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Rule not found' })).toBeNull()
  })

  it('says when an edited rule cannot be read, and goes back to it', async () => {
    window.history.replaceState(null, '', '/#rule=house-battery-low')
    const api = renderShell([battery])
    api.ruleDefinition.mockRejectedValueOnce(new Error('/rules/house-battery-low answered 500'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The rule could not be read: /rules/house-battery-low answered 500'
    )
    expect(screen.queryByRole('form')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  /** A hash change from outside the editor, as the browser's Back makes one. */
  const navigateAway = (hash: string) => {
    act(() => {
      window.history.pushState(null, '', hash)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
  }
  const discardPrompt = () => screen.getByRole('alertdialog', { name: 'Discard your changes?' })

  it('asks before a hash change from outside drops unsaved changes, following it on Discard', async () => {
    renderShell([battery])
    await openNewRule()
    fillLow()
    navigateAway('#rule=house-battery-low')
    expect(discardPrompt()).toBeTruthy()
    expect(screen.getByRole('form', { name: 'New rule' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByRole('heading', { name: 'House battery low' })).toBeTruthy()
    expect(window.location.hash).toBe('#rule=house-battery-low')
  })

  it('restores the editor and its changes when the operator keeps editing', async () => {
    renderShell([battery])
    await openNewRule()
    fillLow()
    const editorHash = window.location.hash
    navigateAway('#rule=house-battery-low')
    fireEvent.click(within(discardPrompt()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(window.location.hash).toBe(editorHash)
    expect(screen.getByRole('textbox', { name: 'Limit for step 1' })).toHaveProperty(
      'value',
      '11.8'
    )
  })

  it('follows a hash change from outside at once when there are no changes', async () => {
    renderShell([battery])
    await openNewRule()
    navigateAway('#rule=house-battery-low')
    expect(await screen.findByRole('heading', { name: 'House battery low' })).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it("asks before a link outside the panel, such as the admin UI's menu, leaves unsaved changes", async () => {
    const menu = document.body.appendChild(document.createElement('a'))
    menu.href = '#/dashboard'
    menu.textContent = 'Dashboard'
    try {
      renderShell([battery])
      await openNewRule()
      fillLow()
      fireEvent.click(menu)
      expect(window.location.hash).not.toBe('#/dashboard')
      fireEvent.click(within(discardPrompt()).getByRole('button', { name: 'Discard changes' }))
      await waitFor(() => {
        expect(window.location.hash).toBe('#/dashboard')
      })
    } finally {
      menu.remove()
    }
  })

  it('moves focus to the form heading when it opens, and back to the list when it closes', async () => {
    renderShell([battery])
    await openNewRule()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'New rule' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alert rules' }))
    })
  })

  it('moves focus to the form heading once an edited rule has loaded', async () => {
    window.history.replaceState(null, '', '/#rule=house-battery-low')
    renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const heading = await screen.findByRole('heading', { name: /^edit/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(heading)
    })
  })

  it('keeps what was typed when a probe finds the session expired', async () => {
    const api = renderShell([battery])
    await openNewRule()
    change(screen.getByRole('textbox', { name: /^Name/ }), 'Typed')
    api.state.mockRejectedValue(new SessionExpiredError())
    // A tablet waking from sleep probes at once.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect((await screen.findByText(/your login has expired/i)).textContent).toMatch(
      /showing states from/i
    )
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveProperty('value', 'Typed')
  })

  // Signal K refuses an expired login and a level too low alike with 401.
  it('says a refused save needs an administrator while the login still reads the state', async () => {
    const api = renderShell([battery])
    await openNewRule()
    fillLow()
    api.createRule.mockRejectedValueOnce(new SessionExpiredError())
    // The level was lowered meanwhile.
    api.state.mockResolvedValue({ ...running, permissions: 'readwrite' })
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByText(/needs an administrator/i)).toBeTruthy()
    expect(screen.queryByText(/expired/i)).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('says a refused save is an expired login when the state is refused too, keeping the form', async () => {
    const api = renderShell([battery])
    await openNewRule()
    fillLow()
    api.createRule.mockRejectedValueOnce(new SessionExpiredError())
    api.state.mockRejectedValue(new SessionExpiredError())
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(
        screen.getAllByRole('alert').some((a) => /your login has expired/i.test(a.textContent))
      ).toBe(true)
    })
    expect(screen.queryByText(/administrator/i)).toBeNull()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveProperty(
      'value',
      'Thruster battery low'
    )
  })

  it('opens the path search from the empty rule list', async () => {
    renderShell([])
    fireEvent.click(await screen.findByRole('link', { name: 'Start from a data path' }))
    expect(await screen.findByRole('heading', { name: 'Which value?' })).toBeTruthy()
  })

  it('fixes an invalid stored rule in the editor', async () => {
    window.history.replaceState(null, '', '/#rule=house-battery-low')
    const body = { ...stored, detector: { ...stored.detector, duration: -5 } }
    const api = renderShell([
      invalidEntry({
        slug: stored.slug,
        name: stored.name,
        invalid: { body, errors: [{ path: '/detector/duration', message: 'must be at least 0' }] }
      })
    ])
    fireEvent.click(await screen.findByRole('link', { name: 'Fix in the editor' }))
    expect(await screen.findByRole('heading', { name: 'Fix “House battery low”' })).toBeTruthy()
    change(screen.getByRole('textbox', { name: 'For at least' }), '1')
    change(screen.getByRole('combobox', { name: 'For at least unit' }), 'min')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.updateRule).toHaveBeenCalledWith(stored.slug, stored)
    })
  })
})
