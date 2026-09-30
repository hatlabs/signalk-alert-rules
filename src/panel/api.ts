import { BADGES, SUB_LABELS, type Badge, type SubLabel } from '../alerts/badge'

export { BADGES, SUB_LABELS, type Badge, type SubLabel }

/** The plugin id, which is also the path segment of its routes. */
export const PLUGIN_ID = 'signalk-alert-rules'

const PLUGIN_BASE = `/plugins/${PLUGIN_ID}`

/**
 * A request that hangs, as on a tablet that lost its Wi-Fi, would otherwise
 * hold up polling and show stale data as current.
 */
export const REQUEST_TIMEOUT_MS = 10_000

/** The evaluation switch; off, no rule is evaluated and SKAR holds no alert. */
export interface Evaluation {
  enabled: boolean
}

/** `GET /state`, as docs/api.md describes it. */
export interface PluginState {
  running: boolean
  error?: string
  securityEnabled: boolean | null
  /** Present while the plugin runs. */
  evaluation?: Evaluation
  /**
   * Present while the plugin runs: problems found while loading the data
   * directory, such as a stored rule that no longer validates and so is not
   * listed.
   */
  issues?: string[]
}

export type InputState = 'value' | 'unavailable' | 'neverSeen'

export interface Position {
  latitude: number
  longitude: number
}

/** A signal's value in SI units. */
export type SignalValue = number | string | boolean | Position

export type SuppressionScope =
  { scope: 'rule'; autoEndAfter?: number } | { scope: 'input'; path: string; autoEndAfter?: number }

export type Progress =
  | { kind: 'timer'; toward: 'set' | 'clear'; elapsed: number; target: number }
  | { kind: 'events'; count: number; limit: number }
  | { kind: 'total'; total: number; limit: number }

export interface GateStatus {
  holds: boolean
  input: InputState
}

/** One instance's status, as docs/rules.md "Status" describes it. */
export interface InstanceStatus {
  /** For a wildcard rule; a rule that is not evaluated keeps only the segment. */
  instance?: { name?: string; segment: string }
  badge: Badge
  reason?: string
  suppression?: SuppressionScope
  subLabels: SubLabel[]
  /** Absent on the rows of a rule that is not evaluated. */
  active?: boolean
  input?: InputState
  value?: SignalValue
  limit?: number
  progress?: Progress
  gates: GateStatus[]
  level?: string
  priority?: string
}

export interface RuleStatus {
  badge: Badge
  reason?: string
  suppression?: SuppressionScope
  subLabels: SubLabel[]
  errors: string[]
  issues: string[]
  instances: InstanceStatus[]
}

/** The parts of a rule the rule list and detail view show. */
export interface RuleInfo {
  name: string
  /** Absent for a zone limit, whose levels set the priority. */
  priority?: string
  detector: { type: string; direction?: string; measure?: string; zoneLevel?: string }
  /** The paths the signal reads; several, with the combinator, for a combined signal. */
  signal: { paths: string[]; combinator?: string }
  gates: { paths: string[] }[]
}

export interface RuleSuppression {
  since: string
  actor: string
  note?: string
  autoEndAfter?: number
}

/** A rule entry, as `GET /rules` answers it. */
export interface RuleEntry {
  origin: string
  slug: string
  rule: RuleInfo
  enabled: boolean
  note?: string
  /** The rule's own suppression; an input suppression shows in the status only. */
  suppression?: RuleSuppression
  status: RuleStatus
}

/** What the panel asks of the server; tests substitute their own. */
export interface PanelApi {
  state(): Promise<PluginState>
  /**
   * Whether the plugin is enabled in the server's plugin settings. The
   * server answers this on the plugin's own route root, whether or not the
   * plugin is running (signalk-server src/interfaces/plugins.ts, the
   * router's `GET /`).
   */
  pluginEnabled(): Promise<boolean>
  rules(): Promise<RuleEntry[]>
  /** Clears the rule's active alerts and sets its accumulator totals to zero. */
  resetAccumulator(origin: string, slug: string): Promise<RuleEntry>
  /** Off clears every alert SKAR owns and stops evaluating; on starts every rule afresh. */
  setEvaluation(enabled: boolean): Promise<Evaluation>
}

