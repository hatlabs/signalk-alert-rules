import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, onTestFinished, vi } from 'vitest'
import type { Rule } from '../../../src/model/rule'
import { validateRule } from '../../../src/model/validate'
import type { PanelApi, RuleEntry } from '../../../src/panel/api'
import { RuleEditor, type RuleEditorProps } from '../../../src/panel/editor/RuleEditor'
import { noAuthoring, noChange, noControls, noTemplates, ruleEntry } from '../fixtures'
import { pathSource } from '../reportedPaths'

export { noChange } from '../fixtures'
export { distance, pathSource, reported, units } from '../reportedPaths'

const EXAMPLES = join(import.meta.dirname, '../../../examples/rules')

/** A worked example as the server stores it: validated. */
export function example(slug: string): Rule {
  const result = validateRule(JSON.parse(readFileSync(join(EXAMPLES, `${slug}.json`), 'utf8')))
  if (!result.ok) throw new Error(`${slug} is not valid`)
  return result.value
}

export function fakeApi() {
  return {
    state: vi.fn(),
    rules: vi.fn(),
    resetAccumulator: vi.fn(),
    ...noAuthoring,
    ...noControls,
    ...noTemplates,
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

/** The part of an input's description shown on the page: what is visually hidden is left out. */
export function shownDescription(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => {
      const target = document.getElementById(id)
      if (target === null) return ''
      if (target.closest('.skar-visually-hidden') !== null) return ''
      const copy = target.cloneNode(true) as HTMLElement
      for (const hidden of copy.querySelectorAll('.skar-visually-hidden')) hidden.remove()
      return copy.textContent
    })
    .join(' ')
}

/** The steps' summary, telling how the alert climbs and clears. */
export const stepsSummary = () => screen.getByText(/^The alert is raised/)

/** The stub height of the summary while it tells how the alert clears; only its difference from SUMMARY_CLIMBING matters. */
export const SUMMARY_CLEARING = 54.6
/** The stub height of the summary without that sentence. */
export const SUMMARY_CLIMBING = 36.4

/** Gives the steps' summary the layout jsdom lacks, for this test; every other box stays empty. */
export function summaryLaidOut() {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    const height = !this.textContent.startsWith('The alert is raised')
      ? 0
      : this.textContent.includes('It ends')
        ? SUMMARY_CLEARING
        : SUMMARY_CLIMBING
    return DOMRect.fromRect({ width: height === 0 ? 0 : 300, height })
  })
  onTestFinished(() => {
    spy.mockRestore()
  })
}

export async function saved(onSaved: ReturnType<typeof vi.fn>) {
  await waitFor(() => {
    expect(onSaved).toHaveBeenCalled()
  })
}
