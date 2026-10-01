// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import { validateRule } from '../../../src/model/validate'
import {
  RuleRejectedError,
  type EditPreview,
  type PanelApi,
  type RuleEntry
} from '../../../src/panel/api'
import { RuleEditor } from '../../../src/panel/editor/RuleEditor'
import type { PathEntry, PathSource } from '../../../src/panel/paths/selfPaths'
import { displayUnit } from '../../../src/panel/units'
import { instance, noAuthoring, noControls, ruleEntry } from '../fixtures'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')
// As the server stores them: validated, with the default alert path filled in.
function example(slug: string): Rule {
  const result = validateRule(JSON.parse(readFileSync(join(EXAMPLES, `${slug}.json`), 'utf8')))
  if (!result.ok) throw new Error(`${slug} is not valid`)
  return result.value
}

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
    rules: vi.fn(),
    resetAccumulator: vi.fn(),
    ...noAuthoring,
    ...noControls,
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

  it('shows the default condition name as a placeholder until one is typed', async () => {
    const { api, onSaved } = renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    type(textbox('Message'), 'Low')
    choose('Priority', 'warning')
    type(textbox('Name'), 'House battery low')
    const condition = textbox('Alert path')
    expect(condition).toHaveProperty('readOnly', false)
    // The parent the input gives is shown, and not editable.
    expect(screen.getByText('alerts.electrical.batteries.house.')).toBeTruthy()
    expect(condition).toHaveProperty('value', '')
    expect(condition).toHaveProperty('placeholder', 'voltageLow')
    expect(screen.getByText(/Follows the input and detector until you type a name\./)).toBeTruthy()
    choose('Alert when the input is', 'above')
    expect(condition).toHaveProperty('placeholder', 'voltageHigh')
    type(condition, 'overvoltage')
    choose('Alert when the input is', 'below')
    expect(condition).toHaveProperty('value', 'overvoltage')
    expect(
      screen.getByText(/Kept as written\. Clear it to follow the input and detector again\./)
    ).toBeTruthy()
    click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(api.createRule).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'overvoltage' })
    )
  })

  it('saves no condition name while it follows the default', async () => {
    const { api, onSaved } = renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    type(textbox('Message'), 'Low')
    choose('Priority', 'warning')
    type(textbox('Name'), 'House battery low')
    click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(api.createRule.mock.calls[0]?.[0]).not.toHaveProperty('condition')
  })

  it('follows the default again once the typed condition name is cleared', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    type(textbox('Message'), 'Low')
    choose('Priority', 'warning')
    type(textbox('Name'), 'House battery low')
    const condition = textbox('Alert path')
    type(condition, 'overvoltage')
    type(condition, '')
    expect(condition).toHaveProperty('value', '')
    expect(condition).toHaveProperty('placeholder', 'voltageLow')
    choose('Alert when the input is', 'above')
    expect(condition).toHaveProperty('placeholder', 'voltageHigh')
  })

  it('takes exactly the typed text after a typed name is backspaced to empty', async () => {
    const { api, onSaved } = renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    type(textbox('Message'), 'Low')
    choose('Priority', 'warning')
    type(textbox('Name'), 'House battery low')
    const condition = textbox('Alert path')
    type(condition, 'o')
    type(condition, '')
    // A keystroke appends to what the input shows.
    type(condition, `${(condition as HTMLInputElement).value}flat`)
    expect(condition).toHaveProperty('value', 'flat')
    click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(api.createRule).toHaveBeenCalledWith(expect.objectContaining({ condition: 'flat' }))
  })

  it('keeps the wildcard of a wildcard input in the alert path prefix', async () => {
    renderEditor()
    await pathsLoaded()
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('checkbox', { name: 'Match all instances' }))
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    type(textbox('Message'), 'Low')
    choose('Priority', 'warning')
    type(textbox('Name'), 'Battery low')
    expect(screen.getByText('alerts.electrical.batteries.*.')).toBeTruthy()
    expect(textbox('Alert path')).toHaveProperty('placeholder', 'voltageLow')
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

  it('asks for a condition name where the input gives no default', async () => {
    renderEditor()
    await pathsLoaded()
    click(screen.getByRole('radio', { name: 'Combine paths' }))
    choose('Input combination', 'absDifference')
    type(combobox('Input path 1'), 'propulsion.port.revolutions')
    type(combobox('Input path 2'), 'propulsion.starboard.revolutions')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'above')
    type(textbox('Limit'), '50')
    type(textbox('Message'), 'Engine speeds differ')
    choose('Priority', 'warning')
    type(textbox('Name'), 'Engine speed mismatch')
    expect(screen.getByText('alerts.propulsion.')).toBeTruthy()
    expect(textbox('Alert path').getAttribute('placeholder') ?? '').toBe('')
    expect(screen.getByText(/There is no default name here; type one\./)).toBeTruthy()
    expect(screen.queryByText(/Follows the input and detector/)).toBeNull()
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
        { path: '/detector/steps/0/limit', message: 'must be at most 20' }
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

  /** Fills a new rule on the house battery up to its name. */
  function fillBatteryRule() {
    type(combobox('Input path'), 'electrical.batteries.house.voltage')
    click(screen.getByRole('radio', { name: /above or below a limit/i }))
    choose('Alert when the input is', 'below')
    type(textbox('Limit'), '11.8')
    choose('Priority', 'warning')
    type(textbox('Message'), 'Low')
    type(textbox('Name'), 'Low')
  }

  it('opens Advanced when the server refuses a field in it', async () => {
    const { api } = renderEditor()
    api.createRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/hysteresis', message: 'must be at most 5' }
      ])
    )
    await pathsLoaded()
    fillBatteryRule()
    const advanced = screen.getByText('Advanced').closest('details')
    expect(advanced?.open).toBe(false)
    click(screen.getByRole('button', { name: 'Create rule' }))
    await waitFor(() => {
      expect(advanced?.open).toBe(true)
    })
    expect(description(textbox('Hysteresis'))).toContain('must be at most 5')
  })

  it('shows a save that failed without field errors, keeping the form to try again', async () => {
    const { api, onSaved } = renderEditor()
    api.createRule.mockRejectedValueOnce(new Error('/rules did not answer in time'))
    await pathsLoaded()
    fillBatteryRule()
    click(screen.getByRole('button', { name: 'Create rule' }))
    expect((await screen.findByRole('alert')).textContent).toBe('/rules did not answer in time')
    expect(onSaved).not.toHaveBeenCalled()
    const create = screen.getByRole('button', { name: 'Create rule' })
    expect(create).toHaveProperty('disabled', false)
    click(create)
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
    expect(screen.queryByText('/rules did not answer in time')).toBeNull()
  })

  it('keeps the sections revealed when a field before them is cleared', async () => {
    renderEditor()
    await pathsLoaded()
    fillBatteryRule()
    type(textbox('Limit'), '')
    for (const name of ['Timing', 'Priority and message', 'Gates', 'Name']) {
      expect(section(name)).not.toBeNull()
    }
    expect(screen.getByRole('button', { name: 'Create rule' })).toBeTruthy()
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

  it('opens fully expanded, with the slug read-only and the alert path editable', async () => {
    renderEditor({ entry: active, rule: battery })
    await screen.findByRole('region', { name: 'Name' })
    for (const name of ['What to detect', 'Limit', 'Timing', 'Priority and message', 'Gates']) {
      expect(section(name)).not.toBeNull()
    }
    expect(textbox('Slug')).toHaveProperty('readOnly', true)
    expect(textbox('Alert path')).toHaveProperty('readOnly', false)
    expect(screen.getByText('alerts.electrical.batteries.house.')).toBeTruthy()
    expect(textbox('Alert path')).toHaveProperty('value', '')
    expect(textbox('Alert path')).toHaveProperty('placeholder', 'voltageLow')
    expect(textbox('Hysteresis')).toHaveProperty('value', '0.2')
    expect(textbox('For at least')).toHaveProperty('value', '1')
  })

  it('follows the default of a saved rule that stores no condition name, until one is typed', async () => {
    renderEditor({ entry: active, rule: battery })
    await screen.findByRole('region', { name: 'Name' })
    const condition = textbox('Alert path')
    choose('Alert when the input is', 'above')
    expect(condition).toHaveProperty('value', '')
    expect(condition).toHaveProperty('placeholder', 'voltageHigh')
    type(condition, 'overvoltage')
    choose('Alert when the input is', 'below')
    expect(condition).toHaveProperty('value', 'overvoltage')
  })

  it("keeps a saved rule's stored condition name when its detector changes", async () => {
    // Equal to the default, it is still the rule's own name: typed text, which stays.
    const named = { ...battery, condition: 'voltageLow' }
    const { api } = renderEditor({ entry: active, rule: named })
    await screen.findByRole('region', { name: 'Name' })
    expect(textbox('Alert path')).toHaveProperty('value', 'voltageLow')
    expect(screen.getByText(/Kept as written\./)).toBeTruthy()
    choose('Alert when the input is', 'above')
    expect(textbox('Alert path')).toHaveProperty('value', 'voltageLow')
    click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => {
      expect(api.previewRule).toHaveBeenCalled()
    })
    expect(api.previewRule.mock.calls[0]?.[1]).toMatchObject({ condition: 'voltageLow' })
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

  it('shows a refusal of an edit saved without asking on the field', async () => {
    const { api, onSaved } = renderEditor({ entry: active, rule: battery })
    api.updateRule.mockRejectedValueOnce(
      new RuleRejectedError('invalid request body', [
        { path: '/detector/hysteresis', message: 'must be at most 5' }
      ])
    )
    type(await screen.findByRole('textbox', { name: 'Hysteresis' }), '9')
    click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => {
      expect(description(textbox('Hysteresis'))).toContain('must be at most 5')
    })
    expect(onSaved).not.toHaveBeenCalled()
  })

  describe('a refusal after the confirmation', () => {
    const clears: EditPreview = {
      restarts: true,
      changes: ['signal'],
      activeAlerts: 1,
      clearsActiveAlert: true,
      discardsTotal: false
    }

    async function confirmPathChange(api: ReturnType<typeof fakeApi>) {
      api.previewRule.mockResolvedValueOnce(clears)
      type(
        await screen.findByRole('combobox', { name: 'Input path' }),
        'electrical.batteries.start.voltage'
      )
      click(screen.getByRole('button', { name: 'Save changes' }))
      click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }))
    }

    it('closes the confirmation and marks the refused field', async () => {
      const { api, onSaved } = renderEditor({ entry: active, rule: battery })
      api.updateRule.mockRejectedValueOnce(
        new RuleRejectedError('invalid request body', [
          { path: '/signal/path', message: 'is not reported' }
        ])
      )
      await confirmPathChange(api)
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).toBeNull()
      })
      expect(description(combobox('Input path'))).toContain('is not reported')
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('keeps the confirmation open with a failure that names no field', async () => {
      const { api, onSaved } = renderEditor({ entry: active, rule: battery })
      api.updateRule.mockRejectedValueOnce(new Error('/rules/x answered 503'))
      await confirmPathChange(api)
      const dialog = screen.getByRole('alertdialog')
      await waitFor(() => {
        expect(within(dialog).getByRole('alert').textContent).toBe('/rules/x answered 503')
      })
      expect(onSaved).not.toHaveBeenCalled()
    })
  })

  it('lists the steps it cannot edit yet in display units, and keeps them', async () => {
    const stepped: Rule = {
      ...battery,
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [
          { limit: 12.2, priority: 'warning' },
          { limit: 11.8, priority: 'alarm' }
        ],
        duration: 60
      }
    }
    const { api } = renderEditor({ entry: active, rule: stepped })
    await pathsLoaded()
    const notice = screen.getByText('Then alarm below 11.8 V')
    expect(notice.closest('.form-text')?.textContent).toContain('the editor cannot change yet')
    type(textbox('Limit'), '12.4')
    click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => {
      expect(api.previewRule).toHaveBeenCalled()
    })
    expect(api.previewRule.mock.calls[0]?.[1].detector).toMatchObject({
      steps: [
        { limit: 12.4, priority: 'warning' },
        { limit: 11.8, priority: 'alarm' }
      ]
    })
    click(screen.getByRole('radio', { name: /zone level/i }))
    expect(screen.queryByText('Then alarm below 11.8 V')).toBeNull()
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

  it('names a unit mismatch once on the input after a save attempt', async () => {
    const rpmMismatch = example('engine-rpm-mismatch')
    renderEditor({ entry: ruleEntry({ slug: rpmMismatch.slug }), rule: rpmMismatch })
    type(
      await screen.findByRole('combobox', { name: 'Input path 2' }),
      'electrical.batteries.house.voltage'
    )
    click(screen.getByRole('button', { name: 'Save changes' }))
    expect(description(combobox('Input path 2')).match(/is in V/g)).toHaveLength(1)
  })

  it('keeps what each gate remembers with that gate when an earlier one is removed', async () => {
    renderEditor({ entry: active, rule: battery })
    const addGate = await screen.findByRole('button', { name: 'Add gate' })
    click(addGate)
    click(addGate)
    const gate = (n: number) => within(screen.getByRole('group', { name: `Gate ${String(n)}` }))
    type(
      gate(1).getByRole('combobox', { name: 'Gate 1 input path' }),
      'electrical.batteries.start.voltage'
    )
    click(gate(1).getByRole('checkbox', { name: 'Match all instances' }))
    type(
      gate(2).getByRole('combobox', { name: 'Gate 2 input path' }),
      'electrical.batteries.*.voltage'
    )
    click(screen.getByRole('button', { name: 'Remove gate 1' }))
    click(gate(1).getByRole('checkbox', { name: 'Match all instances' }))
    // Its first match, not the instance the removed gate had replaced.
    expect(gate(1).getByRole('combobox', { name: 'Gate 1 input path' })).toHaveProperty(
      'value',
      'electrical.batteries.house.voltage'
    )
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
