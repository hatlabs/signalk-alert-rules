/**
 * The unsaved rules a template's picks make, one editor tab each, and what
 * the tabs share.
 */
import type { Rule, TemplatePick } from '../../model/rule'
import type { Template } from '../../model/template'
import { instantiate } from '../../templates/instantiate'
import type { FieldError } from '../api'
import { fromRule, signalShape, toRule, type RuleForm } from '../editor/formModel'
import { whatStops } from '../editor/sections'
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
    return { ...to, ...copy, latching: from.latching, shown: { ...to.shown, ...from.shown } }
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
    latching: moved.latching,
    shown: { ...to.shown, ...moved.shown }
  }
}

export interface TabErrors {
  /** The tab's name: its pick, as the user knows it. */
  label: string
  form: RuleForm
  errors: readonly FieldError[]
}

/** What stops Save, naming each tab: "Fill in the limit on windlass to save." */
export function tabsHint(tabs: readonly TabErrors[]): string | undefined {
  const parts = tabs.flatMap((tab) => {
    const stops = whatStops(tab.errors, tab.form)
    return stops === undefined ? [] : [`${stops} on ${tab.label}`]
  })
  return parts.length === 0 ? undefined : capitalised(`${joined(parts)} to save.`)
}
