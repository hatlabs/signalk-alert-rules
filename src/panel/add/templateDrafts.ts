/**
 * The unsaved rules a template's picks make, one editor tab each, and what
 * the tabs share.
 */
import type { Rule, TemplatePick } from '../../model/rule'
import type { Template } from '../../model/template'
import { instantiate } from '../../templates/instantiate'
import type { FieldError } from '../api'
import {
  fromRule,
  marginUnnamed,
  signalShape,
  standingRetypes,
  toRule,
  type RuleForm
} from '../editor/formModel'
import { fieldLabel, marginsHint, whatStops } from '../editor/sections'
import { joined } from '../editor/words'
import { capitalised } from '../list/PriorityBadge'
import { signalMeasure, type UnitLookup } from '../signalUnits'

export interface Draft {
  pick: TemplatePick
  form: RuleForm
}

/**
 * The form of each rule the picks make, as the editor shows it, with slugs
 * no rule in `taken` has and none another draft has. A pick the template
 * cannot take, such as one read from a link that was edited, makes none.
 */
export function drafts(
  set: { id: string; version: string },
  template: Template,
  picks: readonly TemplatePick[],
  taken: ReadonlySet<string>,
  units: UnitLookup
): Draft[] {
  const slugs = new Set(taken)
  return picks.flatMap((pick) => {
    const made = instantiate(set, template, pick, slugs)
    if (!made.ok) return []
    const form = fromRule(made.value as Rule, units)
    slugs.add(form.slug)
    return [{ pick, form }]
  })
}

/**
 * `to` with the settings of `from` that the picks share: what should alert,
 * its steps, how long it must hold and the rest of the detector, and
 * latching. Its name, message, condition name, value and source stay its
 * own, as do its "only while" conditions, which watch the picked instance.
 *
 * A pick that reports nothing yet shows its values in SI while another shows
 * them in display units, so across units the values are converted through
 * the rule `from` makes; while it cannot be read, nothing is copied.
 */
export function copySettings(
  from: RuleForm,
  to: RuleForm,
  units: UnitLookup
): RuleForm | undefined {
  const measure = (form: RuleForm) => signalMeasure(signalShape(form.signal), units)
  if (JSON.stringify(measure(from)) === JSON.stringify(measure(to))) {
    const copy = structuredClone({ detector: from.detector, steps: from.steps })
    return { ...to, ...copy, latching: from.latching }
  }
  const slot = to.signal.slots.at(0)
  const read = toRule(from, units)
  if (!read.ok || to.signal.mode !== 'single' || slot === undefined) return undefined
  const signal = { path: slot.path, ...(slot.source === '' ? {} : { source: slot.source }) }
  const moved = fromRule({ ...read.rule, signal }, units)
  return {
    ...to,
    detector: moved.detector,
    steps: moved.steps,
    latching: moved.latching
  }
}

export interface TabErrors {
  /** The tab's name: its pick, as the user knows it. */
  label: string
  form: RuleForm
  errors: readonly FieldError[]
  /** The clear margins whose note a footer has named; see `saveHint`. */
  named?: ReadonlySet<string>
}

/**
 * What stops Save, naming each tab: "Fill in the limit on windlass to save.",
 * then each tab's clear margins a change of unit emptied, as `saveHint` does.
 */
export function tabsHint(tabs: readonly TabErrors[]): string | undefined {
  const parts = tabs.flatMap((tab) => {
    const stops = whatStops(tab.errors, tab.form)
    return stops === undefined ? [] : [`${stops} on ${tab.label}`]
  })
  const retypes = tabs.map((tab) => ({ tab, notes: standingRetypes(tab.form, tab.errors) }))
  const margins = marginsHint(
    retypes.flatMap(({ tab, notes }) => [
      ...new Set(notes.map((e) => `${fieldLabel(e.path, tab.form)} on ${tab.label}`))
    ]),
    parts.length === 0 &&
      retypes.every(({ tab, notes }) => !marginUnnamed(notes, tab.named ?? new Set()))
  )
  const sentences = [
    ...(parts.length === 0 ? [] : [capitalised(`${joined(parts)} to save.`)]),
    ...margins
  ]
  return sentences.length === 0 ? undefined : sentences.join(' ')
}
