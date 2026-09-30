/**
 * The admin UI routes with its own hash (a HashRouter), so the panel's rule
 * reference rides as a second fragment after it:
 * `#/apps/configuration/signalk-alert-rules#rule=<origin>/<slug>`, optionally
 * followed by `&instance=<name>`. The router reads the second fragment as the
 * route's hash and leaves the page mounted.
 */
const MARKER = '#rule='
const INSTANCE = 'instance='

export interface RuleRef {
  origin: string
  slug: string
  /** An instance of a wildcard rule, by its name or its alert path segment. */
  instance?: string
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

/** The rule a location hash points at, if any. */
export function parseRuleFragment(hash: string): RuleRef | undefined {
  const at = hash.indexOf(MARKER)
  if (at < 0) return undefined
  // Every part is percent-encoded, so a literal `&` only separates parameters.
  const [ref, ...params] = hash.slice(at + MARKER.length).split('&')
  // A slug has no slash; a scoped package origin may, so split at the last one.
  const cut = ref.lastIndexOf('/')
  if (cut < 0) return undefined
  const origin = decode(ref.slice(0, cut))
  const slug = decode(ref.slice(cut + 1))
  if (origin === undefined || slug === undefined || origin === '' || slug === '') return undefined
  const param = params.find((p) => p.startsWith(INSTANCE))
  const instance = param === undefined ? undefined : decode(param.slice(INSTANCE.length))
  return instance === undefined || instance === '' ? { origin, slug } : { origin, slug, instance }
}

/** The location hash with the rule reference replaced by `ref`, or removed. */
export function hashWithRule(hash: string, ref?: RuleRef): string {
  const at = hash.indexOf(MARKER)
  const route = at < 0 ? hash : hash.slice(0, at)
  if (ref === undefined) return route === '' ? '#' : route
  const rule = `${route}${MARKER}${encodeURIComponent(ref.origin)}/${encodeURIComponent(ref.slug)}`
  return ref.instance === undefined
    ? rule
    : `${rule}&${INSTANCE}${encodeURIComponent(ref.instance)}`
}