/**
 * The server refused the admin UI's session. Polling cannot recover from
 * this; the operator has to log in again.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('the session has expired')
    this.name = 'SessionExpiredError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(what: string): Error {
  return new Error(`unexpected response from ${what}`)
}

function parseEvaluation(body: unknown, what: string): Evaluation {
  if (!isRecord(body) || typeof body.enabled !== 'boolean') throw malformed(what)
  return { enabled: body.enabled }
}

export function parseState(body: unknown): PluginState {
  if (!isRecord(body) || typeof body.running !== 'boolean') throw malformed('/state')
  const { running, error, securityEnabled, evaluation, issues } = body
  if (
    issues !== undefined &&
    !(Array.isArray(issues) && issues.every((i): i is string => typeof i === 'string'))
  ) {
    throw malformed('/state')
  }
  return {
    running,
    ...(typeof error === 'string' ? { error } : {}),
    securityEnabled: typeof securityEnabled === 'boolean' ? securityEnabled : null,
    ...(evaluation === undefined ? {} : { evaluation: parseEvaluation(evaluation, '/state') }),
    ...(issues === undefined ? {} : { issues })
  }
}

/**
 * The server answers `enabledByDefault || options.enabled`, which is undefined
 * for a plugin that was never configured, so JSON leaves the flag out.
 */
function parseEnabled(body: unknown): boolean {
  if (!isRecord(body)) throw malformed('the plugin route')
  if (body.enabled === undefined) return false
  if (typeof body.enabled !== 'boolean') throw malformed('the plugin route')
  return body.enabled
}

/** `{ key: value }`, or nothing when the value is absent, for spreading into an object. */
function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, T>>)
}

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)

const inputState = (v: unknown): InputState | undefined =>
  v === 'value' || v === 'unavailable' || v === 'neverSeen' ? v : undefined

function suppressionScope(v: unknown): SuppressionScope | undefined {
  if (!isRecord(v)) return undefined
  const autoEnd = optional('autoEndAfter', num(v.autoEndAfter))
  if (v.scope === 'rule') return { scope: 'rule', ...autoEnd }
  if (v.scope === 'input' && typeof v.path === 'string') {
    return { scope: 'input', path: v.path, ...autoEnd }
  }
  return undefined
}

function signalValue(v: unknown): SignalValue | undefined {
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  if (isRecord(v) && typeof v.latitude === 'number' && typeof v.longitude === 'number') {
    return { latitude: v.latitude, longitude: v.longitude }
  }
  return undefined
}

function progressOf(v: unknown): Progress | undefined {
  if (!isRecord(v)) return undefined
  const elapsed = num(v.elapsed)
  const target = num(v.target)
  const count = num(v.count)
  const limit = num(v.limit)
  const total = num(v.total)
  const toward = v.toward === 'set' || v.toward === 'clear' ? v.toward : undefined
  if (v.kind === 'timer' && toward && elapsed !== undefined && target !== undefined) {
    return { kind: 'timer', toward, elapsed, target }
  }
  if (v.kind === 'events' && count !== undefined && limit !== undefined) {
    return { kind: 'events', count, limit }
  }
  if (v.kind === 'total' && total !== undefined && limit !== undefined) {
    return { kind: 'total', total, limit }
  }
  return undefined
}

function ruleSuppression(v: unknown): RuleSuppression | undefined {
  if (!isRecord(v) || typeof v.since !== 'string' || typeof v.actor !== 'string') return undefined
  return {
    since: v.since,
    actor: v.actor,
    ...optional('note', text(v.note)),
    ...optional('autoEndAfter', num(v.autoEndAfter))
  }
}

/**
 * Reads one rule entry. The panel ships in the same package as the server, so
 * a field the server always sends and the panel relies on is required, and an
 * entry without it means the two disagree; optional fields are kept only when
 * well formed.
 */
