/**
 * What a template's open parts can be filled with: the instances and sources
 * reporting now, read from the server's self paths, and instances typed in.
 */
import type { TemplatePick } from '../../model/rule'
import type { Slot, Template } from '../../model/template'
import {
  SLOT_PICK_MESSAGE,
  SLOT_PICK_PATTERN,
  SOURCE_PICK,
  picked,
  slotsOf
} from '../../templates/instantiate'
import { isInvalid, isRecord, type ListedRule } from '../api'
import type { PathEntry } from '../paths/selfPaths'
import { matchedInstances, matchesPattern } from '../signalUnits'

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

/** Whether a slot shows in the path the template's rule watches. */
function inWatchedPath(template: Template, slot: Slot): boolean {
  return openPath(template)?.includes(placeholder(slot.name)) ?? false
}

/** The slots in the path the template's rule watches, whose choices decide its sources. */
export function watchedSlots(template: Template): Slot[] {
  return slotsOf(template).filter((slot) => inWatchedPath(template, slot))
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
 * The name of a rule made from this template for the pick. A template whose
 * one slot is in the watched path is matched on what its rule watches now,
 * from the source when one is picked: its pick is only what it was made
 * with, and its path may have been changed since. Any other template is
 * matched on the stored pick, since a slot that only a gate uses, such as an
 * engine, does not show in the watched path.
 */
export function ruleWatching(
  setId: string,
  template: Template,
  pick: TemplatePick,
  rules: readonly ListedRule[]
): string | undefined {
  const slots = slotsOf(template)
  const bySlots = slots.length > 1 || slots.some((slot) => !inWatchedPath(template, slot))
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
  const choices: { named: TemplatePick; instance?: string; found?: SlotCandidate }[] =
    slot === undefined
      ? [{ named: {} }]
      : inWatchedPath(template, slot)
        ? matchedInstances(path.replaceAll(placeholder(slot.name), '*'), paths).map((instance) => ({
            named: { [slot.name]: instance },
            instance
          }))
        : // A slot only a gate or zone path uses: the instances reporting those.
          slotCandidates(template, slot.name, paths).map((found) => ({
            named: { [slot.name]: found.instance },
            instance: found.instance,
            found
          }))
  for (const { named, instance, found: slotFound } of choices) {
    const watched = watchedPath(template, named)
    const entry = slotFound === undefined ? byPath.get(watched) : slotFound.entry
    const reported = entry === undefined ? {} : { entry }
    const label =
      instance === undefined
        ? (entry?.displayName ??
          (typeof template.rule.name === 'string' ? template.rule.name : watched))
        : (slotFound?.label ?? instanceLabel(group, instance, entry, byPath))
    if (!open.includes('source')) {
      add({ pick: named, label, path: watched, ...reported })
      continue
    }
    // The source is pinned on the signal, so it is one the watched path reports.
    for (const source of byPath.get(watched)?.sources ?? []) {
      const sourceLabel = instance === undefined ? source : `${label} · ${source}`
      add({ pick: { ...named, source }, label: sourceLabel, path: watched, ...reported })
    }
  }
  return found
}

/** One instance a slot can be filled with, as a row of the picker lists it. */
export interface SlotCandidate {
  /** The slot's pick: the path segment. */
  instance: string
  /** The instance's name, as the user knows it. */
  label: string
  /** The first path using the slot that the instance reports; absent for a typed one. */
  entry?: PathEntry
  /** Typed by the user rather than found reporting. */
  typed?: true
}

/** Every string under a `path` key, in the order the document has them. */
function pathsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(pathsIn)
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'path' && typeof child === 'string' ? [child] : pathsIn(child)
  )
}

/**
 * The paths a slot is a segment of: the signal's first, so an instance shows
 * the value its rule watches when it reports that, then the gates' and the
 * zone limit's.
 */
function slotPaths(template: Template, slot: string): string[] {
  const { signal, ...rest } = template.rule
  const using = [...pathsIn(signal), ...pathsIn(rest)].filter((path) =>
    path.split('.').includes(placeholder(slot))
  )
  return [...new Set(using)]
}

