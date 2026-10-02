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
 * - Add rule: `#add`; its two ways to start: `#add=template` and `#add=path`
 */
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
  return from === 'template' || from === 'path' ? { kind: 'add', from } : LIST
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
    case 'add':
      return route.from === undefined ? 'add' : `add=${route.from}`
  }
}

/** The location hash with the panel's route replaced by `route`. */
export function hashWithRoute(hash: string, route: Route): string {
  const { prefix } = split(hash)
  const fragment = fragmentOf(route)
  if (fragment === undefined) return prefix === '' ? '#' : prefix
  return `${prefix}#${fragment}`
}
