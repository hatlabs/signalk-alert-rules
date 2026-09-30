// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from '../../src/model/rule'
import {
  SessionExpiredError,
  type PanelApi,
  type PluginState,
  type RuleEntry
} from '../../src/panel/api'
import type { PathSource } from '../../src/panel/paths/selfPaths'
import { Shell } from '../../src/panel/Shell'
import { displayUnit } from '../../src/panel/units'
import { ruleEntry } from './fixtures'

const EXAMPLES = join(import.meta.dirname, '../../examples/rules')
const stored = JSON.parse(readFileSync(join(EXAMPLES, 'house-battery-low.json'), 'utf8')) as Rule

const running: PluginState = { running: true, securityEnabled: true }
const battery = ruleEntry({ slug: stored.slug, rule: { name: stored.name } })
const fromRuleset = ruleEntry({ origin: 'engine-pack', slug: 'engine-hours' })

const paths: PathSource = {
  selfPaths: () =>
    Promise.resolve([
      {
        path: 'electrical.batteries.house.voltage',
        units: 'V',
        unit: displayUnit({ units: 'V' })
      }
    ]),
  distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
}

function mockApi(rules: RuleEntry[]) {
  const server = { rules }
  const api = {
    state: vi.fn(() => Promise.resolve(running)),
    pluginEnabled: vi.fn(() => Promise.resolve(true)),
    rules: vi.fn(() => Promise.resolve(server.rules)),
    resetAccumulator: vi.fn(() => Promise.reject(new Error('not expected'))),
    setEvaluation: vi.fn((enabled: boolean) => Promise.resolve({ enabled })),
    ruleDefinition: vi.fn((_origin: string, _slug: string) => Promise.resolve(stored)),
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
    )
  } satisfies PanelApi
  return api
}

function renderShell(rules: RuleEntry[]) {
  const api = mockApi(rules)
  render(<Shell api={api} paths={paths} />)
  return api
}

const change = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Shell rule authoring', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('creates a rule from New rule and opens it once saved', async () => {
    const api = renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }))
    const form = await screen.findByRole('form', { name: 'New rule' })
    change(within(form).getByRole('combobox', { name: 'Input path' }), 'navigation.state')
    fireEvent.click(screen.getByRole('radio', { name: /a value or state/i }))
    change(screen.getByRole('combobox', { name: 'The input' }), 'changesTo')
    change(screen.getByRole('combobox', { name: 'Value type' }), 'text')
    change(screen.getByRole('textbox', { name: 'Value' }), 'aground')
    change(screen.getByRole('combobox', { name: 'Priority' }), 'alarm')
    change(screen.getByRole('textbox', { name: 'Message' }), 'Aground')
    change(screen.getByRole('textbox', { name: 'Name' }), 'Aground')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByRole('heading', { name: 'Aground' })).toBeTruthy()
    expect(window.location.hash).toBe('#rule=user/aground')
    expect(api.createRule).toHaveBeenCalledWith({
      name: 'Aground',
      slug: 'aground',
      message: 'Aground',
      priority: 'alarm',
      signal: { path: 'navigation.state' },
      detector: { type: 'match', op: 'changesTo', value: 'aground' }
    })
  })

  it('edits a user rule from its detail, reading the whole stored rule', async () => {
    window.history.replaceState(null, '', '/#rule=user/house-battery-low')
    const api = renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByRole('form', { name: /edit/i })
    expect(api.ruleDefinition).toHaveBeenCalledWith('user', 'house-battery-low')
    expect(screen.getByRole('textbox', { name: 'Hysteresis' })).toHaveProperty('value', '0.2')
    change(screen.getByRole('textbox', { name: 'Message' }), 'Battery low')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }))
    change(await screen.findByRole('combobox', { name: 'Input path' }), 'navigation.state')
    fireEvent.click(screen.getByRole('radio', { name: /a value or state/i }))
    change(screen.getByRole('combobox', { name: 'The input' }), 'changesTo')
    change(screen.getByRole('combobox', { name: 'Value type' }), 'text')
    change(screen.getByRole('textbox', { name: 'Value' }), 'aground')
    change(screen.getByRole('combobox', { name: 'Priority' }), 'alarm')
    change(screen.getByRole('textbox', { name: 'Message' }), 'Aground')
    change(screen.getByRole('textbox', { name: 'Name' }), 'Aground')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByRole('heading', { name: 'Aground' })).toBeTruthy()
    await waitFor(() => {
      expect(api.rules).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByRole('heading', { name: 'Aground' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Rule not found' })).toBeNull()
  })

  it('says when an edited rule cannot be read, and goes back to it', async () => {
    window.history.replaceState(null, '', '/#rule=user/house-battery-low')
    const api = renderShell([battery])
    api.ruleDefinition.mockRejectedValueOnce(
      new Error('/rules/user/house-battery-low answered 500')
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The rule could not be read: /rules/user/house-battery-low answered 500'
    )
    expect(screen.queryByRole('form')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('does not offer to edit a ruleset rule', async () => {
    window.history.replaceState(null, '', '/#rule=engine-pack/engine-hours')
    renderShell([fromRuleset])
    const edit = await screen.findByRole('button', { name: 'Edit' })
    expect((edit as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks before a tab switch drops unsaved changes', async () => {
    renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }))
    change(await screen.findByRole('combobox', { name: 'Input path' }), 'a.b')
    fireEvent.click(screen.getByRole('tab', { name: 'Suppressions' }))
    const dialog = screen.getByRole('alertdialog', { name: /leave the rule form/i })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('form', { name: 'New rule' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Suppressions' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' })
    )
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Suppressions' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    })
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('moves focus to the form heading when it opens, and back to the list when it closes', async () => {
    renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }))
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'New rule' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'All rules' }))
    })
  })

  it('moves focus to the form heading once an edited rule has loaded', async () => {
    window.history.replaceState(null, '', '/#rule=user/house-battery-low')
    renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const heading = await screen.findByRole('heading', { name: /^edit/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(heading)
    })
  })

  it('keeps what was typed when a probe finds the session expired', async () => {
    const api = renderShell([battery])
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }))
    change(await screen.findByRole('combobox', { name: 'Input path' }), 'a.b')
    api.state.mockRejectedValue(new SessionExpiredError())
    // A tablet waking from sleep probes at once.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect((await screen.findByText(/your session has expired/i)).textContent).toMatch(/last read/)
    expect(screen.getByRole('combobox', { name: 'Input path' })).toHaveProperty('value', 'a.b')
  })

  it('opens the form from the empty rule list', async () => {
    renderShell([])
    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }))
    expect(await screen.findByRole('form', { name: 'New rule' })).toBeTruthy()
  })
})
