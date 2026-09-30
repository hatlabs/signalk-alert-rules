// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import {
  RuleRejectedError,
  type EditPreview,
  type PanelApi,
  type RuleEntry
} from '../../../src/panel/api'
import { RuleEditor } from '../../../src/panel/editor/RuleEditor'
import type { PathEntry, PathSource } from '../../../src/panel/paths/selfPaths'
import { displayUnit } from '../../../src/panel/units'
import { instance, noAuthoring, ruleEntry } from '../fixtures'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')
const example = (slug: string) =>
  JSON.parse(readFileSync(join(EXAMPLES, `${slug}.json`), 'utf8')) as Rule

const volts = displayUnit({ units: 'V', displayUnits: { formula: 'value * 1', symbol: 'V' } })
const rpm = displayUnit({ units: 'Hz', displayUnits: { formula: 'value * 60', symbol: 'rpm' } })

const reported: PathEntry[] = [
  {
    path: 'electrical.batteries.house.voltage',
    units: 'V',
    unit: volts,
    zones: [
      { upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 12, state: 'warn' }
    ]
  },
  { path: 'electrical.batteries.start.voltage', units: 'V', unit: volts },
  { path: 'navigation.position', unit: displayUnit({}), sources: ['gnss.bow', 'gnss.stern'] },
  {
    path: 'navigation.speedOverGround',
    units: 'm/s',
    unit: displayUnit({ units: 'm/s' }),
    sources: ['gnss.stern']
  },
  { path: 'propulsion.port.revolutions', units: 'Hz', unit: rpm },
  { path: 'propulsion.starboard.revolutions', units: 'Hz', unit: rpm }
]

const pathSource: PathSource = {
  selfPaths: () => Promise.resolve(reported),
  distanceUnit: () => Promise.resolve(displayUnit({ units: 'm' }))
}

const noChange: EditPreview = {
  restarts: false,
  changes: [],
  activeAlerts: 0,
  clearsActiveAlert: false,
  discardsTotal: false
}

function fakeApi() {
  return {
    state: vi.fn(),
    pluginEnabled: vi.fn(),
    rules: vi.fn(),
    resetAccumulator: vi.fn(),
    setEvaluation: vi.fn(),
    ...noAuthoring,
    createRule: vi.fn((rule: Rule) => Promise.resolve(ruleEntry({ slug: rule.slug }))),
    updateRule: vi.fn((slug: string, _rule: Rule) => Promise.resolve(ruleEntry({ slug }))),
    previewRule: vi.fn((_slug: string, _rule: Rule) => Promise.resolve(noChange))
  } satisfies PanelApi
}

function renderEditor(editing?: { entry: RuleEntry; rule: Rule }) {
  const api = fakeApi()
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(
    <RuleEditor
      api={api}
      paths={pathSource}
      editing={editing}
      onSaved={onSaved}
      onClose={onClose}
    />
  )
  return { api, onSaved, onClose }
}

const section = (name: string) => screen.queryByRole('region', { name })
const textbox = (name: string | RegExp) => screen.getByRole('textbox', { name })
const combobox = (name: string) => screen.getByRole('combobox', { name })
const type = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } })
}
const choose = (name: string | RegExp, value: string) => {
  type(screen.getByRole('combobox', { name }), value)
}
const click = (element: HTMLElement) => {
  fireEvent.click(element)
}

