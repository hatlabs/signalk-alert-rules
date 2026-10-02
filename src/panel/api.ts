import { CONDITIONS, type Condition } from '../alerts/state'
import type { Rule } from '../model/rule'

export { CONDITIONS, type Condition }

/** The plugin id, which is also the path segment of its routes. */
export const PLUGIN_ID = 'signalk-alert-rules'

export const PLUGIN_BASE = `/plugins/${PLUGIN_ID}`

/**
 * A request that hangs, as on a tablet that lost its Wi-Fi, would otherwise
 * hold up polling and show stale data as current.
 */
export const REQUEST_TIMEOUT_MS = 10_000

/** The caller's access level, which decides the controls the webapp offers. */
export type Permissions = 'readonly' | 'readwrite' | 'admin'

/** `GET /state`, as docs/api.md describes it. */
export interface PluginState {
  running: boolean
  error?: string
  securityEnabled: boolean | null
  permissions: Permissions
  /**
   * Present while the plugin runs: problems found while loading the data
   * directory, such as a stored rule file that could not be read. A stored
   * rule that was read but does not run is an invalid entry of `/rules`
   * instead.
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

/** A total or an event count toward the limit; the server reports no timers. */
export type Progress =
  { kind: 'events'; count: number; limit: number } | { kind: 'total'; total: number; limit: number }

export interface GateStatus {
  holds: boolean
  input: InputState
}

/**
 * The facts a condition's reason comes with, as docs/rules.md "Conditions
 * and reasons" lists them; the webapp words its sentences from these.
 */
export interface ConditionFacts {
  /** The priority an alert has reached. */
  priority?: string
  /** The furthest step an alert has reached, an index into the rule's steps. */
  step?: number
  /** The zone level an alert has reached, or the one a path lacks. */
  level?: string
  /** The alert's input has stopped reporting, so the alert is not repeated. */
  awaitingInput?: boolean
  /** The alert's message with its placeholders filled in. */
  message?: string
  clearedAt?: string
  clearSince?: string
  lastSeen?: string
  /** The rule's side of a zone level that exists only on the other side. */
  side?: string
  /** The gate, by index, whose path lacks a zone level. */
  gate?: number
  cause?: string
  contract?: string
  path?: string
  units?: string
}

/** What an instance reports whatever its condition. */
export interface LiveFacts {
  /** For a wildcard rule; a rule that is not evaluated keeps only the segment. */
  instance?: { name?: string; segment: string }
  value?: SignalValue
  limit?: number
  progress?: Progress
}

/** One instance's state, as docs/rules.md "State" describes it. */
export interface InstanceStatus extends ConditionFacts, LiveFacts {
  condition: Condition
  /** The reason code the condition comes with. */
  reason: string
  gates: GateStatus[]
}

export type RuleState = 'enabled' | 'disabled'

/**
 * A rule's state, `state` in a rule entry: whether it is enabled, and its
 * condition, which is its worst instance's with that instance's facts.
 */
export interface RuleStatus extends ConditionFacts, LiveFacts {
  ruleState: RuleState
  condition: Condition
  reason: string
  /** When the rule state or the condition last changed. */
  changedAt: string
  errors: string[]
  issues: string[]
  instances: InstanceStatus[]
}

/**
 * One step of a rule's climb: its priority and the limit the detector takes,
 * a `limit` for most, a match's `value`, an absence's `within`, in SI units.
 */
export interface RuleStep {
  priority: string
  limit?: number
  value?: string | number | boolean
  within?: number
}

/** The parts of a rule the rule list and detail view show. */
export interface RuleInfo {
  name: string
  /**
   * Under `alerts.`, as the server derives it; a wildcard rule's has a `*`
   * where each instance goes.
   */
  alertPath: string
  /** The first step's priority; absent for a zone limit, whose levels set the priority. */
  priority?: string
  /** The steps the alert climbs; empty for a zone limit, whose steps are the path's zones. */
  steps: RuleStep[]
  /** How long, in seconds, a step's condition must hold before the alert reaches it. */
  duration?: number
  /** The message as stored, its placeholders not filled in. */
  message: string
  detector: {
    type: string
    direction?: string
    measure?: string
    zoneLevel?: string
    /** A match's comparison. */
    op?: string
  }
  /** The paths the signal reads; several, with the combinator, for a combined signal. */
  signal: { paths: string[]; combinator?: string }
  /** The source a single-path signal is pinned to; absent for the preferred source. */
  source?: string
  /** The template the rule was made from, as information only. */
  template?: { set: string; id: string }
  gates: { paths: string[] }[]
}

/** The actor the server records for a request without a login, as it is with security off. */
export const UNAUTHENTICATED_ACTOR = 'unauthenticated'

/** Who disabled a rule, when, and why. */
export interface RuleDisabled {
  since: string
  actor: string
  note?: string
}

/** A rule entry, as `GET /rules` answers it. */
export interface RuleEntry {
  slug: string
  rule: RuleInfo
  /** Present while the rule is disabled. */
  disabled?: RuleDisabled
  status: RuleStatus
}

/** A stored rule that does not run, listed as a problem so it can be fixed or deleted. */
export interface InvalidRuleEntry {
  slug: string
  /** The stored body's name, or the slug when it has none. */
  name: string
  invalid: { errors: FieldError[]; body: unknown }
  disabled?: RuleDisabled
  status: RuleStatus
}

/** An entry of `GET /rules`: a rule that runs, or one that does not. */
export type ListedRule = RuleEntry | InvalidRuleEntry

export function isInvalid(entry: ListedRule): entry is InvalidRuleEntry {
  return 'invalid' in entry
}

/** A listed rule's name, whether it runs or not. */
export function ruleName(entry: ListedRule): string {
  return isInvalid(entry) ? entry.name : entry.rule.name
}

/** What the panel asks of the server; tests substitute their own. */
export interface PanelApi {
  state(): Promise<PluginState>
  rules(): Promise<ListedRule[]>
  /** Clears the rule's active alerts and sets its accumulator totals to zero. */
  resetAccumulator(slug: string): Promise<RuleEntry>
  /** The whole stored rule, which the rule list abbreviates. */
  ruleDefinition(slug: string): Promise<Rule>
  /** Creates a rule; it starts enabled. A refused rule rejects with RuleRejectedError. */
  createRule(rule: Rule): Promise<RuleEntry>
  /** Replaces a rule; a refused rule rejects with RuleRejectedError. */
  updateRule(slug: string, rule: Rule): Promise<RuleEntry>
  /** What replacing a rule would do to its alerts and totals, without doing it. */
  previewRule(slug: string, rule: Rule): Promise<EditPreview>
  /**
   * Disabling clears the rule's alerts and holds back new ones while it keeps
   * evaluating; an empty note is no note.
   */
  disableRule(slug: string, note: string): Promise<RuleEntry>
  /** Enabling raises an alert at once if the rule's condition holds. */
  enableRule(slug: string): Promise<RuleEntry>
  /** Deletes a rule, a stored one that does not run included, and clears its alerts. */
  deleteRule(slug: string): Promise<void>
}

/** `POST /rules/:slug/preview`, as docs/api.md describes it. */
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
 * The server refused the request (401). Signal K answers a caller who is not
 * logged in and one below the route's level alike, so for a write this only
 * says the request was refused; see LevelRefusedError.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('the session has expired')
    this.name = 'SessionExpiredError'
  }
}

