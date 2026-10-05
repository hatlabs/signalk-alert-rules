/**
 * The admin UI routes with its own hash (a HashRouter), so the panel's route
 * rides as a second fragment after it, as in
 * `#/e/signalk_alert_rules#rule=<slug>&instance=<name>`. The router reads the
 * second fragment as the route's hash and leaves the page mounted. Every part
 * is percent-encoded, so a literal `&` only separates parameters.
 *
 * - the list: no fragment
 * - a rule: `#rule=<slug>`, optionally with `&instance=<name>`
 * - the editor of a rule: `#edit=<slug>`
 * - Add rule: `#add`; its two ways to start: `#add=template` and `#add=path`,
 *   which goes on with the value chosen, `&path=<path>`, and then what should
 *   alert, `&when=<kind>`
 * - From a template goes on with the set, `&set=<id>`, the template,
 *   `&template=<id>`, the picks as a JSON list, `&picks=<json>`, and then
 *   the rules they make, `&step=edit`
 */
import type { TemplatePick } from '../model/rule'
import { isPickKey, isRecord } from './api'
import { CONDITION_KINDS, type ConditionKind } from './editor/conditionKinds'

export type Route =
  | { kind: 'list' }
  | {
      kind: 'rule'
      slug: string
      /** An instance of a wildcard rule, by its name or its alert path segment. */
      instance?: string
    }
  | { kind: 'edit'; slug: string }
  | AddRoute

export interface AddRoute {
  kind: 'add'
  from?: 'template' | 'path'
  /** From a path: the value chosen. */
  path?: string
  /** From a path: what should alert, once the value is chosen. */
  when?: ConditionKind
  /** From a template: the template set chosen. */
  set?: string
  /** From a template: the template chosen from the set. */
  template?: string
  /** From a template: each rule's picks, keyed by slot name and `source`. */
  picks?: TemplatePick[]
  /** From a template: the picks made, the rules they make are edited. */
  step?: 'edit'
}

/** A list of picks as the route carries it; anything else is no picks. */
function picksOf(json: string | undefined): TemplatePick[] | undefined {
  if (json === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const picks: TemplatePick[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const entries = Object.entries(item)
    if (!entries.every(([key, v]) => isPickKey(key) && typeof v === 'string')) return undefined
    picks.push(Object.fromEntries(entries) as TemplatePick)
  }
  return picks
}

function templateRoute(params: Map<string, string>): AddRoute {
  const set = params.get('set')
  if (set === undefined) return { kind: 'add', from: 'template' }
  const template = params.get('template')
  if (template === undefined) return { kind: 'add', from: 'template', set }
  const picks = picksOf(params.get('picks'))
  if (picks === undefined || picks.length === 0)
    return { kind: 'add', from: 'template', set, template }
  const step = params.get('step') === 'edit' ? { step: 'edit' as const } : {}
  return { kind: 'add', from: 'template', set, template, picks, ...step }
}

function conditionKind(value: string | undefined): ConditionKind | undefined {
  return CONDITION_KINDS.find((k) => k.kind === value)?.kind
}

const LIST: Route = { kind: 'list' }

/** Where the panel's fragment starts: a `#` with one of its keys after it. */
const PANEL_FRAGMENT = /#(?=(?:rule|edit|add)(?:[=&]|$))/

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

function split(hash: string): { prefix: string; fragment?: string } {
  const match = PANEL_FRAGMENT.exec(hash)
  if (match === null) return { prefix: hash }
  return { prefix: hash.slice(0, match.index), fragment: hash.slice(match.index + 1) }
}

/** The non-empty, decoded parameters of a fragment, the first one's under its own key. */
function parameters(fragment: string): Map<string, string> {
  const params = new Map<string, string>()
  for (const part of fragment.split('&')) {
    const at = part.indexOf('=')
    const key = at < 0 ? part : part.slice(0, at)
    const value = at < 0 ? '' : decode(part.slice(at + 1))
    if (value !== undefined && value !== '' && !params.has(key)) params.set(key, value)
  }
  return params
}

/** The route a location hash points at; one the panel cannot read is the list. */
export function parseRoute(hash: string): Route {
  const { fragment } = split(hash)
  if (fragment === undefined) return LIST
  const params = parameters(fragment)
  const optional = <K extends string>(key: K): Partial<Record<K, string>> => {
    const value = params.get(key)
    return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, string>>)
  }
  if (fragment.startsWith('rule')) {
    const slug = params.get('rule')
    return slug === undefined ? LIST : { kind: 'rule', slug, ...optional('instance') }
  }
  if (fragment.startsWith('edit')) {
    const slug = params.get('edit')
    return slug === undefined ? LIST : { kind: 'edit', slug }
  }
  const from = params.get('add')
  if (from === undefined) return { kind: 'add' }
  if (from === 'template') return templateRoute(params)
  if (from !== 'path') return LIST
  const path = params.get('path')
  if (path === undefined) return { kind: 'add', from }
  const when = conditionKind(params.get('when'))
  return { kind: 'add', from, path, ...(when === undefined ? {} : { when }) }
}

function fragmentOf(route: Route): string | undefined {
  const param = (key: string, value: string | undefined) =>
    value === undefined ? '' : `&${key}=${encodeURIComponent(value)}`
  switch (route.kind) {
    case 'list':
      return undefined
    case 'rule':
      return `rule=${encodeURIComponent(route.slug)}${param('instance', route.instance)}`
    case 'edit':
      return `edit=${encodeURIComponent(route.slug)}`
    case 'add': {
      if (route.from === undefined) return 'add'
      const picks = route.picks === undefined ? undefined : JSON.stringify(route.picks)
      return [
        `add=${route.from}`,
        param('path', route.path),
        param('when', route.when),
        param('set', route.set),
        param('template', route.template),
        param('picks', picks),
        param('step', route.step)
      ].join('')
    }
  }
}

/** The location hash with the panel's route replaced by `route`. */
export function hashWithRoute(hash: string, route: Route): string {
  const { prefix } = split(hash)
  const fragment = fragmentOf(route)
  if (fragment === undefined) return prefix === '' ? '#' : prefix
  return `${prefix}#${fragment}`
}
