// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ruleAlertPath } from '../../../src/model/alertPath'
import type { Rule } from '../../../src/model/rule'
import type { Template } from '../../../src/model/template'
import { validateRule } from '../../../src/model/validate'
import {
  RuleRejectedError,
  type ListedRule,
  type PanelApi,
  type PluginState,
  type RuleEntry,
  type TemplateListing
} from '../../../src/panel/api'
import type {
  HistoryPoint,
  HistoryQuery,
  HistorySource
} from '../../../src/panel/history/historySource'
import type { PathEntry, PathSource } from '../../../src/panel/paths/selfPaths'
import { hashWithRoute } from '../../../src/panel/route'
import { Shell } from '../../../src/panel/Shell'
import { displayUnit } from '../../../src/panel/units'
import { BUILTIN_TEMPLATES, discoverTemplateSets } from '../../../src/templates/discovery'
import {
  shownDescription,
  stepsSummary,
  SUMMARY_CLEARING,
  summaryLaidOut
} from '../editor/editorFixtures'
import { noControls, onceShown, ruleEntry } from '../fixtures'

const LIFEPO4 = 'battery-voltage-low-lifepo4'
const volts = displayUnit({ units: 'V', displayUnits: { formula: 'value * 1', symbol: 'V' } })
const voltage = (instance: string, value: number): PathEntry => ({
  path: `electrical.batteries.${instance}.voltage`,
  units: 'V',
  unit: volts,
  value
})

/** A house bank, a starter battery and two Ruuvitags whose coin cells report as batteries. */
const boat: PathEntry[] = [
  voltage('house', 13.28),
  { path: 'electrical.batteries.house.name', unit: displayUnit({}), value: 'House bank' },
  voltage('starter', 12.71),
  voltage('ruuvi-saloon', 3.01),
  voltage('ruuvi-cockpit', 2.98)
]

const pathsOf = (reported: PathEntry[]): PathSource => ({
  selfPaths: () => Promise.resolve(reported),
  distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
})

/** The built-in set as GET /templates lists it before anyone dismissed its notice. */
function builtinListing(): TemplateListing {
  const { sets } = discoverTemplateSets({ builtin: BUILTIN_TEMPLATES })
  return {
    sets: sets.map(({ source, set }) => ({
      id: set.id,
      name: set.name,
      version: set.version,
      source,
      templates: set.templates,
      new: set.templates.map((t) => t.id)
    })),
    problems: []
  }
}

interface Server {
  rules: ListedRule[]
  listing: TemplateListing
  /** Refuses a create, as the server would, when it answers something. */
  refuse?: (rule: Rule) => Error | undefined
}

/** A server whose rules and dismissed templates every Shell rendered on it shares. */
function serverApi(server: Server, permissions: PluginState['permissions'] = 'admin') {
  const state: PluginState = { running: true, permissions, securityEnabled: true }
  return {
    state: vi.fn(() => Promise.resolve(state)),
    rules: vi.fn(() => Promise.resolve(server.rules)),
    resetAccumulator: vi.fn(() => Promise.reject(new Error('not expected'))),
    ruleDefinition: vi.fn(() => Promise.reject(new Error('not expected'))),
    createRule: vi.fn((rule: Rule) => {
      const valid = validateRule(rule)
      if (!valid.ok) return Promise.reject(new RuleRejectedError('invalid', valid.errors))
      const refused = server.refuse?.(rule)
      if (refused !== undefined) return Promise.reject(refused)
      const entry: RuleEntry = ruleEntry({
        slug: rule.slug,
        rule: {
          name: rule.name,
          signal: { paths: 'path' in rule.signal ? [rule.signal.path] : [] },
          ...(rule.template === undefined
            ? {}
            : {
                template: { set: rule.template.set, id: rule.template.id, pick: rule.template.pick }
              })
        }
      })
      server.rules = [...server.rules, entry]
      return Promise.resolve(entry)
    }),
    updateRule: vi.fn(() => Promise.reject(new Error('not expected'))),
    previewRule: vi.fn(() => Promise.reject(new Error('not expected'))),
    ...noControls,
    templates: vi.fn(() => Promise.resolve(server.listing)),
    dismissTemplates: vi.fn((shown: Record<string, string[]>) => {
      server.listing = {
        ...server.listing,
        sets: server.listing.sets.map((s) => ({
          ...s,
          new: s.new.filter((id) => !(shown[s.id] ?? []).includes(id))
        }))
      }
      return Promise.resolve(server.listing)
    })
  } satisfies PanelApi
}

function renderShell(
  server: Server,
  {
    reported = boat,
    permissions = 'admin',
    history
  }: {
    reported?: PathEntry[]
    permissions?: PluginState['permissions']
    history?: HistorySource
  } = {}
) {
  const api = serverApi(server, permissions)
  render(<Shell api={api} paths={pathsOf(reported)} history={history} />)
  return api
}

const fresh = (rules: ListedRule[] = []): Server => ({ rules, listing: builtinListing() })

const change = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } })
}

/** Add rule, the built-in set, the LiFePO4 low voltage template: the picker. */
async function openLifepo4() {
  window.history.replaceState(null, '', '/#add')
  // A cold role query's first poll can outlast the wait under load; the set's name is cheap text.
  await screen.findByText('Built in')
  fireEvent.click(screen.getByRole('link', { name: /^Built in/ }))
  fireEvent.click(await screen.findByRole('link', { name: /^Battery voltage low \(LiFePO4\)/ }))
  await screen.findByRole('heading', { name: 'Battery voltage low (LiFePO4)' })
  await screen.findByRole('list', { name: 'Picks' })
}

const pick = (name: RegExp) => {
  fireEvent.click(screen.getByRole('checkbox', { name }))
}

async function continueWith(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  await screen.findByRole('textbox', { name: /^Name/ })
}

const limit = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Limit for step 1' })
const tab = (name: RegExp) => screen.getByRole('tab', { name })

/** The rules the server was asked to create, in order. */
const createdRules = (api: ReturnType<typeof serverApi>): Rule[] =>
  api.createRule.mock.calls.map(([rule]) => rule)

const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

