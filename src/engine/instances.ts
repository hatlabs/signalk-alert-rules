import { sanitiseSegment } from '../alerts/paths.js'
import { MAX_INSTANCES } from '../model/rule.js'

/**
 * The segment a single-wildcard pattern's `*` stands for in `path`, or
 * undefined when the path does not match. The wildcard spans exactly one
 * segment, unlike the server's subscription matcher.
 */
export function instanceIn(pattern: string, path: string): string | undefined {
  const expected = pattern.split('.')
  const actual = path.split('.')
  if (actual.length !== expected.length) return undefined
  let instance: string | undefined
  for (const [i, segment] of expected.entries()) {
    const got = actual[i] ?? ''
    if (segment === '*') instance = got
    else if (segment !== got) return undefined
  }
  return instance === '' ? undefined : instance
}

export type Admission = { ok: true; segment: string } | { ok: false; reason: string }

/** The instances of one wildcard signal, bounded and with distinct alert path segments. */
export class InstanceRegistry {
  private readonly bySegment = new Map<string, string>()
  private readonly admitted = new Map<string, string>()

  admit(name: string): Admission {
    const known = this.admitted.get(name)
    if (known !== undefined) return { ok: true, segment: known }
    const segment = sanitiseSegment(name)
    const holder = this.bySegment.get(segment)
    if (holder !== undefined) {
      return {
        ok: false,
        reason: `instance "${name}" has the same alert path segment "${segment}" as "${holder}"`
      }
    }
    if (this.admitted.size >= MAX_INSTANCES) {
      return {
        ok: false,
        reason: `instance "${name}" ignored: at most ${String(MAX_INSTANCES)} instances per rule`
      }
    }
    this.admitted.set(name, segment)
    this.bySegment.set(segment, name)
    return { ok: true, segment }
  }
}
