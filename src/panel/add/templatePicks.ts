/**
 * What a template's open parts can be filled with: the instances and sources
 * reporting now, read from the server's self paths, and instances typed in.
 */
import type { TemplatePick } from '../../model/rule'
import type { Template } from '../../model/template'
import {
  INSTANCE_PICK_MESSAGE,
  INSTANCE_PICK_PATTERN,
  INSTANCE_PLACEHOLDER
} from '../../templates/instantiate'
import { isInvalid, isRecord, type ListedRule } from '../api'
import type { PathEntry } from '../paths/selfPaths'
import { matchedInstances } from '../signalUnits'

const PLACEHOLDER = `\${${INSTANCE_PLACEHOLDER}}`
const INSTANCE_PICK = new RegExp(INSTANCE_PICK_PATTERN)

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

/** A template as the user reads it: its rule's name without the instance in it. */
export function templateTitle(template: Template): string {
  const { name } = template.rule
  if (typeof name !== 'string') return template.id
  return name.replaceAll(PLACEHOLDER, '').replace(/\s+/g, ' ').trim()
}

/** The path the template's picks are found under: its input's, or the input that carries the instance. */
function openPath(template: Template): string | undefined {
  const { signal } = template.rule
  if (!isRecord(signal)) return undefined
  if (typeof signal.path === 'string') return signal.path
  const inputs = Array.isArray(signal.inputs) ? signal.inputs : []
  const paths = inputs.flatMap((i: unknown) =>
    isRecord(i) && typeof i.path === 'string' ? [i.path] : []
  )
  return paths.find((p) => p.includes(PLACEHOLDER)) ?? paths[0]
}

/** The path picks are found under, as the user reads it: `electrical.batteries.<name>.voltage`. */
export function openPattern(template: Template): string | undefined {
  return openPath(template)?.replaceAll(PLACEHOLDER, '<name>')
}

const withInstance = (path: string, instance: string) => path.replaceAll(PLACEHOLDER, instance)

/**
 * An instance's name: the `name` its group reports for it, as the
 * specification has batteries and engines name themselves, else the display
 * name of the path watched, else the path segment.
 */
function instanceLabel(
  pattern: string,
  instance: string,
  entry: PathEntry | undefined,
  byPath: ReadonlyMap<string, PathEntry>
): string {
  const at = pattern.indexOf(PLACEHOLDER)
  const named = byPath.get(`${pattern.slice(0, at)}${instance}.name`)?.value
  if (typeof named === 'string' && named !== '') return named
  return entry?.displayName ?? instance
}

export function pickKey(pick: TemplatePick): string {
  return JSON.stringify([pick.instance ?? null, pick.source ?? null])
}

/**
 * The name of a rule made from this template that watches the path, from
 * the source when one is picked. Matched on what the rule watches now: its
 * pick is only what it was made with, and its path may have been changed since.
 */
export function ruleWatching(
  setId: string,
  template: Template,
  watched: string,
  source: string | undefined,
  rules: readonly ListedRule[]
): string | undefined {
  for (const entry of rules) {
    if (isInvalid(entry)) continue
    const { template: from, signal } = entry.rule
    if (
      from?.set === setId &&
      from.id === template.id &&
      signal.paths.includes(watched) &&
      entry.rule.source === source
    )
      return entry.rule.name
  }
  return undefined
}

/**
 * The picks the template can be used with now: each instance reporting under
 * its open path, or each source reporting it, or both paired; a template
 * with nothing open has its one rule. Each names the rule it already has
 * from the template, if any.
 */
export function candidates(
  setId: string,
  template: Template,
  paths: readonly PathEntry[],
  rules: readonly ListedRule[]
): Candidate[] {
  const path = openPath(template)
  if (path === undefined) return []
  const open = template.open ?? []
  const byPath = new Map(paths.map((p) => [p.path, p]))
  const found: Candidate[] = []
  const add = (candidate: Candidate) => {
    const { path: watched, pick } = candidate
    const ruleName = ruleWatching(setId, template, watched, pick.source, rules)
    found.push(ruleName === undefined ? candidate : { ...candidate, ruleName })
  }
  const instances = open.includes('instance')
    ? matchedInstances(path.replaceAll(PLACEHOLDER, '*'), paths)
    : [undefined]
  for (const instance of instances) {
    const watched = instance === undefined ? path : withInstance(path, instance)
    const entry = byPath.get(watched)
    const reported = entry === undefined ? {} : { entry }
    const label =
      instance === undefined
        ? (entry?.displayName ??
          (typeof template.rule.name === 'string' ? template.rule.name : watched))
        : instanceLabel(path, instance, entry, byPath)
    const named = instance === undefined ? {} : { instance }
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
  return INSTANCE_PICK.test(text) ? undefined : `The name ${INSTANCE_PICK_MESSAGE}.`
}

/** An instance typed in, for one that does not report yet. */
export function typedCandidate(
  template: Template,
  instance: string,
  paths: readonly PathEntry[]
): Candidate {
  const watched = withInstance(openPath(template) ?? '', instance)
  const entry = paths.find((p) => p.path === watched)
  return {
    pick: { instance },
    label: instance,
    path: watched,
    ...(entry === undefined ? {} : { entry }),
    typed: true
  }
}