describe('Add rule from a template', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('offers each set with its new templates counted', async () => {
    window.history.replaceState(null, '', '/#add')
    renderShell(fresh())
    const count = String(builtinListing().sets[0]?.templates.length)
    // Polling by role computes every accessible name on each render, cold in
    // a file's first test; under load that alone outlasts the wait. The chip
    // renders with the link, and a text query is cheap.
    await screen.findByText(`${count} new`)
    const set = screen.getByRole('link', { name: /^Built in/ })
    expect(set.textContent).toContain(`${count} templates: Battery charge low (lead-acid)`)
    expect(within(set).getByText(`${count} new`)).toBeTruthy()
  })

  it('lists every battery with its voltage; the house bank alone makes one rule, reading no coin cell', async () => {
    const api = renderShell(fresh())
    await openLifepo4()
    const rows = within(screen.getByRole('list', { name: 'Picks' })).getAllByRole('checkbox')
    expect(rows.map((r) => r.closest('label')?.textContent)).toEqual([
      'House bankelectrical.batteries.house.voltage13.28 V',
      'ruuvi-cockpitelectrical.batteries.ruuvi-cockpit.voltage2.98 V',
      'ruuvi-saloonelectrical.batteries.ruuvi-saloon.voltage3.01 V',
      'starterelectrical.batteries.starter.voltage12.71 V'
    ])
    pick(/^House bank/)
    await continueWith('Continue with 1 rule')
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(api.createRule).toHaveBeenCalledTimes(1)
    })
    const [rule] = createdRules(api)
    expect(rule).toMatchObject({
      slug: 'battery-voltage-low-lifepo4-house',
      condition: 'voltageLow',
      signal: { path: 'electrical.batteries.house.voltage' },
      detector: {
        steps: [
          { limit: 12.8, priority: 'warning' },
          { limit: 12, priority: 'alarm' }
        ]
      },
      template: { set: 'builtin', id: LIFEPO4, pick: { instance: 'house' } }
    })
    expect(JSON.stringify(createdRules(api))).not.toContain('ruuvi')
    expect(
      await screen.findByRole('heading', { name: 'Battery house voltage low (LiFePO4)' })
    ).toBeTruthy()
  })

  it('edits two picks in two tabs and creates both with one save', async () => {
    const api = renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    expect(
      screen.getByRole('heading', { name: '2 new rules from “Battery voltage low (LiFePO4)”' })
    ).toBeTruthy()
    fireEvent.click(tab(/starter/))
    change(limit(), '12.4')
    fireEvent.click(tab(/House bank/))
    expect(limit().value).toBe('12.8')
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    expect(await screen.findByRole('heading', { name: 'Alert rules' })).toBeTruthy()
    expect(createdRules(api).map((r) => [r.signal, r.detector.steps?.[0]])).toEqual([
      [{ path: 'electrical.batteries.house.voltage' }, { limit: 12.8, priority: 'warning' }],
      [{ path: 'electrical.batteries.starter.voltage' }, { limit: 12.4, priority: 'warning' }]
    ])
  })

  it('keeps focus on a tab an arrow key moved to as the tabs appear', async () => {
    renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    const pressed = onceShown(
      () => screen.queryAllByRole('tab').at(0),
      (first) => {
        first.focus()
        fireEvent.keyDown(first, { key: 'ArrowRight' })
      }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 2 rules' }))
    await pressed
    await waitFor(() => {
      expect(tab(/starter/).getAttribute('aria-selected')).toBe('true')
    })
    expect(document.activeElement).toBe(tab(/starter/))
  })

  it('moves between the tabs with the arrow keys, Home and End, one tab in the tab order', async () => {
    renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    pick(/^ruuvi-cockpit/)
    await continueWith('Continue with 3 rules')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1])
    const press = (key: string) => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key })
    }
    tabs[0]?.focus()
    press('ArrowRight')
    expect(document.activeElement).toBe(tab(/ruuvi-cockpit/))
    expect(tab(/ruuvi-cockpit/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([-1, 0, -1])
    press('End')
    expect(document.activeElement).toBe(tab(/starter/))
    press('ArrowRight')
    expect(document.activeElement).toBe(tab(/House bank/))
    press('ArrowLeft')
    expect(document.activeElement).toBe(tab(/starter/))
    press('Home')
    expect(document.activeElement).toBe(tab(/House bank/))
    expect(tab(/House bank/).getAttribute('aria-selected')).toBe('true')
  })

  it('says when every rule has its required fields', async () => {
    renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    expect(screen.getByText('Both rules have every required field.')).toBeTruthy()
    change(limit(), '')
    expect(screen.queryByText('Both rules have every required field.')).toBeNull()
    change(limit(), '12.8')
    fireEvent.click(screen.getByRole('link', { name: 'Choose what it watches' }))
    await screen.findByRole('list', { name: 'Picks' })
    pick(/^ruuvi-cockpit/)
    await continueWith('Continue with 3 rules')
    expect(screen.getByText('All 3 rules have every required field.')).toBeTruthy()
  })

  it('creates a tab whose message is cleared with the message written from its rule', async () => {
    const api = renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    fireEvent.click(tab(/starter/))
    const message = screen.getByRole<HTMLInputElement>('textbox', { name: /^Message/ })
    change(message, '')
    const written = message.placeholder
    expect(written).toMatch(/^Starter .*: \{value\}$/)
    expect(screen.getByText('Both rules have every required field.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    expect(await screen.findByRole('heading', { name: 'Alert rules' })).toBeTruthy()
    expect(
      createdRules(api)
        .map((r) => r.message)
        .at(1)
    ).toBe(written)
  })

  it('charts the shown tab’s battery beside its form, with both steps’ limits', async () => {
    const day: HistoryPoint[] = Array.from({ length: 144 }, (_, i) => ({
      time: Date.now() - 86_400_000 + i * 600_000,
      value: 13.3
    }))
    const history = {
      hasProvider: vi.fn(() => Promise.resolve(true)),
      values: vi.fn((q: HistoryQuery) =>
        Promise.resolve(Object.fromEntries(q.methods.map((method) => [method, day])))
      )
    } satisfies HistorySource
    renderShell(fresh(), { history })
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    const chart = await screen.findByRole('img', { name: 'Last 24 hours with the limits' })
    expect(chart.textContent).toContain('warning 12.8 V')
    expect(chart.textContent).toContain('alarm 12 V')
    expect(history.values).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: 'electrical.batteries.house.voltage', methods: ['min'] })
    )
    fireEvent.click(tab(/starter/))
    await waitFor(() => {
      expect(history.values).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: 'electrical.batteries.starter.voltage' })
      )
    })
  })

  it('copies the shown tab’s settings to the others, keeping their names and values', async () => {
    const api = renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    change(limit(), '12.6')
    change(screen.getByRole('combobox', { name: 'Priority for step 1' }), 'caution')
    fireEvent.click(screen.getByRole('button', { name: 'Copy these settings to starter' }))
    expect(screen.getByText(/Copied to starter\./)).toBeTruthy()
    fireEvent.click(tab(/starter/))
    expect(limit().value).toBe('12.6')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^Name/ }).value).toBe(
      'Battery starter voltage low (LiFePO4)'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(createdRules(api).map((r) => [r.signal, r.detector.steps?.[0]?.priority])).toEqual([
      [{ path: 'electrical.batteries.house.voltage' }, 'caution'],
      [{ path: 'electrical.batteries.starter.voltage' }, 'caution']
    ])
  })

  it('saves nothing while a tab misses a field, shows that tab, and keeps every edit', async () => {
    const api = renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    pick(/^ruuvi-cockpit/)
    await continueWith('Continue with 3 rules')
    change(limit(), '12.9')
    fireEvent.click(tab(/starter/))
    change(limit(), '')
    fireEvent.click(tab(/House bank/))
    fireEvent.click(screen.getByRole('button', { name: 'Create 3 rules' }))
    expect(await screen.findByText('Fill in step 1 on starter to save.')).toBeTruthy()
    expect(tab(/starter/).getAttribute('aria-selected')).toBe('true')
    expect(tab(/starter/).textContent).toContain('needs fixing')
    expect(scrollIntoView.mock.contexts).toContain(tab(/starter/))
    await waitFor(() => {
      expect(document.activeElement).toBe(limit())
    })
    expect(api.createRule).not.toHaveBeenCalled()
    fireEvent.click(tab(/House bank/))
    expect(limit().value).toBe('12.9')
  })

  describe('a tab’s path changed to one shown in another unit', () => {
    /** Opens the house bank's rule and settles its path on one the server does not report, in SI. */
    async function houseOnUnreportedPath(before?: () => void) {
      const api = renderShell(fresh())
      await openLifepo4()
      pick(/^House bank/)
      await continueWith('Continue with 1 rule')
      before?.()
      fireEvent.click(screen.getByRole('button', { name: 'Change the value to watch' }))
      const search = screen.getByRole('combobox', { name: 'Search by name or path' })
      change(search, 'electrical.batteries.house.current')
      fireEvent.blur(search)
      return api
    }
    const margin = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Hysteresis' })
    const footer = () => document.querySelector('.skar-editor-status')?.textContent ?? ''
    /** Settles the shown tab's path on one in another unit, as leaving the search does. */
    const changeShownPath = (path: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Change the value to watch' }))
      const search = screen.getByRole('combobox', { name: 'Search by name or path' })
      change(search, path)
      fireEvent.blur(search)
    }
    const fillLimits = () => {
      change(limit(), '5')
      change(screen.getByRole('textbox', { name: 'Limit for step 2' }), '4')
    }
    const describedBy = (element: HTMLElement) =>
      (element.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')

    it('keeps the steps summary’s height while the emptied limits’ errors are withheld, until Create', async () => {
      const api = await houseOnUnreportedPath(() => {
        summaryLaidOut()
        expect(stepsSummary().textContent).toContain('It ends')
        expect(stepsSummary().style.minHeight).toBe('')
      })
      expect(stepsSummary().textContent).toContain('…')
      expect(stepsSummary().textContent).not.toContain('It ends')
      expect(stepsSummary().style.minHeight).toBe(`${String(SUMMARY_CLEARING)}px`)
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(api.createRule).not.toHaveBeenCalled()
      expect(stepsSummary().style.minHeight).toBe('')
    })

    it('holds the steps summary’s height after the limits are typed again, until Create', async () => {
      await houseOnUnreportedPath(summaryLaidOut)
      fillLimits()
      expect(stepsSummary().textContent).not.toContain('…')
      // The emptied limits' errors stay withheld until Create, typed again or not.
      expect(stepsSummary().style.minHeight).toBe(`${String(SUMMARY_CLEARING)}px`)
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(stepsSummary().style.minHeight).toBe('')
    })

    it('empties a limit typed for the old path, asking for it, and creates nothing', async () => {
      const api = await houseOnUnreportedPath(() => {
        change(limit(), '12.9')
      })
      expect(limit().value).toBe('')
      expect(limit().getAttribute('aria-invalid')).toBe('true')
      expect(describedBy(limit())).toMatch(/fill in the limit/i)
      expect(shownDescription(limit())).not.toMatch(/fill in the limit/i)
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(api.createRule).not.toHaveBeenCalled()
      expect(limit().value).toBe('')
      expect(shownDescription(limit())).toMatch(/fill in the limit/i)
    })

    it('keeps the emptied hysteresis’s note through Create, until the rule is created without it', async () => {
      const api = await houseOnUnreportedPath()
      expect(margin().value).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(api.createRule).not.toHaveBeenCalled()
      expect(shownDescription(margin())).toContain(
        'must be typed again in the unit of the chosen path'
      )
      expect(footer()).toBe(
        'Fill in step 1 and step 2 on House bank to save. The hysteresis on House bank was emptied: type it again or leave it empty.'
      )
      change(limit(), '5')
      change(screen.getByRole('textbox', { name: 'Limit for step 2' }), '4')
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      await waitFor(() => {
        expect(api.createRule).toHaveBeenCalledOnce()
      })
      const [rule] = createdRules(api)
      expect(rule.signal).toEqual({ path: 'electrical.batteries.house.current' })
      expect(rule.detector.type === 'sustained' && rule.detector.hysteresis).toBeUndefined()
    })

    it('keeps More options collapsed over a shown error when a commit changes the errors, until Create', async () => {
      renderShell(fresh())
      await openLifepo4()
      pick(/^House bank/)
      await continueWith('Continue with 1 rule')
      const more = () => screen.getByText('More options').closest('details')
      change(margin(), 'abc')
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(more()?.open).toBe(true)
      expect(shownDescription(margin())).not.toBe('')
      fireEvent.click(screen.getByText('More options'))
      // A details element tells of its toggle in a task of its own.
      await waitFor(() => {
        expect(more()?.open).toBe(false)
      })
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      changeShownPath('electrical.batteries.house.current')
      expect(shownDescription(margin())).toContain(
        'must be typed again in the unit of the chosen path'
      )
      expect(more()?.open).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(more()?.open).toBe(true)
    })

    it('withholds the emptied hysteresis’s note until Create', async () => {
      await houseOnUnreportedPath()
      expect(margin().getAttribute('aria-invalid')).toBe('true')
      expect(describedBy(margin())).toContain('must be typed again in the unit of the chosen path')
      expect(shownDescription(margin())).not.toContain(
        'must be typed again in the unit of the chosen path'
      )
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      expect(shownDescription(margin())).toContain(
        'must be typed again in the unit of the chosen path'
      )
    })

    it('marks a tab as needing fixing at Create, not at the commit that empties its numbers', async () => {
      renderShell(fresh())
      await openLifepo4()
      pick(/^House bank/)
      pick(/^starter/)
      await continueWith('Continue with 2 rules')
      changeShownPath('electrical.batteries.house.current')
      expect(tab(/House bank/).textContent).not.toContain('needs fixing')
      fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
      expect(tab(/House bank/).textContent).toContain('needs fixing')
    })

    it('shows a later tab’s emptied hysteresis note when the server refuses that tab', async () => {
      const server = fresh()
      server.refuse = (rule) =>
        rule.slug.endsWith('starter')
          ? new RuleRejectedError('invalid', [{ path: '/name', message: 'is taken' }])
          : undefined
      renderShell(server)
      await openLifepo4()
      pick(/^House bank/)
      pick(/^starter/)
      await continueWith('Continue with 2 rules')
      fireEvent.click(tab(/starter/))
      changeShownPath('electrical.batteries.starter.current')
      fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
      fillLimits()
      fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
      expect(await screen.findByText(/Created 1 rule/)).toBeTruthy()
      expect(shownDescription(margin())).toContain(
        'must be typed again in the unit of the chosen path'
      )
    })

    it('names every tab’s emptied hysteresis at the Create that stops for the limits, then creates both', async () => {
      const api = renderShell(fresh())
      await openLifepo4()
      pick(/^House bank/)
      pick(/^starter/)
      await continueWith('Continue with 2 rules')
      changeShownPath('electrical.batteries.house.current')
      fireEvent.click(tab(/starter/))
      changeShownPath('electrical.batteries.starter.current')
      fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
      expect(api.createRule).not.toHaveBeenCalled()
      expect(footer()).toBe(
        'Fill in step 1 and step 2 on House bank and fill in step 1 and step 2 on starter to save. The hysteresis on House bank and the hysteresis on starter were emptied: type them again or leave them empty.'
      )
      fireEvent.click(tab(/House bank/))
      fillLimits()
      fireEvent.click(tab(/starter/))
      fillLimits()
      fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
      await waitFor(() => {
        expect(api.createRule).toHaveBeenCalledTimes(2)
      })
      for (const rule of createdRules(api)) {
        expect(rule.detector.type === 'sustained' && rule.detector.hysteresis).toBeUndefined()
      }
    })

    describe('an earlier condition removed', () => {
      const textbox = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name })
      const settleConditionPath = (path: string) => {
        const search = screen.getByRole('combobox', { name: 'Condition 2 input path' })
        change(search, path)
        fireEvent.blur(search)
      }
      /** Opens the house bank's rule with two conditions, the second's limit emptied for its unit. */
      async function secondConditionEmptied() {
        const api = renderShell(fresh())
        await openLifepo4()
        pick(/^House bank/)
        await continueWith('Continue with 1 rule')
        const summary = screen.getByText('More options')
        if (summary.closest('details')?.open !== true) fireEvent.click(summary)
        fireEvent.click(screen.getByRole('button', { name: 'Add a condition' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add a condition' }))
        settleConditionPath('electrical.batteries.house.voltage')
        change(textbox('Condition 2 limit'), '12')
        settleConditionPath('electrical.batteries.house.current')
        expect(textbox('Condition 2 limit').value).toBe('')
        return api
      }

      it('withholds the emptied condition limit’s text until Create', async () => {
        await secondConditionEmptied()
        const conditionLimit = () => textbox('Condition 2 limit')
        expect(conditionLimit().getAttribute('aria-invalid')).toBe('true')
        expect(describedBy(conditionLimit())).toContain('is required')
        expect(shownDescription(conditionLimit())).not.toContain('is required')
        fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
        expect(shownDescription(conditionLimit())).toContain('is required')
      })

      it('moves a later condition’s emptied limit with it', async () => {
        await secondConditionEmptied()
        fireEvent.click(screen.getByRole('button', { name: 'Remove condition 1' }))
        expect(describedBy(textbox('Condition 1 limit'))).toContain('is required')
        expect(shownDescription(textbox('Condition 1 limit'))).not.toContain('is required')
        expect(footer()).toBe('Fill in the limit of Only while condition 1 on House bank to save.')
      })
    })
  })

  it('keeps the tab the server refuses, having created the rules before it', async () => {
    const server = fresh()
    server.refuse = (rule) =>
      rule.slug.endsWith('starter')
        ? new RuleRejectedError('another rule has this alert path', [
            {
              path: '/condition',
              message:
                'makes an alert path overlapping that of rule old-starter; each rule needs its own'
            }
          ])
        : undefined
    const api = renderShell(server)
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    expect(await screen.findByText(/Created 1 rule/)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(
      screen.getByRole('heading', {
        name: '1 rule left from “Battery voltage low (LiFePO4)”: starter'
      })
    ).toBeTruthy()
    expect(screen.getByText(/Another rule uses this alert path: old-starter/)).toBeTruthy()
    server.refuse = undefined
    change(screen.getByRole('textbox', { name: /^Condition name/ }), 'starterVoltageLow')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    // Both rules are made now, so the list shows them.
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(createdRules(api).map((r) => r.slug)).toEqual([
      'battery-voltage-low-lifepo4-house',
      'battery-voltage-low-lifepo4-starter',
      'battery-voltage-low-lifepo4-starter'
    ])
  })

  it('tries the next slug when an unlisted stored rule holds the one proposed', async () => {
    const server = fresh()
    server.refuse = (rule) =>
      rule.slug === 'battery-voltage-low-lifepo4-house'
        ? Object.assign(new RuleRejectedError('a rule with this slug exists', []), {
            errors: [
              {
                path: '/slug',
                message:
                  'is taken by another rule. If an earlier attempt to create this rule timed out, it may have saved this rule: check the rule list before renaming.'
              }
            ]
          })
        : undefined
    const api = renderShell(server)
    await openLifepo4()
    pick(/^House bank/)
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await screen.findByRole('heading', { name: 'Battery house voltage low (LiFePO4)' })
    expect(createdRules(api).map((r) => r.slug)).toEqual([
      'battery-voltage-low-lifepo4-house',
      'battery-voltage-low-lifepo4-house-2'
    ])
  })

  /** The server's refusal of a slug a stored rule has. */
  const slugTaken = () =>
    new RuleRejectedError('a rule with this slug exists', [
      {
        path: '/slug',
        message:
          'is taken by another rule. If an earlier attempt to create this rule timed out, it may have saved this rule: check the rule list before renaming.'
      }
    ])

  it('keeps a slug the user typed, refusing it rather than trying another', async () => {
    const server = fresh()
    server.refuse = (rule) => (rule.slug === 'my-house' ? slugTaken() : undefined)
    const api = renderShell(server)
    await openLifepo4()
    pick(/^House bank/)
    await continueWith('Continue with 1 rule')
    change(screen.getByRole('textbox', { name: /^Slug/ }), 'my-house')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByText(/is taken by another rule/)).toBeTruthy()
    expect(createdRules(api).map((r) => r.slug)).toEqual(['my-house'])
  })

  it('stops trying slugs after a few, showing the refusal', async () => {
    const server = fresh()
    server.refuse = (rule) =>
      rule.slug.startsWith('battery-voltage-low-lifepo4-house') ? slugTaken() : undefined
    const api = renderShell(server)
    await openLifepo4()
    pick(/^House bank/)
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByText(/is taken by another rule/)).toBeTruthy()
    expect(createdRules(api).map((r) => r.slug)).toEqual([
      'battery-voltage-low-lifepo4-house',
      'battery-voltage-low-lifepo4-house-2',
      'battery-voltage-low-lifepo4-house-3',
      'battery-voltage-low-lifepo4-house-4',
      'battery-voltage-low-lifepo4-house-5'
    ])
  })

  it('tries no other slug for a rule whose earlier create got no answer, as it may have saved', async () => {
    const server = fresh()
    server.refuse = (rule) =>
      server.rules.some((r) => r.slug === rule.slug) ? slugTaken() : undefined
    const api = renderShell(server)
    const store = api.createRule.getMockImplementation()
    api.createRule.mockImplementationOnce(async (rule: Rule) => {
      await store?.(rule)
      throw new Error('The request timed out')
    })
    await openLifepo4()
    pick(/^House bank/)
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByText(/The request timed out/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    expect(await screen.findByText(/is taken by another rule/)).toBeTruthy()
    expect(createdRules(api).map((r) => r.slug)).toEqual([
      'battery-voltage-low-lifepo4-house',
      'battery-voltage-low-lifepo4-house'
    ])
  })

  it('locks the settings while Save runs, so a rule is created as shown', async () => {
    const api = renderShell(fresh())
    const store = api.createRule.getMockImplementation()
    let answer: (() => void) | undefined
    api.createRule.mockImplementationOnce(
      (rule: Rule) =>
        new Promise<RuleEntry>((resolve, reject) => {
          answer = () => {
            store?.(rule).then(resolve, reject)
          }
        })
    )
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    expect(limit().matches(':disabled')).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /^Copy these settings/ }).disabled
    ).toBe(true)
    fireEvent.click(tab(/starter/))
    expect(limit().matches(':disabled')).toBe(true)
    act(() => {
      answer?.()
    })
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(createdRules(api).map((r) => r.signal)).toEqual([
      { path: 'electrical.batteries.house.voltage' },
      { path: 'electrical.batteries.starter.voltage' }
    ])
  })

  it('marks a battery that already has a rule from the template, and still lets it be kept', async () => {
    const made = ruleEntry({
      slug: 'battery-voltage-low-lifepo4-house',
      rule: {
        name: 'House bank voltage low',
        signal: { paths: ['electrical.batteries.house.voltage'] },
        template: { set: 'builtin', id: LIFEPO4, pick: { instance: 'house' } }
      }
    })
    const api = renderShell(fresh([made]))
    await openLifepo4()
    const house = screen.getByRole('checkbox', { name: /^House bank/ })
    expect(house.closest('label')?.textContent).toContain(
      'Already has a rule from this template: House bank voltage low'
    )
    pick(/^House bank/)
    await continueWith('Continue with 1 rule')
    expect(screen.getByRole('button', { name: 'Create rule' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Create another rule for it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(api.createRule).toHaveBeenCalledTimes(1)
    })
    expect(createdRules(api)[0]?.slug).toBe('battery-voltage-low-lifepo4-house-2')
  })

  describe('opened again after a rule was created', () => {
    const houseRule = ruleEntry({
      slug: 'battery-voltage-low-lifepo4-house',
      rule: {
        name: 'Battery house voltage low (LiFePO4)',
        signal: { paths: ['electrical.batteries.house.voltage'] },
        template: { set: 'builtin', id: LIFEPO4, pick: { instance: 'house' } }
      }
    })
    const openEditLink = async () => {
      const href = hashWithRoute('', {
        kind: 'add',
        from: 'template',
        set: 'builtin',
        template: LIFEPO4,
        picks: [{ instance: 'house' }, { instance: 'starter' }],
        step: 'edit'
      })
      window.history.replaceState(null, '', `/${href}`)
      await screen.findByRole('tab', { name: /starter/ })
    }

    it('names the rule a pick already has and leaves it out of Save', async () => {
      const api = renderShell(fresh([houseRule]))
      await openEditLink()
      expect(
        screen.getByRole('heading', { name: '1 new rule from “Battery voltage low (LiFePO4)”' })
      ).toBeTruthy()
      expect(tab(/House bank/).textContent).toContain('already has a rule')
      fireEvent.click(tab(/House bank/))
      expect(
        screen.getByText(
          'Already has a rule from this template: Battery house voltage low (LiFePO4). Save leaves it out.'
        )
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      await screen.findByRole('heading', { name: 'Battery starter voltage low (LiFePO4)' })
      expect(createdRules(api).map((r) => r.slug)).toEqual(['battery-voltage-low-lifepo4-starter'])
    })

    it('creates the pick that has a rule too once the user keeps it', async () => {
      const api = renderShell(fresh([houseRule]))
      await openEditLink()
      fireEvent.click(tab(/House bank/))
      fireEvent.click(screen.getByRole('button', { name: 'Create another rule for it' }))
      expect(
        screen.getByRole('heading', { name: '2 new rules from “Battery voltage low (LiFePO4)”' })
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
      await screen.findByRole('heading', { name: 'Alert rules' })
      expect(createdRules(api).map((r) => r.slug)).toEqual([
        'battery-voltage-low-lifepo4-house-2',
        'battery-voltage-low-lifepo4-starter'
      ])
    })
  })

  it('takes a typed battery when none reports, and makes its rule on the typed path', async () => {
    const api = renderShell(fresh(), { reported: [] })
    window.history.replaceState(null, '', '/#add')
    fireEvent.click(await screen.findByRole('link', { name: /^Built in/ }))
    fireEvent.click(await screen.findByRole('link', { name: /^Battery voltage low \(LiFePO4\)/ }))
    expect(
      await screen.findByText(/Nothing reports electrical\.batteries\.<name>\.voltage yet\./)
    ).toBeTruthy()
    const typed = screen.getByRole('textbox', { name: 'Not listed?' })
    change(typed, 'wind lass')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert').textContent).toMatch(/one path segment/)
    change(typed, 'windlass')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const row = screen.getByRole('checkbox', { name: /^windlass/ })
    expect(row).toHaveProperty('checked', true)
    expect(row.closest('label')?.textContent).toContain('Typed by you: not reporting yet')
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(api.createRule).toHaveBeenCalledTimes(1)
    })
    expect(createdRules(api)[0]?.signal).toEqual({ path: 'electrical.batteries.windlass.voltage' })
  })

  it('discards every tab on cancel, asking first once one was edited', async () => {
    const api = renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    change(limit(), '12.2')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const sheet = await screen.findByRole('alertdialog', { name: 'Discard your changes?' })
    expect(sheet.textContent).toContain('None of the 2 rules has been created.')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByRole('heading', { name: 'No alert rules yet' })).toBeTruthy()
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it('asks before a hash change from outside drops the edited rules', async () => {
    renderShell(fresh())
    await openLifepo4()
    pick(/^House bank/)
    pick(/^starter/)
    await continueWith('Continue with 2 rules')
    change(limit(), '12.2')
    act(() => {
      window.history.pushState(null, '', '#')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    const sheet = screen.getByRole('alertdialog', { name: 'Discard your changes?' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(limit().value).toBe('12.2')
  })

  it('asks before the link to the rule holding the alert path leaves an edited rule', async () => {
    const holder = ruleEntry({ slug: 'old-starter', rule: { name: 'Old starter alarm' } })
    const server = fresh([holder])
    server.refuse = (rule) =>
      rule.slug.endsWith('starter')
        ? new RuleRejectedError('another rule has this alert path', [
            {
              path: '/condition',
              message:
                'makes an alert path overlapping that of rule old-starter; each rule needs its own'
            }
          ])
        : undefined
    renderShell(server)
    await openLifepo4()
    pick(/^starter/)
    await continueWith('Continue with 1 rule')
    change(limit(), '12.2')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Old starter alarm' }))
    expect(screen.getByRole('alertdialog', { name: 'Discard your changes?' })).toBeTruthy()
    expect(limit().value).toBe('12.2')
  })

  it('goes back from the rules to the picker with the picks still made', async () => {
    renderShell(fresh())
    await openLifepo4()
    pick(/^starter/)
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('link', { name: 'Choose what it watches' }))
    await screen.findByRole('list', { name: 'Picks' })
    expect(screen.getByRole('checkbox', { name: /^starter/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /^House bank/ })).toHaveProperty('checked', false)
  })
})

describe('the new templates notice', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  const listed = [ruleEntry()]

  it('announces new templates to an administrator, who dismisses them for every browser', async () => {
    const server = fresh(listed)
    const api = renderShell(server)
    const notice = await screen.findByText(/Alert Rules offers/)
    const count = builtinListing().sets[0]?.templates.length ?? 0
    expect(notice.textContent).toContain(`${String(count)} new templates`)
    expect(within(notice).getByRole('link', { name: 'See them' }).getAttribute('href')).toBe(
      '#add=template&set=builtin'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(screen.queryByText(/Alert Rules offers/)).toBeNull()
    })
    expect(api.dismissTemplates).toHaveBeenCalledWith({
      builtin: builtinListing().sets[0]?.new
    })
    cleanup()
    renderShell(server)
    await screen.findByRole('heading', { name: 'Alert rules' })
    await waitFor(() => {
      expect(screen.queryByText(/Alert Rules offers/)).toBeNull()
    })
  })

  /** The built-in set, two of its templates still new, and a second set whose every template is. */
  function twoSets(): TemplateListing {
    const builtin = builtinListing().sets.at(0)
    if (builtin === undefined) throw new Error('no built-in set')
    const extra = builtin.templates.slice(0, 3)
    return {
      sets: [
        { ...builtin, new: builtin.new.slice(0, 2) },
        {
          ...builtin,
          id: 'boatyard',
          name: 'Boatyard templates',
          templates: extra,
          new: extra.map((t) => t.id)
        },
        { ...builtin, id: 'old', name: 'Old templates', new: [] }
      ],
      problems: []
    }
  }

  it('counts the new templates of several sets, dismissing each set’s own', async () => {
    const server: Server = { rules: listed, listing: twoSets() }
    const api = renderShell(server)
    const notice = await screen.findByText(/template sets offer/)
    expect(notice.textContent).toContain('2 template sets offer 5 new templates')
    expect(within(notice).getByRole('link', { name: 'See them' }).getAttribute('href')).toBe(
      '#add=template'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(screen.queryByText(/template sets offer/)).toBeNull()
    })
    const { sets } = twoSets()
    expect(api.dismissTemplates).toHaveBeenCalledWith({
      builtin: sets.at(0)?.new,
      boatyard: sets.at(1)?.new
    })
  })

  it('moves focus to the list heading once dismissed', async () => {
    renderShell(fresh(listed))
    await screen.findByText(/Alert Rules offers/)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alert rules' }))
    })
  })

  it('keeps the notice, saying why, when dismissing fails', async () => {
    const server = fresh(listed)
    const api = renderShell(server)
    api.dismissTemplates.mockImplementation(() => Promise.reject(new Error('disk full')))
    await screen.findByText(/Alert Rules offers/)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByText(/The notice could not be dismissed: disk full/)).toBeTruthy()
  })

  it('is not shown to a user who cannot add rules', async () => {
    const api = renderShell(fresh(listed), { permissions: 'readwrite' })
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(screen.queryByText(/new templates/)).toBeNull()
    expect(api.templates).not.toHaveBeenCalled()
  })
})

