import { BADGES, SUB_LABELS, type Badge, type SubLabel } from '../alerts/badge'
import type { Rule } from '../model/rule'

/** The origin of rules written through the panel; only they can be edited. */
export const USER_ORIGIN = 'user'

export { BADGES, SUB_LABELS, type Badge, type SubLabel }

/** The plugin id, which is also the path segment of its routes. */
export const PLUGIN_ID = 'signalk-alert-rules'

export const PLUGIN_BASE = `/plugins/${PLUGIN_ID}`

/**
 * A request that hangs, as on a tablet that lost its Wi-Fi, would otherwise
 * hold up polling and show stale data as current.
 */
export const REQUEST_TIMEOUT_MS = 10_000

/** `GET /state`, as docs/api.md describes it. */
export interface PluginState {
  running: boolean
  error?: string
  securityEnabled: boolean | null
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

/** Who disabled a rule, when, and why. */
export interface RuleDisabled {
  since: string
  actor: string
  note?: string
}

/** The ruleset that provides a rule, and the package that ships it, if any. */
export interface RuleSource {
  name: string
  version: string
  package?: { name: string; version: string }
}

/** A rule entry, as `GET /rules` answers it. */
export interface RuleEntry {
  origin: string
  slug: string
  /** Present for a ruleset rule only. */
  ruleset?: RuleSource
  rule: RuleInfo
  /** Present while the rule is disabled. */
  disabled?: RuleDisabled
  status: RuleStatus
}

/** What the panel asks of the server; tests substitute their own. */
export interface PanelApi {
  state(): Promise<PluginState>
  rules(): Promise<RuleEntry[]>
  /** Clears the rule's active alerts and sets its accumulator totals to zero. */
  resetAccumulator(origin: string, slug: string): Promise<RuleEntry>
  /** The whole stored rule, which the rule list abbreviates. */
  ruleDefinition(origin: string, slug: string): Promise<Rule>
  /** Creates a user rule; it starts enabled. A refused rule rejects with RuleRejectedError. */
  createRule(rule: Rule): Promise<RuleEntry>
  /** Replaces a user rule; a refused rule rejects with RuleRejectedError. */
  updateRule(slug: string, rule: Rule): Promise<RuleEntry>
  /** What replacing a user rule would do to its alerts and totals, without doing it. */
  previewRule(slug: string, rule: Rule): Promise<EditPreview>
  /**
   * Disabling clears the rule's alerts and holds back new ones while it keeps
   * evaluating; an empty note is no note.
   */
  disableRule(origin: string, slug: string, note: string): Promise<RuleEntry>
  /** Enabling raises an alert at once if the rule's condition holds. */
  enableRule(origin: string, slug: string): Promise<RuleEntry>
}

/** `POST /rules/user/:slug/preview`, as docs/api.md describes it. */
export interface EditPreview {
  restarts: boolean
  /** The parts of the rule that make it restart, by field path. */
  changes: string[]
  activeAlerts: number
  clearsActiveAlert: boolean
  discardsTotal: boolean
}

/** A field the server refused, as a JSON pointer into the rule. */
export interface FieldError {
  path: string
  message: string
}

/** The server refused a rule body; `errors` names each offending field. */
export class RuleRejectedError extends Error {
  constructor(
    message: string,
    readonly errors: FieldError[]
  ) {
    super(message)
    this.name = 'RuleRejectedError'
  }
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function malformed(what: string): Error {
  return new Error(`unexpected response from ${what}`)
}

export function parseState(body: unknown): PluginState {
  if (!isRecord(body) || typeof body.running !== 'boolean') throw malformed('/state')
  const { running, error, securityEnabled, issues } = body
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
    ...(issues === undefined ? {} : { issues })
  }
}

/** `{ key: value }`, or nothing when the value is absent, for spreading into an object. */
function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, T>>)
}

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)

const inputState = (v: unknown): InputState | undefined =>
  v === 'value' || v === 'unavailable' || v === 'neverSeen' ? v : undefined

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

function ruleDisabled(v: unknown): RuleDisabled | undefined {
  if (!isRecord(v) || typeof v.since !== 'string' || typeof v.actor !== 'string') return undefined
  return { since: v.since, actor: v.actor, ...optional('note', text(v.note)) }
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
  const nameVersion = (v: unknown) => {
    const r = record(v)
    return { name: string(r.name), version: string(r.version) }
  }
  const ruleSource = (v: unknown): RuleSource | undefined => {
    if (v === undefined) return undefined
    const r = record(v)
    return {
      ...nameVersion(r),
      ...optional('package', r.package === undefined ? undefined : nameVersion(r.package))
    }
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
  return {
    origin: string(entry.origin),
    slug: string(entry.slug),
    ...optional('ruleset', ruleSource(entry.ruleset)),
    rule: rule(entry.rule),
    ...optional('disabled', ruleDisabled(entry.disabled)),
    status: status(entry.status)
  }
}

function parseRules(body: unknown): RuleEntry[] {
  if (!Array.isArray(body)) throw malformed('/rules')
  return body.map((entry) => parseRuleEntry(entry, '/rules'))
}

function fieldErrors(v: unknown): FieldError[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.flatMap((e) =>
    isRecord(e) && typeof e.path === 'string' && typeof e.message === 'string'
      ? [{ path: e.path, message: e.message }]
      : []
  )
}

/**
 * The panel's own wording for a slug conflict, which only creating a rule
 * meets. A create that timed out may still have been saved, and its retry
 * then finds its own slug taken; an operator who renamed it would store the
 * rule twice.
 */
const SLUG_TAKEN =
  'is taken by another rule. If an earlier attempt to create this rule timed out, it may have saved this rule: check the rule list before renaming.'

/**
 * The server's own message from an error body, or the status when it has
 * none. A refused rule carries its field errors; a slug conflict, which the
 * server reports without them, belongs to the slug.
 */
async function failure(res: Response, path: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined)
  if (!isRecord(body) || typeof body.error !== 'string') {
    return new Error(`${path} answered ${String(res.status)}`)
  }
  const errors = fieldErrors(body.errors)
  if (errors !== undefined) return new RuleRejectedError(body.error, errors)
  if (res.status === 409) {
    return new RuleRejectedError(body.error, [{ path: '/slug', message: SLUG_TAKEN }])
  }
  return new Error(body.error)
}