export function parseRuleEntry(body: unknown, what: string): RuleEntry {
  const record = (v: unknown): Record<string, unknown> => {
    if (!isRecord(v)) throw malformed(what)
    return v
  }
  const string = (v: unknown): string => {
    if (typeof v !== 'string') throw malformed(what)
    return v
  }
  const strings = (v: unknown): string[] => {
    if (!Array.isArray(v)) throw malformed(what)
    return v.map(string)
  }
  const badge = (v: unknown): Badge => {
    const found = BADGES.find((b) => b === v)
    if (found === undefined) throw malformed(what)
    return found
  }
  const subLabel = (v: unknown): SubLabel => {
    const found = SUB_LABELS.find((l) => l === v)
    if (found === undefined) throw malformed(what)
    return found
  }
  const gates = (v: unknown): GateStatus[] =>
    (Array.isArray(v) ? v : []).map((g) => {
      const gate = record(g)
      const input = inputState(gate.input)
      if (typeof gate.holds !== 'boolean' || input === undefined) throw malformed(what)
      return { holds: gate.holds, input }
    })
  const verdict = (v: Record<string, unknown>) => ({
    badge: badge(v.badge),
    ...optional('reason', text(v.reason)),
    ...optional('suppression', suppressionScope(v.suppression)),
    subLabels: (Array.isArray(v.subLabels) ? v.subLabels : []).map(subLabel)
  })
  const instanceStatus = (i: unknown): InstanceStatus => {
    const v = record(i)
    const instance =
      isRecord(v.instance) && typeof v.instance.segment === 'string'
        ? { ...optional('name', text(v.instance.name)), segment: v.instance.segment }
        : undefined
    return {
      ...optional('instance', instance),
      ...verdict(v),
      ...optional('active', typeof v.active === 'boolean' ? v.active : undefined),
      ...optional('input', inputState(v.input)),
      ...optional('value', signalValue(v.value)),
      ...optional('limit', num(v.limit)),
      ...optional('progress', progressOf(v.progress)),
      gates: gates(v.gates),
      ...optional('level', text(v.level)),
      ...optional('priority', text(v.priority))
    }
  }
  const status = (s: unknown): RuleStatus => {
    const v = record(s)
    if (!Array.isArray(v.instances)) throw malformed(what)
    return {
      ...verdict(v),
      errors: strings(v.errors),
      issues: strings(v.issues),
      instances: v.instances.map(instanceStatus)
    }
  }
  const signal = (s: unknown): RuleInfo['signal'] => {
    const v = record(s)
    if (typeof v.path === 'string') return { paths: [v.path] }
    if (typeof v.combinator !== 'string' || !Array.isArray(v.inputs)) throw malformed(what)
    return { paths: v.inputs.map((i) => string(record(i).path)), combinator: v.combinator }
  }
  const rule = (r: unknown): RuleInfo => {
    const v = record(r)
    const d = record(v.detector)
    const zoneLevel = isRecord(d.limit) && d.limit.kind === 'zone' ? text(d.limit.level) : undefined
    return {
      name: string(v.name),
      ...optional('priority', text(v.priority)),
      detector: {
        type: string(d.type),
        ...optional('direction', text(d.direction)),
        ...optional('measure', text(d.measure)),
        ...optional('zoneLevel', zoneLevel)
      },
      signal: signal(v.signal),
      gates: (Array.isArray(v.gates) ? v.gates : []).map((g) => ({
        paths: signal(record(g).signal).paths
      }))
    }
  }

  const entry = record(body)
  if (typeof entry.enabled !== 'boolean') throw malformed(what)
  return {
    origin: string(entry.origin),
    slug: string(entry.slug),
    rule: rule(entry.rule),
    enabled: entry.enabled,
    ...optional('note', text(entry.note)),
    ...optional('suppression', ruleSuppression(entry.suppression)),
    status: status(entry.status)
  }
}

function parseRules(body: unknown): RuleEntry[] {
  if (!Array.isArray(body)) throw malformed('/rules')
  return body.map((entry) => parseRuleEntry(entry, '/rules'))
}

/** The server's own message from an error body, or the status when it has none. */
async function failure(res: Response, path: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined)
  if (isRecord(body) && typeof body.error === 'string') return new Error(body.error)
  return new Error(`${path} answered ${String(res.status)}`)
}

/** The API over HTTP, relative to the admin UI's origin. */
export function httpApi(fetchFn: typeof fetch = (input, init) => fetch(input, init)): PanelApi {
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await fetchFn(path, {
      ...init,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) throw new SessionExpiredError()
    if (!res.ok) throw await failure(res, path)
    return res.json()
  }
  // The server refuses a mutating request without this content type; that is
  // what keeps another site from acting through an admin's session.
  const send = (method: string, path: string, body?: unknown) =>
    request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const ruleRoute = (origin: string, slug: string) =>
    `${PLUGIN_BASE}/rules/${encodeURIComponent(origin)}/${encodeURIComponent(slug)}`

  return {
    state: async () => parseState(await request(`${PLUGIN_BASE}/state`)),
    pluginEnabled: async () => parseEnabled(await request(`${PLUGIN_BASE}/`)),
    rules: async () => parseRules(await request(`${PLUGIN_BASE}/rules`)),
    resetAccumulator: async (origin, slug) => {
      const path = `${ruleRoute(origin, slug)}/reset`
      return parseRuleEntry(await send('POST', path), path)
    },
    setEvaluation: async (enabled) => {
      const path = `${PLUGIN_BASE}/evaluation`
      return parseEvaluation(await send('PUT', path, { enabled }), path)
    }
  }
}