describe('rules from a template with two slots', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  const alternator: Template = {
    id: 'alternator-not-charging',
    slots: [
      { name: 'battery', label: 'Battery' },
      { name: 'engine', label: 'Engine' }
    ],
    condition: '${engine}AlternatorNotCharging',
    rule: {
      name: 'Engine ${engine} alternator not charging',
      message: 'Engine ${engine} is not charging battery ${battery}',
      signal: { path: 'electrical.batteries.${battery}.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 13, priority: 'warning' }],
        duration: 120
      },
      gates: [
        {
          signal: { path: 'propulsion.${engine}.revolutions' },
          direction: 'above',
          limit: { kind: 'fixed', value: 8 },
          duration: 30
        }
      ]
    }
  }
  const bySource: Template = { ...alternator, id: 'alternator-by-source', open: ['source'] }
  const listing: TemplateListing = {
    sets: [
      {
        id: 'engines',
        name: 'Engines',
        version: '1.0.0',
        source: 'file engines.yaml',
        templates: [alternator, bySource],
        new: []
      }
    ],
    problems: []
  }
  const reported: PathEntry[] = [
    ...boat,
    voltage('start', 12.6),
    {
      path: 'propulsion.main.revolutions',
      units: 'Hz',
      unit: displayUnit({ units: 'Hz' }),
      value: 30
    }
  ]
  const mainRule = ruleEntry({
    slug: 'alternator-not-charging-start-main',
    rule: {
      name: 'Engine main alternator not charging',
      signal: { paths: ['electrical.batteries.start.voltage'] },
      template: { set: 'engines', id: alternator.id, pick: { battery: 'start', engine: 'main' } }
    }
  })

  async function openTabs(
    picks: Record<string, string>[],
    template = alternator.id,
    shown = /start · port/
  ) {
    const href = hashWithRoute('', {
      kind: 'add',
      from: 'template',
      set: 'engines',
      template,
      picks,
      step: 'edit'
    })
    window.history.replaceState(null, '', `/${href}`)
    await screen.findByRole('tab', { name: shown })
  }

  const revolutions = (engine: string, value: number): PathEntry => ({
    path: `propulsion.${engine}.revolutions`,
    units: 'Hz',
    unit: displayUnit({ units: 'Hz' }),
    value
  })

  /** Add rule, the Engines set, the alternator template: the row picker. */
  async function openRows() {
    window.history.replaceState(null, '', '/#add')
    await screen.findByText('Engines')
    fireEvent.click(screen.getByRole('link', { name: /^Engines/ }))
    const links = await screen.findAllByRole('link', { name: /^Engine alternator not charging/ })
    fireEvent.click(links[0])
    await screen.findByRole('group', { name: 'Rule 1' })
  }

  const cell = (rule: number, label: string) =>
    within(
      screen.getByRole('group', { name: `Rule ${String(rule)}` })
    ).getByRole<HTMLSelectElement>('combobox', { name: label })

  it('makes the rule of a row prefilled from the one battery and engine, from Add rule to Create', async () => {
    const api = renderShell(
      { rules: [], listing },
      { reported: [voltage('start', 12.6), revolutions('main', 30)] }
    )
    await openRows()
    expect(cell(1, 'Battery').value).toBe('start')
    expect(cell(1, 'Engine').value).toBe('main')
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await screen.findByRole('heading', { name: 'Engine main alternator not charging' })
    expect(createdRules(api).map((r) => [r.slug, r.template?.pick, ruleAlertPath(r)])).toEqual([
      [
        'alternator-not-charging-start-main',
        { battery: 'start', engine: 'main' },
        'electrical.batteries.start.mainAlternatorNotCharging'
      ]
    ])
  })

  const twin = [voltage('start', 12.6), revolutions('port', 30), revolutions('starboard', 0)]
  const status = () => screen.getByRole('status')
  const continueButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Continue/ })
  const options = (select: HTMLSelectElement) =>
    [...select.options].map((o) => [o.textContent, o.disabled])
  const choose = (rule: number, label: string, value: string) => {
    change(cell(rule, label), value)
  }

  /** The row picker straight from its link, with the rows `picks` restores. */
  async function openPicker(picks: Record<string, string>[], template = alternator.id) {
    const href = hashWithRoute('', {
      kind: 'add',
      from: 'template',
      set: 'engines',
      template,
      picks
    })
    window.history.replaceState(null, '', `/${href}`)
    await screen.findByRole('group', { name: 'Rule 1' })
  }

  it('reads each slot’s choices with their values, asking for both in the lead', async () => {
    renderShell({ rules: [], listing }, { reported: [...twin, voltage('house', 13.2)] })
    await openRows()
    expect(
      screen.getByText(/Choose a battery and an engine for each rule\./).textContent
    ).toContain('Each row becomes its own rule.')
    expect(screen.queryByText('Reporting now')).toBeNull()
    expect(options(cell(1, 'Battery'))).toEqual([
      ['Choose a battery', true],
      ['house · 13.2 V', false],
      ['start · 12.6 V', false]
    ])
    expect(options(cell(1, 'Engine'))).toEqual([
      ['Choose an engine', true],
      ['port · 30 Hz', false],
      ['starboard · 0 Hz', false]
    ])
    expect(cell(1, 'Engine').value).toBe('')
    expect(status().textContent).toBe('Choose a battery for rule 1')
    expect(continueButton().disabled).toBe(true)
    expect(continueButton().textContent).toBe('Continue with 1 rule')
  })

  it('makes a rule for each of twin engines charging one battery, with alert paths apart', async () => {
    const api = renderShell({ rules: [], listing }, { reported: twin })
    await openRows()
    expect(screen.queryByRole('button', { name: /^Remove rule/ })).toBeNull()
    choose(1, 'Engine', 'port')
    fireEvent.click(screen.getByRole('button', { name: 'Add another' }))
    expect(cell(2, 'Battery').value).toBe('start')
    expect(document.activeElement).toBe(cell(2, 'Engine'))
    choose(2, 'Engine', 'starboard')
    expect(status().textContent).toBe('')
    await continueWith('Continue with 2 rules')
    expect(tab(/start · port/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(createdRules(api).map((r) => [r.slug, ruleAlertPath(r)])).toEqual([
      [
        'alternator-not-charging-start-port',
        'electrical.batteries.start.portAlternatorNotCharging'
      ],
      [
        'alternator-not-charging-start-starboard',
        'electrical.batteries.start.starboardAlternatorNotCharging'
      ]
    ])
  })

  it('removes a row, moving focus to the next row or the one before, and says which went', async () => {
    renderShell({ rules: [], listing }, { reported: twin })
    await openPicker([
      { battery: 'start', engine: 'port' },
      { battery: 'start', engine: 'starboard' },
      { battery: 'start' }
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }))
    expect(cell(1, 'Engine').value).toBe('starboard')
    expect(document.activeElement).toBe(cell(1, 'Battery'))
    expect(status().textContent).toBe('Rule 1 removed. Choose an engine for rule 2')
    const removeLast = screen.getByRole('button', { name: 'Remove rule 2' })
    removeLast.focus()
    fireEvent.click(removeLast)
    expect(screen.queryByRole('group', { name: 'Rule 2' })).toBeNull()
    expect(document.activeElement).toBe(cell(1, 'Battery'))
    expect(status().textContent).toBe('Rule 2 removed.')
    expect(screen.queryByRole('button', { name: /^Remove rule/ })).toBeNull()
    expect(continueButton().disabled).toBe(false)
  })

  it('blocks two rows that are the same, a missing choice named first', async () => {
    renderShell({ rules: [], listing }, { reported: twin })
    await openPicker([
      { battery: 'start', engine: 'port' },
      { battery: 'start', engine: 'port' },
      { battery: 'start' }
    ])
    expect(status().textContent).toBe('Choose an engine for rule 3')
    choose(3, 'Engine', 'starboard')
    expect(status().textContent).toBe('Rules 1 and 2 are the same')
    expect(continueButton().disabled).toBe(true)
    expect(continueButton().textContent).toBe('Continue with 3 rules')
  })

  it('fills a slot nothing reports with a typed name, offered in every row', async () => {
    renderShell({ rules: [], listing }, { reported: [voltage('start', 12.6)] })
    await openRows()
    expect(options(cell(1, 'Engine'))).toEqual([['Nothing reports yet', true]])
    const typed = screen.getByRole('textbox', { name: 'Engine not listed?' })
    expect(typed.getAttribute('placeholder')).toBe('The name in the path')
    expect(screen.getByText(/as propulsion\.<name>\.revolutions\./)).toBeTruthy()
    change(typed, 'port side')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1])
    expect(screen.getByRole('alert').textContent).toContain('one path segment')
    change(typed, 'port')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1])
    expect(cell(1, 'Engine').value).toBe('port')
    expect(options(cell(1, 'Engine'))).toEqual([
      ['Choose an engine', true],
      ['port · not reporting yet', false]
    ])
    expect((typed as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Add another' }))
    expect(cell(2, 'Engine').value).toBe('')
    expect(options(cell(2, 'Engine'))).toContainEqual(['port · not reporting yet', false])
  })

  it('fills a typed name only into rows whose slot is empty', async () => {
    renderShell({ rules: [], listing }, { reported: twin })
    await openPicker([{ battery: 'start', engine: 'port' }, { battery: 'start' }])
    change(screen.getByRole('textbox', { name: 'Engine not listed?' }), 'aft')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1])
    expect([cell(1, 'Engine').value, cell(2, 'Engine').value]).toEqual(['port', 'aft'])
  })

  it('offers only typed names while the paths fail', async () => {
    const failing: PathSource = {
      selfPaths: () => Promise.reject(new Error('timed out')),
      distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
    }
    render(<Shell api={serverApi({ rules: [], listing })} paths={failing} />)
    await openRows()
    expect(screen.getByRole('alert').textContent).toContain('Could not load paths: timed out.')
    expect(options(cell(1, 'Battery'))).toEqual([['Nothing reports yet', true]])
    expect(options(cell(1, 'Engine'))).toEqual([['Nothing reports yet', true]])
    change(screen.getByRole('textbox', { name: 'Battery not listed?' }), 'start')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0])
    expect(cell(1, 'Battery').value).toBe('start')
  })

  it('marks a row whose picks already have a rule from the template', async () => {
    renderShell({ rules: [mainRule], listing }, { reported })
    await openPicker([
      { battery: 'start', engine: 'main' },
      { battery: 'house', engine: 'main' }
    ])
    const [first, second] = screen.getAllByRole('group', { name: /^Rule/ })
    expect(first.textContent).toContain(
      'Already has a rule from this template: Engine main alternator not charging'
    )
    expect(second.textContent).not.toContain('Already has a rule')
    expect(continueButton().disabled).toBe(false)
  })

  it('keeps a chosen engine that stopped reporting, marked so, and prefills no chosen slot', async () => {
    renderShell(
      { rules: [], listing },
      { reported: [voltage('start', 12.6), revolutions('port', 30)] }
    )
    await openPicker([
      { battery: 'house', engine: 'port' },
      { battery: 'start', engine: 'starboard' }
    ])
    expect(cell(1, 'Battery').value).toBe('house')
    expect(options(cell(1, 'Battery'))).toContainEqual(['house · not reporting', false])
    expect(cell(2, 'Engine').value).toBe('starboard')
    expect(options(cell(2, 'Engine'))).toEqual([
      ['Choose an engine', true],
      ['port · 30 Hz', false],
      ['starboard · not reporting', false]
    ])
  })

  it('restores from the link only what the template leaves open', async () => {
    const api = renderShell({ rules: [], listing }, { reported })
    await openPicker([{ battery: 'house', engine: 'main', source: 'x' }])
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await screen.findByRole('heading', { name: 'Engine main alternator not charging' })
    expect(createdRules(api).map((r) => r.template?.pick)).toEqual([
      { battery: 'house', engine: 'main' }
    ])
  })

  it('restores an empty row from a pick made for a template’s one slot', async () => {
    const api = renderShell({ rules: [], listing }, { reported: [...twin, voltage('house', 13.2)] })
    await openPicker([{ instance: 'main' }])
    expect([cell(1, 'Battery').value, cell(1, 'Engine').value]).toEqual(['', ''])
    choose(1, 'Battery', 'house')
    choose(1, 'Engine', 'port')
    await continueWith('Continue with 1 rule')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await screen.findByRole('heading', { name: 'Engine port alternator not charging' })
    expect(createdRules(api).map((r) => r.template?.pick)).toEqual([
      { battery: 'house', engine: 'port' }
    ])
  })

  it('goes back from the rules to the rows as they were', async () => {
    renderShell({ rules: [], listing }, { reported: twin })
    await openRows()
    choose(1, 'Engine', 'starboard')
    fireEvent.click(screen.getByRole('button', { name: 'Add another' }))
    choose(2, 'Engine', 'port')
    await continueWith('Continue with 2 rules')
    fireEvent.click(screen.getByRole('link', { name: 'Choose what it watches' }))
    await screen.findByRole('group', { name: 'Rule 2' })
    expect([cell(1, 'Engine').value, cell(2, 'Engine').value]).toEqual(['starboard', 'port'])
    expect(cell(2, 'Battery').value).toBe('start')
  })

  describe('a template that leaves the source open', () => {
    const sourced: PathEntry[] = [
      { ...voltage('start', 12.6), sources: ['n2k.1', 'n2k.3'] },
      { ...voltage('house', 13.2), sources: ['n2k.2'] },
      revolutions('main', 30)
    ]

    it('waits for the battery before offering its sources, clearing the source when it changes', async () => {
      const api = renderShell({ rules: [], listing }, { reported: sourced })
      await openPicker([{ engine: 'main' }], bySource.id)
      const source = () => cell(1, 'Source')
      expect(source().disabled).toBe(true)
      expect(options(source())).toEqual([['Choose a battery first', true]])
      choose(1, 'Battery', 'start')
      expect(source().disabled).toBe(false)
      expect(options(source())).toEqual([
        ['Choose a source', true],
        ['n2k.1', false],
        ['n2k.3', false]
      ])
      expect(status().textContent).toBe('Choose a source for rule 1')
      choose(1, 'Source', 'n2k.3')
      choose(1, 'Battery', 'house')
      expect(source().value).toBe('')
      choose(1, 'Source', 'n2k.2')
      await continueWith('Continue with 1 rule')
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
      await screen.findByRole('heading', { name: 'Engine main alternator not charging' })
      expect(createdRules(api).map((r) => [r.template?.pick, r.signal])).toEqual([
        [
          { battery: 'house', engine: 'main', source: 'n2k.2' },
          { path: 'electrical.batteries.house.voltage', source: 'n2k.2' }
        ]
      ])
    })

    it('keeps the chosen source when a slot outside the signal path changes', async () => {
      renderShell(
        { rules: [], listing },
        { reported: [...sourced, revolutions('port', 30), revolutions('starboard', 0)] }
      )
      await openPicker([{ battery: 'start', engine: 'port' }], bySource.id)
      choose(1, 'Source', 'n2k.1')
      choose(1, 'Engine', 'starboard')
      expect(cell(1, 'Source').value).toBe('n2k.1')
      expect(status().textContent).toBe('')
    })

    it('takes a typed name only for a slot outside the signal path, which has no sources to offer', async () => {
      renderShell({ rules: [], listing }, { reported: sourced.slice(0, 2) })
      await openPicker([{ battery: 'start' }], bySource.id)
      expect(screen.queryByRole('textbox', { name: 'Battery not listed?' })).toBeNull()
      change(screen.getByRole('textbox', { name: 'Engine not listed?' }), 'aft')
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(cell(1, 'Engine').value).toBe('aft')
      choose(1, 'Source', 'n2k.1')
      expect(status().textContent).toBe('')
      expect(continueButton().disabled).toBe(false)
    })
  })

  it('labels a tab with its source after the slots, and marks a battery not reporting', async () => {
    renderShell({ rules: [], listing }, { reported })
    await openTabs(
      [
        { battery: 'start', engine: 'main', source: 'n2k.1' },
        { battery: 'windlass', engine: 'port', source: 'n2k.1' }
      ],
      bySource.id,
      /windlass · port · n2k\.1/
    )
    expect(tab(/start · main · n2k\.1/).textContent).not.toContain('not reporting yet')
    expect(tab(/windlass · port · n2k\.1/).textContent).toContain('not reporting yet')
  })

  it('labels each tab with its slots, marking the row with a rule and the one whose engine is silent', async () => {
    const api = renderShell({ rules: [mainRule], listing }, { reported })
    await openTabs([
      { battery: 'start', engine: 'main' },
      { battery: 'start', engine: 'port' }
    ])
    expect(tab(/start · main/).textContent).toContain('already has a rule')
    expect(tab(/start · port/).textContent).not.toContain('already has a rule')
    expect(tab(/start · main/).textContent).not.toContain('not reporting yet')
    expect(tab(/start · port/).textContent).toContain('not reporting yet')
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await screen.findByRole('heading', { name: 'Engine port alternator not charging' })
    expect(createdRules(api).map((r) => [r.slug, r.template?.pick])).toEqual([
      ['alternator-not-charging-start-port', { battery: 'start', engine: 'port' }]
    ])
  })

  it('tries the next slug from every pick when an unlisted stored rule holds the one proposed', async () => {
    const server: Server = { rules: [], listing }
    server.refuse = (rule) =>
      rule.slug === 'alternator-not-charging-start-port'
        ? new RuleRejectedError('a rule with this slug exists', [
            {
              path: '/slug',
              message:
                'is taken by another rule. If an earlier attempt to create this rule timed out, it may have saved this rule: check the rule list before renaming.'
            }
          ])
        : undefined
    const api = renderShell(server, { reported })
    await openTabs([
      { battery: 'start', engine: 'main' },
      { battery: 'start', engine: 'port' }
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(createdRules(api).map((r) => r.slug)).toEqual([
      'alternator-not-charging-start-main',
      'alternator-not-charging-start-port',
      'alternator-not-charging-start-port-2'
    ])
  })
})