/**
 * The stored rule in an entry. The server stores only rules that passed its
 * validation, so the checks here only catch a server and panel that disagree.
 */
function parseRuleDefinition(body: unknown, what: string): Rule {
  const rule = isRecord(body) ? body.rule : undefined
  if (
    !isRecord(rule) ||
    typeof rule.name !== 'string' ||
    typeof rule.slug !== 'string' ||
    typeof rule.message !== 'string' ||
    !isRecord(rule.signal) ||
    !isRecord(rule.detector)
  ) {
    throw malformed(what)
  }
  return rule as unknown as Rule
}

function parsePreview(body: unknown, what: string): EditPreview {
  if (
    !isRecord(body) ||
    typeof body.restarts !== 'boolean' ||
    !Array.isArray(body.changes) ||
    typeof body.activeAlerts !== 'number' ||
    typeof body.clearsActiveAlert !== 'boolean' ||
    typeof body.discardsTotal !== 'boolean'
  ) {
    throw malformed(what)
  }
  return {
    restarts: body.restarts,
    changes: body.changes.filter((c): c is string => typeof c === 'string'),
    activeAlerts: body.activeAlerts,
    clearsActiveAlert: body.clearsActiveAlert,
    discardsTotal: body.discardsTotal
  }
}

/**
 * A request with the admin UI's session, bounded by the request timeout. A
 * refused session throws SessionExpiredError, any other failure the server's
 * own message.
 */
async function requestJson(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const res = await fetchFn(path, {
    ...init,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (res.status === 401 || res.status === 403) throw new SessionExpiredError()
  if (!res.ok) throw await failure(res, path)
  if (res.status === 204) return undefined
  return res.json()
}

/** A JSON `GET` relative to the admin UI's origin, failing as the panel's own requests do. */
export function getJson(fetchFn: typeof fetch, path: string): Promise<unknown> {
  return requestJson(fetchFn, path)
}

/**
 * A mutating JSON request, failing as `getJson` does; answers undefined for a
 * 204. The server refuses a mutating request without this content type; that
 * is what keeps another site from acting through an admin's session.
 */
export function sendJson(
  fetchFn: typeof fetch,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return requestJson(fetchFn, path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

/** The API over HTTP, relative to the admin UI's origin. */
export function httpApi(fetchFn: typeof fetch = (input, init) => fetch(input, init)): PanelApi {
  const request = (path: string, init: RequestInit = {}) => requestJson(fetchFn, path, init)
  const send = (method: string, path: string, body?: unknown) =>
    sendJson(fetchFn, method, path, body)
  const ruleRoute = (origin: string, slug: string) =>
    `${PLUGIN_BASE}/rules/${encodeURIComponent(origin)}/${encodeURIComponent(slug)}`

  return {
    state: async () => parseState(await request(`${PLUGIN_BASE}/state`)),
    rules: async () => parseRules(await request(`${PLUGIN_BASE}/rules`)),
    resetAccumulator: async (origin, slug) => {
      const path = `${ruleRoute(origin, slug)}/reset`
      return parseRuleEntry(await send('POST', path), path)
    },
    ruleDefinition: async (origin, slug) => {
      const path = ruleRoute(origin, slug)
      return parseRuleDefinition(await request(path), path)
    },
    createRule: async (rule) => {
      const path = `${PLUGIN_BASE}/rules`
      return parseRuleEntry(await send('POST', path, rule), path)
    },
    updateRule: async (slug, rule) => {
      const path = ruleRoute(USER_ORIGIN, slug)
      return parseRuleEntry(await send('PUT', path, rule), path)
    },
    previewRule: async (slug, rule) => {
      const path = `${ruleRoute(USER_ORIGIN, slug)}/preview`
      return parsePreview(await send('POST', path, rule), path)
    },
    disableRule: async (origin, slug, note) => {
      const path = `${ruleRoute(origin, slug)}/disable`
      return parseRuleEntry(await send('POST', path, { note }), path)
    },
    enableRule: async (origin, slug) => {
      const path = `${ruleRoute(origin, slug)}/enable`
      return parseRuleEntry(await send('POST', path), path)
    }
  }
}