/** The first path a slot is in, as the user reads it: `propulsion.<name>.revolutions`. */
export function slotPattern(template: Template, slot: string): string {
  return slotsOf(template).reduce(
    (path, s) => path.replaceAll(placeholder(s.name), '<name>'),
    slotPaths(template, slot)[0] ?? ''
  )
}

/**
 * What one slot of a template can be filled with: each instance reporting any
 * path the slot is in, showing that path's value, sorted by name; then each
 * typed name nothing reports, in the order typed. Other slots in the same
 * path match any segment.
 */
export function slotCandidates(
  template: Template,
  slot: string,
  paths: readonly PathEntry[],
  typed: readonly string[] = []
): SlotCandidate[] {
  const byPath = new Map(paths.map((p) => [p.path, p]))
  const slotted = new Set(slotsOf(template).map((s) => placeholder(s.name)))
  const found = new Map<string, SlotCandidate>()
  for (const pattern of slotPaths(template, slot)) {
    const parts = pattern.split('.')
    const at = parts.indexOf(placeholder(slot))
    const wildcard = parts.map((part) => (slotted.has(part) ? '*' : part)).join('.')
    for (const entry of paths) {
      if (!matchesPattern(wildcard, entry.path)) continue
      const segments = entry.path.split('.')
      const instance = segments[at]
      if (found.has(instance)) continue
      const group = segments
        .slice(0, at)
        .map((s) => `${s}.`)
        .join('')
      found.set(instance, { instance, label: instanceLabel(group, instance, entry, byPath), entry })
    }
  }
  const reporting = [...found.values()].sort((a, b) =>
    a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0
  )
  const notReporting = [...new Set(typed)]
    .filter((instance) => !found.has(instance))
    .map((instance): SlotCandidate => ({ instance, label: instance, typed: true }))
  return [...reporting, ...notReporting]
}

/**
 * Whether every slot's choice reports a path the slot is in, with every
 * slot of that path filled in, so two slots of one path report as the pair
 * picked. The engine of a battery-and-engine pick shows only in a gate, so the
 * watched path alone cannot tell a row with a silent engine from one that
 * reports.
 */
export function pickReports(
  template: Template,
  pick: TemplatePick,
  paths: readonly PathEntry[]
): boolean {
  const slots = slotsOf(template)
  if (slots.some((slot) => picked(pick, slot.name) === undefined)) return false
  const filled = (path: string) =>
    slots.reduce(
      (p, slot) => p.replaceAll(placeholder(slot.name), picked(pick, slot.name) ?? ''),
      path
    )
  return slots.every((slot) =>
    slotPaths(template, slot.name).some((path) =>
      paths.some((entry) => matchesPattern(filled(path), entry.path))
    )
  )
}

/**
 * What of a pick from a link or an earlier visit a template's rows can show:
 * each slot's choice that is one path segment, and the source when the
 * template leaves it open. A key the template does not leave open would be
 * hidden in its row and refused on Continue.
 */
export function restoredPick(template: Template, pick: TemplatePick): TemplatePick {
  const restored: TemplatePick = {}
  for (const slot of slotsOf(template)) {
    const value = picked(pick, slot.name)
    if (value !== undefined && SLOT_PICK.test(value)) restored[slot.name] = value
  }
  const source = picked(pick, SOURCE_PICK)
  if (source !== undefined && template.open?.includes(SOURCE_PICK) === true)
    restored[SOURCE_PICK] = source
  return restored
}

/** Why a typed instance cannot be picked, if it cannot. */
export function instanceError(text: string): string | undefined {
  if (text === '') return 'Type the name used in the path.'
  return SLOT_PICK.test(text) ? undefined : `The name ${SLOT_PICK_MESSAGE}.`
}

/**
 * An instance typed in for a template's one slot, for one that does not
 * report yet, naming the rule it already has from the template.
 */
export function typedCandidate(
  setId: string,
  template: Template,
  slot: Slot,
  instance: string,
  paths: readonly PathEntry[],
  rules: readonly ListedRule[]
): Candidate {
  const pick = { [slot.name]: instance }
  const watched = watchedPath(template, pick)
  const entry = inWatchedPath(template, slot)
    ? paths.find((p) => p.path === watched)
    : slotCandidates(template, slot.name, paths).find((c) => c.instance === instance)?.entry
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
