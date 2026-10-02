// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import { validateRule } from '../../../src/model/validate'
import {
  RuleRejectedError,
  type ListedRule,
  type PanelApi,
  type PluginState,
  type RuleEntry,
  type TemplateListing
} from '../../../src/panel/api'
import type { PathEntry, PathSource } from '../../../src/panel/paths/selfPaths'
import { Shell } from '../../../src/panel/Shell'
import { displayUnit } from '../../../src/panel/units'
import { BUILTIN_TEMPLATES, discoverTemplateSets } from '../../../src/templates/discovery'
import { noControls, ruleEntry } from '../fixtures'

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
    permissions = 'admin'
  }: { reported?: PathEntry[]; permissions?: PluginState['permissions'] } = {}
) {
  const api = serverApi(server, permissions)
  render(<Shell api={api} paths={pathsOf(reported)} />)
  return api
}

const fresh = (rules: ListedRule[] = []): Server => ({ rules, listing: builtinListing() })

const change = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } })
}

/** Add rule, the built-in set, the LiFePO4 low voltage template: the picker. */
async function openLifepo4() {
  window.history.replaceState(null, '', '/#add')
  fireEvent.click(await screen.findByRole('link', { name: /^Built in/ }))
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

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Add rule from a template', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('offers each set with its new templates counted', async () => {
    window.history.replaceState(null, '', '/#add')
    renderShell(fresh())
    const set = await screen.findByRole('link', { name: /^Built in/ })
    const count = String(builtinListing().sets[0]?.templates.length)
    expect(set.textContent).toContain(`${count} templates: Battery voltage low (lead-acid)`)
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
    expect(api.createRule).not.toHaveBeenCalled()
    fireEvent.click(tab(/House bank/))
    expect(limit().value).toBe('12.9')
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

  it('marks a battery that already has a rule from the template, and still lets it be picked', async () => {
    const made = ruleEntry({
      slug: 'battery-voltage-low-lifepo4-house',
      rule: {
        name: 'House bank voltage low',
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
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(api.createRule).toHaveBeenCalledTimes(1)
    })
    expect(createdRules(api)[0]?.slug).toBe('battery-voltage-low-lifepo4-house-2')
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
    const sheet = await screen.findByRole('alertdialog', { name: 'Discard these 2 rules?' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Discard' }))
    expect(await screen.findByRole('heading', { name: 'No alert rules yet' })).toBeTruthy()
    expect(api.createRule).not.toHaveBeenCalled()
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