describe('rules from a template with one slot named other than instance', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  const batteryLow: Template = {
    id: 'battery-low',
    slots: [{ name: 'battery', label: 'Battery' }],
    condition: 'voltageLow',
    rule: {
      name: 'Battery ${battery} voltage low',
      message: 'Battery ${battery} voltage below {limit}: {value}',
      signal: { path: 'electrical.batteries.${battery}.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 12, priority: 'warning' }],
        duration: 60
      }
    }
  }
  const listing: TemplateListing = {
    sets: [
      {
        id: 'batteries',
        name: 'Batteries',
        version: '1.0.0',
        source: 'file batteries.yaml',
        templates: [batteryLow],
        new: []
      }
    ],
    problems: []
  }

  it('lists each battery, takes a typed one, and labels each tab with its pick', async () => {
    const api = renderShell({ rules: [], listing })
    const href = hashWithRoute('', {
      kind: 'add',
      from: 'template',
      set: 'batteries',
      template: batteryLow.id
    })
    window.history.replaceState(null, '', `/${href}`)
    await screen.findByRole('list', { name: 'Picks' })
    pick(/^House bank/)
    change(screen.getByRole('textbox', { name: 'Not listed?' }), 'windlass')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('checkbox', { name: /^windlass/ })).toHaveProperty('checked', true)
    await continueWith('Continue with 2 rules')
    expect(tab(/House bank/).textContent).not.toContain('not reporting yet')
    expect(tab(/windlass/).textContent).toContain('not reporting yet')
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 rules' }))
    await screen.findByRole('heading', { name: 'Alert rules' })
    expect(createdRules(api).map((r) => [r.slug, r.signal, r.template?.pick])).toEqual([
      ['battery-low-house', { path: 'electrical.batteries.house.voltage' }, { battery: 'house' }],
      [
        'battery-low-windlass',
        { path: 'electrical.batteries.windlass.voltage' },
        { battery: 'windlass' }
      ]
    ])
  })

  it('keeps a typed battery checked on the way back from the rules', async () => {
    renderShell({ rules: [], listing })
    const href = hashWithRoute('', {
      kind: 'add',
      from: 'template',
      set: 'batteries',
      template: batteryLow.id
    })
    window.history.replaceState(null, '', `/${href}`)
    await screen.findByRole('list', { name: 'Picks' })
    pick(/^House bank/)
    change(screen.getByRole('textbox', { name: 'Not listed?' }), 'windlass')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await continueWith('Continue with 2 rules')
    fireEvent.click(screen.getByRole('link', { name: 'Choose what it watches' }))
    await screen.findByRole('list', { name: 'Picks' })
    expect(screen.getByRole('checkbox', { name: /^windlass/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /^House bank/ })).toHaveProperty('checked', true)
  })
})