/** The error text an input is described by. */
function description(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

async function pathsLoaded() {
  await waitFor(() => {
    expect(screen.getAllByRole('status').some((s) => s.textContent === '')).toBe(true)
  })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('RuleEditor, new rule', () => {
  afterEach(cleanup)

  it('reveals the sections in order as each is completed', async () => {
    renderEditor()
    await pathsLoaded()
    expect(section('Inputs')).not.toBeNull()
    expect(section('What to detect')).toBeNull()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    expect(section('What to detect')).not.toBeNull()
    expect(section('Limit')).toBeNull()
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    expect(section('Limit')).not.toBeNull()
    expect(section('Priority and message')).toBeNull()
    type(textbox('Limit'), '11.8')
    expect(section('Timing')).not.toBeNull()
    expect(section('Priority and message')).not.toBeNull()
    expect(section('Name')).toBeNull()
    expect(screen.queryByRole('button', { name: /create rule/i })).toBeNull()
  })

  it('authors a sustained zone rule end to end, saved as the model expects', async () => {
    const { api, onSaved } = renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    click(screen.getByRole('radio', { name: /zone level/i }))
    choose('Zone level', 'warn')
    expect(description(combobox('Zone level'))).toContain('warn: 11.5 V to 12 V')
    type(textbox('For at least'), '1')
    choose('For at least unit', 'min')
    click(screen.getByText('Advanced'))
    type(textbox('Hysteresis'), '0.2')
    type(textbox('Clear after'), '30')
    expect(screen.queryByRole('combobox', { name: 'Priority' })).toBeNull()
    type(textbox('Message'), 'House battery voltage is low')
    type(textbox('Name'), 'House battery low')
    expect(textbox('Slug')).toHaveProperty('value', 'house-battery-low')
    expect(screen.getByText(/starts enabled/i)).toBeTruthy()
    click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(api.createRule).toHaveBeenCalledWith(example('house-battery-low'))
  })

  it('rejects a combined input whose unit differs from the others, as it is picked', async () => {
    renderEditor()
    await pathsLoaded()
    click(screen.getByRole('radio', { name: 'Combine paths' }))
    choose('Input combination', 'absDifference')
    type(combobox('Input path 1'), 'propulsion.port.revolutions')
    type(combobox('Input path 2'), 'electrical.batteries.house.voltage')
    expect(combobox('Input path 2').getAttribute('aria-invalid')).toBe('true')
    expect(description(combobox('Input path 2'))).toContain('is in V, the other inputs in Hz')
    expect(section('What to detect')).toBeNull()
    type(combobox('Input path 2'), 'propulsion.starboard.revolutions')
    expect(combobox('Input path 2').hasAttribute('aria-invalid')).toBe(false)
    expect(section('What to detect')).not.toBeNull()
  })

  it('matches all instances of a picked path and previews them', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('checkbox', { name: 'Match all instances' }))
    expect(combobox('Input path')).toHaveProperty('value', 'electrical.batteries.*.voltage')
    expect(screen.getByText('Matches now: house, start')).toBeTruthy()
    click(screen.getByRole('checkbox', { name: 'Match all instances' }))
    expect(combobox('Input path')).toHaveProperty('value', 'electrical.batteries.house.voltage')
  })

  it('lists the sources reporting a path', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'navigation.position')
    const options = within(combobox('Source for input path'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['Preferred source', 'gnss.bow', 'gnss.stern'])
  })

  it('drops a source the new path does not report when the path changes', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'navigation.position')
    choose('Source for input path', 'gnss.stern')
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    expect(combobox('Source for input path')).toHaveProperty('value', '')
  })

  it('keeps a source the new path also reports', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'navigation.position')
    choose('Source for input path', 'gnss.stern')
    type(combobox('Input path'), 'navigation.speedOverGround')
    expect(combobox('Source for input path')).toHaveProperty('value', 'gnss.stern')
  })

  it('inserts the {instance} placeholder into the message of a wildcard rule', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.*.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    type(textbox('Message'), 'Battery low')
    click(screen.getByRole('button', { name: 'Insert {instance}' }))
    expect(textbox('Message')).toHaveProperty('value', 'Battery low{instance}')
  })

  it('shows validation errors from the API on the offending field', async () => {
    const { api } = renderEditor()
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/limit/value', message: 'must be at most 20' }
      ])
    )
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'above')
    type(textbox('Limit'), '99')
    choose('Priority', 'warning')
    type(textbox('Message'), 'High')
    type(textbox('Name'), 'High')
    click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(textbox('Limit').getAttribute('aria-invalid')).toBe('true')
    })
    expect(description(textbox('Limit'))).toContain('must be at most 20')
  })

  it('checks locally that required fields are filled before asking the server', async () => {
    const { api } = renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'above')
    type(textbox('Limit'), 'twelve')
    choose('Priority', 'warning')
    type(textbox('Message'), 'High')
    type(textbox('Name'), 'High')
    click(screen.getByRole('button', { name: 'Create rule' }))
    expect(description(textbox('Limit'))).toContain('must be a number')
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it('asks before leaving with unsaved changes', async () => {
    const { onClose } = renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'a.b')
    click(screen.getByRole('button', { name: 'Cancel' }))
    const dialog = screen.getByRole('alertdialog', { name: /discard your changes/i })
    expect(onClose).not.toHaveBeenCalled()
    click(within(dialog).getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('leaves at once without changes', async () => {
    const { onClose } = renderEditor()
    await pathsLoaded()
    click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('RuleEditor, editing', () => {
  afterEach(cleanup)

  const battery = example('house-battery-low')
  const active = ruleEntry({
    slug: battery.slug,
    rule: { name: battery.name },
    status: { badge: 'alertActive', instances: [instance({ badge: 'alertActive', active: true })] }
  })

  it('opens fully expanded, with the slug read-only beside the alert path', async () => {
    renderEditor({ entry: active, rule: battery })
    await screen.findByRole('region', { name: 'Name' })
    for (const name of ['What to detect', 'Limit', 'Timing', 'Priority and message', 'Gates']) {
      expect(section(name)).not.toBeNull()
    }
    expect(textbox('Slug')).toHaveProperty('readOnly', true)
    expect(description(textbox('Slug'))).toContain('alerts.rules.user.house-battery-low')
    expect(textbox('Hysteresis')).toHaveProperty('value', '0.2')
    expect(textbox('For at least')).toHaveProperty('value', '1')
  })

  it('confirms an edit that clears an active alert, naming the consequence', async () => {
    const { api, onSaved } = renderEditor({ entry: active, rule: battery })
    api.previewRule.mockResolvedValueOnce({
      restarts: true,
      changes: ['signal'],
      activeAlerts: 1,
      clearsActiveAlert: true,
      discardsTotal: false
    })
    type(
      await screen.findByRole('combobox', { name: 'Input path' }),
      'electrical.batteries.start.voltage'
    )
    click(screen.getByRole('button', { name: 'Save changes' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(
      'Saving clears the active alert of this rule and restarts it, because its input changed.'
    )
    expect(api.updateRule).not.toHaveBeenCalled()
    click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(api.updateRule.mock.calls[0]?.[1].signal).toEqual({
      path: 'electrical.batteries.start.voltage'
    })
  })

  it('drops the confirmation when a field changes under it, so the change is previewed too', async () => {
    const { api } = renderEditor({ entry: active, rule: battery })
    const clears: EditPreview = {
      restarts: true,
      changes: ['signal'],
      activeAlerts: 1,
      clearsActiveAlert: true,
      discardsTotal: false
    }
    api.previewRule.mockResolvedValue(clears)
    type(
      await screen.findByRole('combobox', { name: 'Input path' }),
      'electrical.batteries.start.voltage'
    )
    click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('alertdialog')
    type(textbox('Hysteresis'), '0.3')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    click(screen.getByRole('button', { name: 'Save changes' }))
    click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.updateRule).toHaveBeenCalled()
    })
    expect(api.updateRule.mock.calls[0]?.[1].detector).toMatchObject({ hysteresis: 0.3 })
  })

  it('saves an edit applied in place without asking', async () => {
    const { api, onSaved } = renderEditor({ entry: active, rule: battery })
    type(await screen.findByRole('textbox', { name: 'Hysteresis' }), '0.3')
    click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.previewRule).toHaveBeenCalledWith('house-battery-low', {
      ...battery,
      detector: { ...battery.detector, hysteresis: 0.3 }
    })
  })

  it('saves nothing on Enter in a field; only the Save button saves', async () => {
    const { api, onSaved } = renderEditor({ entry: active, rule: battery })
    const hysteresis = await screen.findByRole('textbox', { name: 'Hysteresis' })
    type(hysteresis, '0.3')
    // What a browser does on Enter, or a tablet keyboard's Go, in a text field.
    fireEvent.submit(screen.getByRole('form'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.previewRule).not.toHaveBeenCalled()
    expect(api.updateRule).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('names the accumulated total an edit discards', async () => {
    const hours = example('engine-service-due')
    const entry = ruleEntry({
      slug: hours.slug,
      rule: { name: hours.name, detector: { type: 'accumulator', measure: 'time' } },
      status: { instances: [instance({ progress: { kind: 'total', total: 7200, limit: 900000 } })] }
    })
    const { api } = renderEditor({ entry, rule: hours })
    api.previewRule.mockResolvedValueOnce({ ...noChange, restarts: true, discardsTotal: true })
    await screen.findByRole('combobox', { name: 'Accumulate' })
    choose('Accumulate', 'integral')
    type(textbox('Alert at a total of'), '100')
    click(screen.getByRole('button', { name: 'Save changes' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Saving discards the accumulated total 2 h.')
    expect(api.updateRule).not.toHaveBeenCalled()
  })
})
