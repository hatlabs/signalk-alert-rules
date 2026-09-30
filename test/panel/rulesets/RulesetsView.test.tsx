// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuleRejectedError, type RuleEntry } from '../../../src/panel/api'
import type { PathList } from '../../../src/panel/paths/selfPaths'
import type { RulesetEntry, RulesetListing, RulesetsApi } from '../../../src/panel/rulesets/api'
import { RulesetsView } from '../../../src/panel/rulesets/RulesetsView'
import { displayUnit } from '../../../src/panel/units'
import { ruleEntry } from '../fixtures'

function ruleset(overrides: Partial<RulesetEntry> = {}): RulesetEntry {
  return {
    slug: 'batteries',
    name: 'Battery monitoring',
    version: '1.0.0',
    source: 'package signalk-alert-ruleset-example',
    package: { name: 'signalk-alert-ruleset-example', version: '1.0.0' },
    enabled: true,
    parameters: [
      { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
      {
        name: 'lowVoltage',
        type: 'number',
        unit: 'V',
        description: 'Below this the bank is low',
        default: 12,
        minimum: 10,
        maximum: 14
      }
    ],
    values: {},
    rules: ['low'],
    missingPaths: [],
    notices: [],
    ...overrides
  }
}

function fakeApi(initial: RulesetListing) {
  let listing = initial
  const replace = (entry: RulesetEntry) => {
    listing = {
      ...listing,
      rulesets: listing.rulesets.map((r) => (r.slug === entry.slug ? entry : r))
    }
    return entry
  }
  const find = (slug: string) => {
    const found = listing.rulesets.find((r) => r.slug === slug)
    if (found === undefined) throw new Error(`no ruleset ${slug}`)
    return found
  }
  const api = {
    list: vi.fn(() => Promise.resolve(listing)),
    rescan: vi.fn(() => Promise.resolve(listing)),
    setEnabled: vi.fn((slug: string, enabled: boolean) =>
      Promise.resolve(replace({ ...find(slug), enabled }))
    ),
    setParameters: vi.fn((slug: string, values: Record<string, number | string>) =>
      Promise.resolve(replace({ ...find(slug), values }))
    ),
    dismissNotices: vi.fn((slug: string) => {
      replace({ ...find(slug), notices: [] })
      return Promise.resolve()
    })
  } satisfies RulesetsApi
  return {
    api,
    set: (next: RulesetListing) => {
      listing = next
    }
  }
}

const noPaths: PathList = { status: 'ready', paths: [] }

const lowRule = ruleEntry({
  origin: 'batteries',
  slug: 'low',
  ruleset: { name: 'Battery monitoring', version: '1.0.0' },
  rule: { name: 'Battery low', signal: { paths: ['electrical.batteries.house.voltage'] } }
})

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

async function show(
  listing: RulesetListing,
  options: { rules?: RuleEntry[]; paths?: PathList; focusSlug?: string } = {}
) {
  const fake = fakeApi(listing)
  const refresh = vi.fn()
  const view = render(
    <RulesetsView
      api={fake.api}
      rules={options.rules ?? [lowRule]}
      paths={options.paths ?? noPaths}
      ruleHref={(origin, slug) => `#rule=${origin}/${slug}`}
      refresh={refresh}
      {...(options.focusSlug === undefined ? {} : { focusSlug: options.focusSlug })}
    />
  )
  await settle()
  return { ...fake, refresh, view }
}

const card = (name: string) => screen.getByRole('region', { name })
const field = (name: string) => screen.getByRole('textbox', { name })

describe('RulesetsView', () => {
  afterEach(cleanup)

  it('shows each ruleset with its slug, package and version', async () => {
    await show({ rulesets: [ruleset()], problems: [] })
    const batteries = card('Battery monitoring')
    expect(batteries.textContent).toContain('batteries')
    expect(batteries.textContent).toContain('signalk-alert-ruleset-example 1.0.0')
    expect(batteries.textContent).toContain('version 1.0.0')
    expect(
      within(batteries).getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  it('names the file of a ruleset that no package ships', async () => {
    const { package: _p, ...fromFile } = ruleset({ source: 'file extra.yaml' })
    await show({ rulesets: [fromFile], problems: [] })
    expect(card('Battery monitoring').textContent).toContain('file extra.yaml')
  })

  it('enables a discovered ruleset and refreshes the rules', async () => {
    const { api, refresh } = await show({
      rulesets: [ruleset({ enabled: false })],
      problems: []
    })
    const toggle = screen.getByRole('switch', { name: 'Enabled' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await settle()
    expect(api.setEnabled).toHaveBeenCalledWith('batteries', true)
    expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(refresh).toHaveBeenCalled()
  })

  it('lists a malformed ruleset with its reason and line', async () => {
    await show({
      rulesets: [],
      problems: [
        { source: 'file broken.yaml', message: 'bad indentation', line: 3 },
        { source: 'package gone', message: 'Cannot find module' }
      ]
    })
    const problems = screen.getByRole('region', { name: /could not be loaded/i })
    const items = within(problems)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(items).toEqual([
      'file broken.yaml, line 3: bad indentation',
      'package gone: Cannot find module'
    ])
  })

  it('shows an inactive rule with the paths it is missing', async () => {
    const inactive = ruleEntry({
      ...lowRule,
      status: {
        badge: 'inactive',
        reason: 'ruleset path missing',
        issues: ['electrical.batteries.house.voltage']
      }
    })
    await show(
      {
        rulesets: [ruleset({ missingPaths: ['electrical.batteries.house.voltage'] })],
        problems: []
      },
      { rules: [inactive] }
    )
    const rules = within(card('Battery monitoring')).getByRole('list', { name: 'Rules' })
    const row = within(rules).getByRole('listitem')
    expect(within(row).getByRole('link', { name: 'Battery low' }).getAttribute('href')).toBe(
      '#rule=batteries/low'
    )
    expect(row.textContent).toContain('ruleset path missing')
    expect(row.textContent).toContain('electrical.batteries.house.voltage')
  })

  it('shows the missing paths of a disabled ruleset, whose rules do not say', async () => {
    await show({
      rulesets: [ruleset({ enabled: false, missingPaths: ['electrical.batteries.house.voltage'] })],
      problems: []
    })
    const missing = within(card('Battery monitoring')).getByRole('list', {
      name: /not had data/i
    })
    expect(missing.textContent).toBe('electrical.batteries.house.voltage')
  })

  it('rescans, shows what it found and refreshes the rules', async () => {
    const { api, set, refresh } = await show({ rulesets: [], problems: [] })
    expect(screen.getByText(/no ruleset is installed/i)).toBeTruthy()
    set({ rulesets: [ruleset({ enabled: false })], problems: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))
    await settle()
    expect(api.rescan).toHaveBeenCalledOnce()
    expect(card('Battery monitoring')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/found 1 ruleset/i)
    expect(refresh).toHaveBeenCalled()
  })

  it('shows a rescan that fails', async () => {
    const { api } = await show({ rulesets: [], problems: [] })
    api.rescan.mockRejectedValueOnce(new Error('the data directory could not be written'))
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/could not be written/)
  })

  it('dismisses the notices and moves focus to the ruleset', async () => {
    const { api } = await show({
      rulesets: [
        ruleset({
          notices: [
            { at: '2026-09-30T12:00:00.000Z', message: 'rule high is not in version 1.0.0' },
            { at: '2026-09-30T12:00:00.000Z', message: 'lowVoltage 9 no longer validates' }
          ]
        })
      ],
      problems: []
    })
    const notices = screen.getByRole('region', { name: 'Changes from an upgrade' })
    expect(
      within(notices)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['rule high is not in version 1.0.0', 'lowVoltage 9 no longer validates'])
    fireEvent.click(within(notices).getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(api.dismissNotices).toHaveBeenCalledWith('batteries')
    expect(screen.queryByRole('region', { name: 'Changes from an upgrade' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Battery monitoring' }))
  })

  describe('parameters', () => {
    it('shows each value against its default, in the display unit', async () => {
      const volts = displayUnit({
        units: 'V',
        displayUnits: { formula: 'value * 1000', symbol: 'mV' }
      })
      await show(
        { rulesets: [ruleset({ values: { lowVoltage: 11.5 } })], problems: [] },
        {
          paths: {
            status: 'ready',
            paths: [{ path: 'electrical.batteries.house.voltage', units: 'V', unit: volts }]
          }
        }
      )
      const low = field('lowVoltage')
      expect((low as HTMLInputElement).value).toBe('11500')
      const hint = document.getElementById(low.getAttribute('aria-describedby') ?? '')
      expect(hint?.textContent).toContain('Below this the bank is low')
      expect(hint?.textContent).toContain('Default 12000 mV')
      expect(hint?.textContent).toContain('Allowed from 10000 mV to 14000 mV.')
      expect((field('prefix') as HTMLInputElement).value).toBe('electrical.batteries.house')
      expect(
        screen.getByRole('button', { name: 'Reset prefix to default' }).hasAttribute('disabled')
      ).toBe(true)
    })

    it('saves a changed value in SI with the stored values it keeps', async () => {
      const { api, refresh } = await show({
        rulesets: [ruleset({ values: { prefix: 'electrical.batteries.start' } })],
        problems: []
      })
      const save = screen.getByRole('button', { name: 'Save parameters' })
      expect(save.hasAttribute('disabled')).toBe(true)
      fireEvent.change(field('lowVoltage'), { target: { value: '11' } })
      fireEvent.click(save)
      await settle()
      expect(api.setParameters).toHaveBeenCalledWith('batteries', {
        prefix: 'electrical.batteries.start',
        lowVoltage: 11
      })
      expect(refresh).toHaveBeenCalled()
      expect(screen.getByRole('status').textContent).toMatch(/saved/i)
    })

    it('resets one parameter to its default by leaving it out', async () => {
      const { api } = await show({
        rulesets: [ruleset({ values: { prefix: 'x.y', lowVoltage: 11 } })],
        problems: []
      })
      fireEvent.click(screen.getByRole('button', { name: 'Reset lowVoltage to default' }))
      expect((field('lowVoltage') as HTMLInputElement).value).toBe('12')
      fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }))
      await settle()
      expect(api.setParameters).toHaveBeenCalledWith('batteries', { prefix: 'x.y' })
    })

    it('places a refused value on its field and keeps what was typed', async () => {
      const { api } = await show({ rulesets: [ruleset()], problems: [] })
      api.setParameters.mockRejectedValueOnce(
        new RuleRejectedError('invalid parameter values', [
          { path: '/lowVoltage', message: 'must be <= 14' }
        ])
      )
      fireEvent.change(field('lowVoltage'), { target: { value: '20' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }))
      await settle()
      const low = field('lowVoltage')
      expect(low.getAttribute('aria-invalid')).toBe('true')
      const described = (low.getAttribute('aria-describedby') ?? '').split(' ')
      const messages = described.map((id) => document.getElementById(id)?.textContent)
      expect(messages).toContain('must be <= 14')
      expect((low as HTMLInputElement).value).toBe('20')
    })

    it('shows an error in a rule the values make above the form', async () => {
      const { api } = await show({ rulesets: [ruleset()], problems: [] })
      api.setParameters.mockRejectedValueOnce(
        new RuleRejectedError('invalid parameter values', [
          { path: '', message: 'rule low /signal/path: must match pattern' }
        ])
      )
      fireEvent.change(field('prefix'), { target: { value: 'bad path' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }))
      await settle()
      const form = screen.getByRole('form', { name: 'Parameters of Battery monitoring' })
      expect(within(form).getByRole('alert').textContent).toContain(
        'rule low /signal/path: must match pattern'
      )
    })

    it('refuses text that is not a number without asking the server', async () => {
      const { api } = await show({ rulesets: [ruleset()], problems: [] })
      fireEvent.change(field('lowVoltage'), { target: { value: 'twelve' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }))
      await settle()
      expect(api.setParameters).not.toHaveBeenCalled()
      expect(field('lowVoltage').getAttribute('aria-invalid')).toBe('true')
    })
  })

  it('focuses the ruleset a rule links to', async () => {
    await show({ rulesets: [ruleset()], problems: [] }, { focusSlug: 'batteries' })
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Battery monitoring' }))
  })
})
