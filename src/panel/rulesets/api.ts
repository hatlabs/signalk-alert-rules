import type { Parameter } from '../../model/ruleset'
import { getJson, isRecord, PLUGIN_ID, sendJson } from '../api'

export type { Parameter }

export interface RulesetNotice {
  at: string
  message: string
}

/** A discovered ruleset with the operator's settings, as `GET /rulesets` answers it. */
export interface RulesetEntry {
  slug: string
  name: string
  version: string
  description?: string
  /** Where it was found: `package <name>` or `file <name>`. */
  source: string
  package?: { name: string; version: string }
  enabled: boolean
  parameters: Parameter[]
  /** The values the operator set, by parameter name; the rest take their defaults. */
  values: Record<string, number | string>
  /** The slugs of its rules. */
  rules: string[]
  /** Paths its rules read that the server has not had since the plugin started. */
  missingPaths: string[]
  notices: RulesetNotice[]
}

/** A ruleset that could not be loaded. */
export interface DiscoveryProblem {
  source: string
  message: string
  /** For a YAML error. */
  line?: number
}

export interface RulesetListing {
  rulesets: RulesetEntry[]
  problems: DiscoveryProblem[]
}

/** The ruleset routes; tests substitute their own. */
export interface RulesetsApi {
  list(): Promise<RulesetListing>
  /** Discovers the rulesets again and applies what changed. */
  rescan(): Promise<RulesetListing>
  setEnabled(slug: string, enabled: boolean): Promise<RulesetEntry>
  /**
   * Replaces the stored values with `values`; a parameter left out takes its
   * default. Refused values reject with RuleRejectedError, whose errors point
   * at `/<name>`, or at `""` for a rule the values make invalid.
   */
  setParameters(slug: string, values: Record<string, number | string>): Promise<RulesetEntry>
  dismissNotices(slug: string): Promise<void>
}

function malformed(what: string): Error {
  return new Error(`unexpected response from ${what}`)
}

/**
 * The panel ships with the server, so a field the server always sends is
 * required here, and an answer without it means the two disagree.
 */
function reader(what: string) {
  const record = (v: unknown): Record<string, unknown> => {
    if (!isRecord(v)) throw malformed(what)
    return v
  }
  const string = (v: unknown): string => {
    if (typeof v !== 'string') throw malformed(what)
    return v
  }
  const list = <T>(v: unknown, item: (i: unknown) => T): T[] => {
    if (!Array.isArray(v)) throw malformed(what)
    return v.map(item)
  }
  const optionalString = (key: string, v: unknown) => (v === undefined ? {} : { [key]: string(v) })
  const nameVersion = (v: unknown) => {
    const r = record(v)
    return { name: string(r.name), version: string(r.version) }
  }
  const boundOf = (key: string, v: unknown) => {
    if (v === undefined) return {}
    if (typeof v !== 'number') throw malformed(what)
    return { [key]: v }
  }
  const parameter = (v: unknown): Parameter => {
    const p = record(v)
    if (p.type !== 'number' && p.type !== 'string') throw malformed(what)
    if (typeof p.default !== 'number' && typeof p.default !== 'string') throw malformed(what)
    return {
      name: string(p.name),
      type: p.type,
      ...optionalString('description', p.description),
      ...optionalString('unit', p.unit),
      default: p.default,
      ...boundOf('minimum', p.minimum),
      ...boundOf('maximum', p.maximum)
    }
  }
  const values = (v: unknown): Record<string, number | string> =>
    Object.fromEntries(
      Object.entries(record(v)).map(([name, value]) => {
        if (typeof value !== 'number' && typeof value !== 'string') throw malformed(what)
        return [name, value]
      })
    )
  const entry = (v: unknown): RulesetEntry => {
    const r = record(v)
    if (typeof r.enabled !== 'boolean') throw malformed(what)
    return {
      slug: string(r.slug),
      name: string(r.name),
      version: string(r.version),
      ...optionalString('description', r.description),
      source: string(r.source),
      ...(r.package === undefined ? {} : { package: nameVersion(r.package) }),
      enabled: r.enabled,
      parameters: list(r.parameters, parameter),
      values: values(r.values),
      rules: list(r.rules, string),
      missingPaths: list(r.missingPaths, string),
      notices: list(r.notices, (n) => {
        const notice = record(n)
        return { at: string(notice.at), message: string(notice.message) }
      })
    }
  }
  const problem = (v: unknown): DiscoveryProblem => {
    const p = record(v)
    return {
      source: string(p.source),
      message: string(p.message),
      ...(typeof p.line === 'number' ? { line: p.line } : {})
    }
  }
  const listing = (v: unknown): RulesetListing => {
    const r = record(v)
    return { rulesets: list(r.rulesets, entry), problems: list(r.problems, problem) }
  }
  return { entry, listing }
}

/** The ruleset routes over HTTP, relative to the admin UI's origin. */
export function httpRulesetsApi(
  fetchFn: typeof fetch = (input, init) => fetch(input, init)
): RulesetsApi {
  const base = `/plugins/${PLUGIN_ID}/rulesets`
  const route = (slug: string, action: string) => `${base}/${encodeURIComponent(slug)}/${action}`
  return {
    list: async () => reader(base).listing(await getJson(fetchFn, base)),
    rescan: async () => {
      const path = `${base}/rescan`
      return reader(path).listing(await sendJson(fetchFn, 'POST', path))
    },
    setEnabled: async (slug, enabled) => {
      const path = route(slug, 'enabled')
      return reader(path).entry(await sendJson(fetchFn, 'PUT', path, { enabled }))
    },
    setParameters: async (slug, values) => {
      const path = route(slug, 'parameters')
      return reader(path).entry(await sendJson(fetchFn, 'PUT', path, values))
    },
    dismissNotices: async (slug) => {
      await sendJson(fetchFn, 'DELETE', route(slug, 'notices'))
    }
  }
}
