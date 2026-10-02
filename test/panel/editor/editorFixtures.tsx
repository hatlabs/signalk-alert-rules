import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import { validateRule } from '../../../src/model/validate'
import type { EditPreview, PanelApi, RuleEntry } from '../../../src/panel/api'
import { RuleEditor, type RuleEditorProps } from '../../../src/panel/editor/RuleEditor'
import type { PathEntry, PathSource } from '../../../src/panel/paths/selfPaths'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { noAuthoring, noControls, ruleEntry } from '../fixtures'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')

/** A worked example as the server stores it: validated. */
export function example(slug: string): Rule {
  const result = validateRule(JSON.parse(readFileSync(join(EXAMPLES, `${slug}.json`), 'utf8')))
  if (!result.ok) throw new Error(`${slug} is not valid`)
  return result.value
}

/** A unit shown as it is stored. */
const si = (units: string) =>
  displayUnit({ units, displayUnits: { formula: 'value * 1', symbol: units } })
const volts = si('V')
const rpm = displayUnit({ units: 'Hz', displayUnits: { formula: 'value * 60', symbol: 'rpm' } })
const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
export const distance = si('m')

/** What the server reports: every path the worked examples read, and a few more. */
export const reported: PathEntry[] = [
  {
    path: 'electrical.batteries.house.voltage',
    units: 'V',
    unit: volts,
    value: 13.31,
    displayName: 'House battery voltage',
    zones: [
      { upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 12, state: 'warn' }
    ]
  },
  {
    path: 'electrical.batteries.bowThruster.voltage',
    units: 'V',
    unit: volts,
    value: 12.9,
    displayName: 'Bow thruster battery voltage'
  },
  { path: 'electrical.batteries.start.voltage', units: 'V', unit: volts, value: 12.6 },
  { path: 'electrical.switches.bilgePump.state', unit: displayUnit({}), value: false },
  {
    path: 'navigation.headingMagnetic',
    units: 'rad',
    unit: si('rad'),
    value: 1.2,
    sources: ['compass.a', 'compass.b']
  },
  { path: 'propulsion.port.coolantTemperature', units: 'K', unit: celsius, value: 355 },
  { path: 'propulsion.starboard.coolantTemperature', units: 'K', unit: celsius, value: 356 },
  { path: 'propulsion.port.revolutions', units: 'Hz', unit: rpm, value: 20 },
  { path: 'propulsion.starboard.revolutions', units: 'Hz', unit: rpm, value: 20 },
  { path: 'propulsion.main.revolutions', units: 'Hz', unit: rpm, value: 0 },
  { path: 'propulsion.port.state', unit: displayUnit({}), value: 'started' },
  { path: 'propulsion.starboard.state', unit: displayUnit({}), value: 'started' },
  { path: 'environment.depth.belowTransducer', units: 'm', unit: si('m'), value: 4.2 },
  { path: 'tanks.freshWater.0.currentLevel', units: 'ratio', unit: si('ratio'), value: 0.6 },
  {
    path: 'navigation.position',
    unit: displayUnit({}),
    sources: ['gnss.bow', 'gnss.mast', 'gnss.stern']
  },
  { path: 'navigation.watch.acknowledged', unit: displayUnit({}), value: true },
  {
    path: 'navigation.speedOverGround',
    units: 'm/s',
    unit: si('m/s'),
    value: 2.5,
    sources: ['gnss.bow', 'gnss.stern'],
    preferredSource: 'gnss.stern'
  }
]

export const units = unitLookup(reported, distance)

export const pathSource: PathSource = {
  selfPaths: () => Promise.resolve(reported),
  distanceUnit: () => Promise.resolve(distance)
}

export const noChange: EditPreview = {
  restarts: false,
  changes: [],
  activeAlerts: 0,
  clearsActiveAlert: false,
  discardsTotal: false
}

export function fakeApi() {
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

export type FakeApi = ReturnType<typeof fakeApi>

export function renderEditor(
  props: Partial<Omit<RuleEditorProps, 'api'>> & { editing?: { entry: RuleEntry; rule: Rule } } = {}
) {
  const api = fakeApi()
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(
    <RuleEditor
      api={api}
      paths={pathSource}
      back={{ href: '#back', label: 'Alert rules' }}
      onSaved={onSaved}
      onClose={onClose}
      {...props}
    />
  )
  return { api, onSaved, onClose }
}

export async function formShown() {
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeTruthy()
  })
}

export const textbox = (name: string | RegExp) => screen.getByRole('textbox', { name })
export const select = (name: string | RegExp) => screen.getByRole('combobox', { name })
export const type = (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } })
}
export const choose = (name: string | RegExp, value: string) => {
  type(select(name), value)
}
export const click = (element: HTMLElement) => {
  fireEvent.click(element)
}
export const button = (name: string | RegExp) => screen.getByRole('button', { name })
export const checkbox = (name: string | RegExp) => screen.getByRole('checkbox', { name })

/** Opens More options unless it is open. */
export function openMoreOptions() {
  const summary = screen.getByText('More options')
  if (summary.closest('details')?.open !== true) click(summary)
}

/** The text an input is described by: its hint and its errors. */
export function description(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

export async function saved(onSaved: ReturnType<typeof vi.fn>) {
  await waitFor(() => {
    expect(onSaved).toHaveBeenCalled()
  })
}