/**
 * A write refused while `/state` still answers: the caller's level does not
 * reach the route, as when an administrator lowered it meanwhile. Where the
 * server lets anyone read, an expired login's `/state` answers too, as
 * `readonly`, so that level does not tell the two apart.
 */
export class LevelRefusedError extends Error {
  /** @param permissions the level `/state` answered with after the refusal */
  constructor(readonly permissions: Permissions) {
    super('the request needs a higher access level')
    this.name = 'LevelRefusedError'
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
  const { running, error, securityEnabled, permissions, issues } = body
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
    // Least privilege: a level the panel does not know offers no controls.
    permissions: permissions === 'admin' || permissions === 'readwrite' ? permissions : 'readonly',
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
  const count = num(v.count)
  const limit = num(v.limit)
  const total = num(v.total)
  if (v.kind === 'events' && count !== undefined && limit !== undefined) {
    return { kind: 'events', count, limit }
  }
  if (v.kind === 'total' && total !== undefined && limit !== undefined) {
    return { kind: 'total', total, limit }
  }
  return undefined
}

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

/** The well-formed facts in a state or instance row. */
function conditionFacts(v: Record<string, unknown>): ConditionFacts {
  return {
    ...optional('priority', text(v.priority)),
    ...optional('step', num(v.step)),
    ...optional('level', text(v.level)),
    ...optional('awaitingInput', bool(v.awaitingInput)),
    ...optional('message', text(v.message)),
    ...optional('clearedAt', text(v.clearedAt)),
    ...optional('clearSince', text(v.clearSince)),
    ...optional('lastSeen', text(v.lastSeen)),
    ...optional('side', text(v.side)),
    ...optional('gate', num(v.gate)),
    ...optional('cause', text(v.cause)),
    ...optional('contract', text(v.contract)),
    ...optional('path', text(v.path)),
    ...optional('units', text(v.units))
  }
}

function instanceOf(v: unknown): LiveFacts['instance'] {
  return isRecord(v) && typeof v.segment === 'string'
    ? { ...optional('name', text(v.name)), segment: v.segment }
    : undefined
}

function liveFacts(v: Record<string, unknown>): LiveFacts {
  return {
    ...optional('instance', instanceOf(v.instance)),
    ...optional('value', signalValue(v.value)),
    ...optional('limit', num(v.limit)),
    ...optional('progress', progressOf(v.progress))
  }
}

function stepValue(v: unknown): RuleStep['value'] {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined
}

function stepsOf(steps: unknown): RuleStep[] {
  return (Array.isArray(steps) ? steps : []).flatMap((step: unknown) => {
    if (!isRecord(step) || typeof step.priority !== 'string') return []
    return [
      {
        priority: step.priority,
        ...optional('limit', num(step.limit)),
        ...optional('value', stepValue(step.value)),
        ...optional('within', num(step.within))
      }
    ]
  })
}

function templateOf(v: unknown): RuleInfo['template'] {
  return isRecord(v) && typeof v.set === 'string' && typeof v.id === 'string'
    ? { set: v.set, id: v.id }
    : undefined
}

function ruleDisabled(v: unknown): RuleDisabled | undefined {
  if (!isRecord(v) || typeof v.since !== 'string' || typeof v.actor !== 'string') return undefined
  return { since: v.since, actor: v.actor, ...optional('note', text(v.note)) }
}

/**
 * Reads one entry of `GET /rules`. The panel ships in the same package as the server, so
 * a field the server always sends and the panel relies on is required, and an
 * entry without it means the two disagree; optional fields are kept only when
 * well formed.
 */
export function parseListedRule(body: unknown, what: string): ListedRule {
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
  const condition = (v: unknown): Condition => {
    const found = CONDITIONS.find((c) => c === v)
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
    condition: condition(v.condition),
    reason: string(v.reason)
  })
  const instanceStatus = (i: unknown): InstanceStatus => {
    const v = record(i)
    return { ...verdict(v), ...conditionFacts(v), ...liveFacts(v), gates: gates(v.gates) }
  }
  const status = (s: unknown): RuleStatus => {
    const v = record(s)
    if (!Array.isArray(v.instances)) throw malformed(what)
    const ruleState = v.ruleState
    if (ruleState !== 'enabled' && ruleState !== 'disabled') throw malformed(what)
    return {
      ruleState,
      ...verdict(v),
      changedAt: string(v.changedAt),
      ...conditionFacts(v),
      ...liveFacts(v),
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
  // The alert path comes with the entry, derived from the rule, not in it.
  const rule = (r: unknown, alertPath: string): RuleInfo => {
    const v = record(r)
    const d = record(v.detector)
    const zoneLevel = isRecord(d.limit) && d.limit.kind === 'zone' ? text(d.limit.level) : undefined
    const steps = stepsOf(d.steps)
    const input = record(v.signal)
    return {
      name: string(v.name),
      alertPath,
      ...optional('priority', steps.at(0)?.priority),
      steps,
      ...optional('duration', num(d.duration)),
      message: string(v.message),
      detector: {
        type: string(d.type),
        ...optional('direction', text(d.direction)),
        ...optional('measure', text(d.measure)),
        ...optional('zoneLevel', zoneLevel),
        ...optional('op', text(d.op))
      },
      signal: signal(input),
      ...optional('source', text(input.source)),
      ...optional('template', templateOf(v.template)),
      gates: (Array.isArray(v.gates) ? v.gates : []).map((g) => ({
        paths: signal(record(g).signal).paths
      }))
    }
  }

  const entry = record(body)
  const slug = string(entry.slug)
  const common = {
    ...optional('disabled', ruleDisabled(entry.disabled)),
    status: status(entry.state)
  }
  if (isRecord(entry.invalid)) {
    const stored = entry.invalid.body
    return {
      slug,
      name: (isRecord(stored) ? text(stored.name) : undefined) ?? slug,
      invalid: { errors: fieldErrors(entry.invalid.errors) ?? [], body: stored },
      ...common
    }
  }
  return { slug, rule: rule(entry.rule, string(entry.alertPath)), ...common }
}

/**
 * Reads the entry of a rule that runs, as an action on it answers. The
 * server answers an action only on such a rule.
 */
export function parseRuleEntry(body: unknown, what: string): RuleEntry {
  const entry = parseListedRule(body, what)
  if (isInvalid(entry)) throw malformed(what)
  return entry
}

/** `GET /rules`: the rules that run, then the stored rules that do not. */
export function parseRules(body: unknown): ListedRule[] {
  if (!Array.isArray(body)) throw malformed('/rules')
  return body.map((entry) => parseListedRule(entry, '/rules'))
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
  if (res.status === 401) throw new SessionExpiredError()
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
function sendJson(
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
  const ruleRoute = (slug: string) => `${PLUGIN_BASE}/rules/${encodeURIComponent(slug)}`

  return {
    state: async () => parseState(await request(`${PLUGIN_BASE}/state`)),
    rules: async () => parseRules(await request(`${PLUGIN_BASE}/rules`)),
    resetAccumulator: async (slug) => {
      const path = `${ruleRoute(slug)}/reset`
      return parseRuleEntry(await send('POST', path), path)
    },
    ruleDefinition: async (slug) => {
      const path = ruleRoute(slug)
      return parseRuleDefinition(await request(path), path)
    },
    createRule: async (rule) => {
      const path = `${PLUGIN_BASE}/rules`
      return parseRuleEntry(await send('POST', path, rule), path)
    },
    updateRule: async (slug, rule) => {
      const path = ruleRoute(slug)
      return parseRuleEntry(await send('PUT', path, rule), path)
    },
    previewRule: async (slug, rule) => {
      const path = `${ruleRoute(slug)}/preview`
      return parsePreview(await send('POST', path, rule), path)
    },
    disableRule: async (slug, note) => {
      const path = `${ruleRoute(slug)}/disable`
      return parseRuleEntry(await send('POST', path, { note }), path)
    },
    enableRule: async (slug) => {
      const path = `${ruleRoute(slug)}/enable`
      return parseRuleEntry(await send('POST', path), path)
    },
    deleteRule: async (slug) => {
      await send('DELETE', ruleRoute(slug))
    }
  }
}
