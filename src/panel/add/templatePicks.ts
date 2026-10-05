/**
 * What a template's open parts can be filled with: the instances and sources
 * reporting now, read from the server's self paths, and instances typed in.
 */
import type { TemplatePick } from '../../model/rule'
import type { Slot, Template } from '../../model/template'
import {
  SLOT_PICK_MESSAGE,
  SLOT_PICK_PATTERN,
  INSTANCE_SLOT,
  picked,
  slotsOf
} from '../../templates/instantiate'
import { isInvalid, isRecord, type ListedRule } from '../api'
import type { PathEntry } from '../paths/selfPaths'
import { matchedInstances } from '../signalUnits'

const SLOT_PICK = new RegExp(SLOT_PICK_PATTERN)

/** One way to fill a template's open parts, as the picker lists it. */
export interface Candidate {
  pick: TemplatePick
  /** The instance's or source's name, as the user knows it. */
  label: string
  /** The path the rule would watch. */
  path: string
  /** What the server reports at the path; absent while nothing does. */
  entry?: PathEntry
  /** The name of a rule made from the same template with the same pick. */
  ruleName?: string
  /** Typed by the user rather than found reporting. */
  typed?: true
}

const placeholder = (slot: string) => `\${${slot}}`

/** A template as the user reads it: its rule's name without the slots in it. */
export function templateTitle(template: Template): string {
  const { name } = template.rule
  if (typeof name !== 'string') return template.id
  const stripped = slotsOf(template).reduce(
    (n, slot) => n.replaceAll(placeholder(slot.name), ''),
    name
  )
  return stripped.replace(/\s+/g, ' ').trim()
}

/**
 * The slot of a template with exactly one, which the checkbox picker lists:
 * `open: [instance]`'s or one declared under any name.
 */
export function onlySlot(template: Template): Slot | undefined {
  const slots = slotsOf(template)
  return slots.length === 1 ? slots[0] : undefined
}

/** The path the template's picks are found under: its input's, or the input that carries a slot. */
function openPath(template: Template): string | undefined {
  const { signal } = template.rule
  if (!isRecord(signal)) return undefined
  if (typeof signal.path === 'string') return signal.path
  const inputs = Array.isArray(signal.inputs) ? signal.inputs : []
  const paths = inputs.flatMap((i: unknown) =>
    isRecord(i) && typeof i.path === 'string' ? [i.path] : []
  )
  const slots = slotsOf(template)
  return paths.find((p) => slots.some((slot) => p.includes(placeholder(slot.name)))) ?? paths[0]
}

/** The path picks are found under, as the user reads it: `electrical.batteries.<name>.voltage`. */
export function openPattern(template: Template): string | undefined {
  return slotsOf(template).reduce<string | undefined>(
    (path, slot) => path?.replaceAll(placeholder(slot.name), '<name>'),
    openPath(template)
  )
}

/** The path a pick's rule watches. */
export function watchedPath(template: Template, pick: TemplatePick): string {
  return slotsOf(template).reduce(
    (path, slot) => {
      const value = picked(pick, slot.name)
      return value === undefined ? path : path.replaceAll(placeholder(slot.name), value)
    },
    openPath(template) ?? ''
  )
}

/**
 * An instance's name: the `name` its group reports for it, as the
 * specification has batteries and engines name themselves, else the display
 * name of the path watched, else the path segment.
 */
function instanceLabel(
  group: string,
  instance: string,
  entry: PathEntry | undefined,
  byPath: ReadonlyMap<string, PathEntry>
): string {
  const named = byPath.get(`${group}${instance}.name`)?.value
  if (typeof named === 'string' && named !== '') return named
  return entry?.displayName ?? instance
}

/** A pick's identity: every slot's choice and the source, whatever order its keys come in. */
export function pickKey(pick: TemplatePick): string {
  const entries = Object.entries(pick).filter(([, value]) => value !== undefined)
  return JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * The name of a rule made from this template for the pick. A single-slot
 * template's rule is matched on what it watches now, from the source when
 * one is picked: its pick is only what it was made with, and its path may
 * have been changed since. A template with more slots is matched on the
 * stored pick, since a slot that only a gate uses, such as an engine, does
 * not show in the watched path.
 */
export function ruleWatching(
  setId: string,
  template: Template,
  pick: TemplatePick,
  rules: readonly ListedRule[]
): string | undefined {
  const bySlots = slotsOf(template).length > 1
  const watched = watchedPath(template, pick)
  for (const entry of rules) {
    if (isInvalid(entry)) continue
    const { template: from, signal } = entry.rule
    if (from?.set !== setId || from.id !== template.id) continue
    const covers = bySlots
      ? pickKey(from.pick) === pickKey(pick)
      : signal.paths.includes(watched) && entry.rule.source === pick.source
    if (covers) return entry.rule.name
  }
  return undefined
}

/**
 * The picks a template with at most one slot can be used with now: each
 * instance reporting under its open path, or each source reporting it, or
 * both paired; a template with nothing open has its one rule. Each names the
 * rule it already has from the template, if any. A template with more slots
 * is picked slot by slot instead, and lists nothing here.
 */
export function candidates(
  setId: string,
  template: Template,
  paths: readonly PathEntry[],
  rules: readonly ListedRule[]
): Candidate[] {
  const path = openPath(template)
  if (path === undefined || slotsOf(template).length > 1) return []
  const slot = onlySlot(template)
  const open = template.open ?? []
  const byPath = new Map(paths.map((p) => [p.path, p]))
  const found: Candidate[] = []
  const add = (candidate: Candidate) => {
    const ruleName = ruleWatching(setId, template, candidate.pick, rules)
    found.push(ruleName === undefined ? candidate : { ...candidate, ruleName })
  }
  // The path up to the slot, under which an instance reports its name.
  const group = slot === undefined ? '' : path.slice(0, path.indexOf(placeholder(slot.name)))
  const choices: { named: TemplatePick; instance?: string }[] =
    slot === undefined
      ? [{ named: {} }]
      : matchedInstances(path.replaceAll(placeholder(slot.name), '*'), paths).map((instance) => ({
          named: { [slot.name]: instance },
          instance
        }))
  for (const { named, instance } of choices) {
    const watched = watchedPath(template, named)
    const entry = byPath.get(watched)
    const reported = entry === undefined ? {} : { entry }
    const label =
      instance === undefined
        ? (entry?.displayName ??
          (typeof template.rule.name === 'string' ? template.rule.name : watched))
        : instanceLabel(group, instance, entry, byPath)
    if (!open.includes('source')) {
      add({ pick: named, label, path: watched, ...reported })
      continue
    }
    for (const source of entry?.sources ?? []) {
      const sourceLabel = instance === undefined ? source : `${label} · ${source}`
      add({ pick: { ...named, source }, label: sourceLabel, path: watched, ...reported })
    }
  }
  return found
}

/** Why a typed instance cannot be picked, if it cannot. */
export function instanceError(text: string): string | undefined {
  if (text === '') return 'Type the name used in the path.'
  return SLOT_PICK.test(text) ? undefined : `The name ${SLOT_PICK_MESSAGE}.`
}

/** An instance typed in, for one that does not report yet, naming the rule it already has from the template. */
export function typedCandidate(
  setId: string,
  template: Template,
  instance: string,
  paths: readonly PathEntry[],
  rules: readonly ListedRule[]
): Candidate {
  const pick = { [(onlySlot(template) ?? INSTANCE_SLOT).name]: instance }
  const watched = watchedPath(template, pick)
  const entry = paths.find((p) => p.path === watched)
  const ruleName = ruleWatching(setId, template, pick, rules)
  return {
    pick,
    label: instance,
    path: watched,
    ...(entry === undefined ? {} : { entry }),
    ...(ruleName === undefined ? {} : { ruleName }),
    typed: true
  }
}
