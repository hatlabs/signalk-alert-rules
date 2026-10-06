import { alertPathsOverlap } from '../src/alerts/paths'
import { alertPathOverlap, type ListedRule } from '../src/application'
import { ruleAlertPath } from '../src/model/alertPath'
import type { Rule } from '../src/model/rule'
import { validateRule } from '../src/model/validate'
import {
  httpApi,
  parseRuleEntry,
  parseRules,
  type EditPreview,
  type PanelApi,
  type PluginState,
  type RuleEntry,
  type TemplateListing
} from '../src/panel/api'
import type { HistorySource } from '../src/panel/history/historySource'
import type { PathSource } from '../src/panel/paths/selfPaths'
import { noChange } from '../test/panel/fixtures'
import { distance } from '../test/panel/reportedPaths'
import {
  exampleEntries,
  extraRules,
  freshState,
  historySeries,
  invalidRuleEntry,
  LOAD_ISSUE,
  paths,
  ruleEntry,
  templateSets
} from './data'
import type { Scenario } from './scenario'

/** A request that never answers, for a view's loading state. */
const pending = <T>() => new Promise<T>(() => undefined)

/**
 * Rejects with the error the panel's own client raises for the server's
 * answer, by passing that answer through the client.
 */
function refused(status: number, body: unknown = {}): Promise<never> {
  const answer = () => Promise.resolve(new Response(JSON.stringify(body), { status }))
  return httpApi(answer)
    .deleteRule('refused')
    .then(() => Promise.reject(new Error(`a ${String(status)} answer did not fail`)))
}

/** The server's answer to a rule it refuses (src/api/routes.ts, `invalid` and `editRefused`). */
const invalidBody = (errors: { path: string; message: string }[]) => ({
  error: 'invalid request body',
  errors
})
const SLUG_EXISTS = { error: 'a rule with this slug exists' }
const SLUG_MISMATCH = {
  error: "the rule's slug must equal the one in the path",
  errors: [{ path: '/slug', message: 'must equal the slug in the path' }]
}
const alertPathTaken = (holder: string) => ({
  error: 'another rule has this alert path',
  errors: [alertPathOverlap(holder)]
})

const RESTART: EditPreview = {
  restarts: true,
  changes: ['/detector/steps/0/limit'],
  activeAlerts: 1,
  clearsActiveAlert: true,
  discardsTotal: false
}

const ACTOR = 'admin'

/**
 * How long `/state` answers as `plugin` says before it answers as `after`
 * says. A time rather than a count of reads: StrictMode runs the first probe
 * twice.
 */
export const SWITCH_AFTER_MS = 2000

/**
 * A PanelApi over rules kept in memory, answering as the scenario says.
 * Entries are kept as the server sends them and parsed by the panel's own
 * parser, so they reach the views as they would from the server. Writes
 * change the rules until the page reloads.
 */
export function fakeApi(scenario: Scenario): PanelApi {
  const initial: ListedRule[] =
    scenario.rules === 'empty'
      ? []
      : scenario.rules === 'partial'
        ? [...exampleEntries(scenario.states), invalidRuleEntry()]
        : scenario.rules === 'examples'
          ? exampleEntries(scenario.states)
          : [...exampleEntries(scenario.states), extraRules[scenario.rules]()]
  const store = new Map(initial.map((e) => [e.slug, e]))
  const loadedAt = Date.now()
  let listing: TemplateListing = {
    sets: templateSets.map((set) => ({
      ...set,
      new: scenario.templates === 'new' ? set.templates.map((t) => t.id) : []
    })),
    problems: []
  }

  const answer = (entry: ListedRule): RuleEntry => parseRuleEntry(entry, `/rules/${entry.slug}`)
  const found = (slug: string): Promise<ListedRule> => {
    const entry = store.get(slug)
    return entry === undefined ? refused(404, { error: 'no such rule' }) : Promise.resolve(entry)
  }
  /** The other stored rule whose alert path the rule's overlaps, as the server finds it. */
  const alertPathHolder = (rule: Rule): string | undefined => {
    const path = ruleAlertPath(rule)
    for (const entry of store.values()) {
      if (entry.slug !== rule.slug && 'rule' in entry && alertPathsOverlap(entry.alertPath, path)) {
        return entry.slug
      }
    }
    return undefined
  }
  /** Stores the rule as the server would, after the checks `check` adds to its validation. */
  const save = async (
    input: Rule,
    check: (rule: Rule) => Promise<void>,
    existing?: ListedRule
  ): Promise<RuleEntry> => {
    switch (scenario.save) {
      case 'error':
        throw new Error('/rules answered 500')
      case 'rejected':
        return refused(400, invalidBody([{ path: '/name', message: 'is used by another rule' }]))
      case 'refused':
        return refused(401)
      case 'ok':
        break
    }
    const result = validateRule(input)
    if (!result.ok) return refused(400, invalidBody(result.errors))
    const rule = result.value
    await check(rule)
    const holder = alertPathHolder(rule)
    if (holder !== undefined) return refused(409, alertPathTaken(holder))
    // An edited rule keeps its state; a new or repaired one has not read its input yet.
    const state =
      existing !== undefined && 'rule' in existing
        ? existing.state
        : freshState(existing?.disabled !== undefined)
    const entry = ruleEntry(rule, state, existing?.disabled)
    store.set(entry.slug, entry)
    return answer(entry)
  }
  /** A control: refused as the scenario says, else the change to the rule's entry. */
  const control = async (
    slug: string,
    change: (entry: ListedRule) => ListedRule
  ): Promise<RuleEntry> => {
    if (scenario.controls === 'refused') return refused(401)
    const entry = change(await found(slug))
    store.set(slug, entry)
    return answer(entry)
  }
  const stateAnswer = (): Scenario['plugin'] =>
    scenario.after !== 'ready' && Date.now() - loadedAt >= SWITCH_AFTER_MS
      ? scenario.after
      : scenario.plugin

  return {
    state() {
      const running: PluginState = {
        running: true,
        securityEnabled: scenario.security === 'on',
        permissions: scenario.access,
        issues: scenario.rules === 'partial' ? [LOAD_ISSUE] : []
      }
      const stopped = { ...running, running: false, issues: undefined }
      switch (stateAnswer()) {
        case 'ready':
          return Promise.resolve(running)
        case 'loading':
          return pending()
        case 'failed':
          return Promise.resolve({ ...stopped, error: 'cannot write the data directory: EACCES' })
        case 'notRunning':
          return Promise.resolve(stopped)
        case 'unreachable':
          return Promise.reject(new Error('the request timed out'))
        case 'session':
          return refused(401)
      }
    },
    rules: () => Promise.resolve(parseRules([...store.values()])),
    async ruleDefinition(slug) {
      if (scenario.definition === 'loading') return pending()
      if (scenario.definition === 'error') throw new Error('/rules answered 500')
      const entry = await found(slug)
      if (!('rule' in entry)) throw new Error('not a valid rule')
      return entry.rule
    },
    createRule: (rule) =>
      save(rule, (checked) =>
        store.has(checked.slug) ? refused(409, SLUG_EXISTS) : Promise.resolve()
      ),
    updateRule: async (slug, rule) =>
      save(
        rule,
        (checked) => (checked.slug === slug ? Promise.resolve() : refused(400, SLUG_MISMATCH)),
        await found(slug)
      ),
    previewRule: () => Promise.resolve(scenario.preview === 'restart' ? RESTART : noChange),
    disableRule: (slug, note) =>
      control(slug, (e) => ({
        ...e,
        disabled: { since: new Date().toISOString(), actor: ACTOR, ...(note ? { note } : {}) },
        state: { ...e.state, ruleState: 'disabled' }
      })),
    enableRule: (slug) =>
      control(slug, ({ disabled: _disabled, ...e }) => ({
        ...e,
        state: { ...e.state, ruleState: 'enabled' }
      })),
    resetAccumulator: (slug) =>
      control(slug, (e) => ({
        ...e,
        state: {
          ...e.state,
          condition: 'normal',
          reason: 'withinLimits',
          ...(e.state.progress?.kind === 'total'
            ? { progress: { ...e.state.progress, total: 0 } }
            : {})
        }
      })),
    async deleteRule(slug) {
      if (scenario.controls === 'refused') return refused(401)
      await found(slug)
      store.delete(slug)
    },
    templates() {
      switch (scenario.templates) {
        case 'loading':
          return pending()
        case 'error':
          return Promise.reject(new Error('/templates answered 500'))
        case 'none':
          return Promise.resolve({ sets: [], problems: [] })
        default:
          return Promise.resolve(listing)
      }
    },
    dismissTemplates(shown) {
      listing = {
        ...listing,
        sets: listing.sets.map((set) => ({
          ...set,
          new: set.new.filter((id) => !(shown[set.id] ?? []).includes(id))
        }))
      }
      return Promise.resolve(listing)
    }
  }
}

export function fakePaths(scenario: Scenario): PathSource {
  return {
    selfPaths() {
      switch (scenario.paths) {
        case 'ready':
          return Promise.resolve(paths)
        case 'empty':
          return Promise.resolve([])
        case 'loading':
          return pending()
        case 'error':
          return Promise.reject(new Error('/signalk/v1/api/vessels/self answered 502'))
      }
    },
    distanceUnit: () => Promise.resolve(distance)
  }
}

export function fakeHistory(scenario: Scenario): HistorySource {
  return {
    hasProvider: () => Promise.resolve(scenario.history !== 'none'),
    values(query) {
      switch (scenario.history) {
        case 'loading':
          return pending()
        case 'error':
          return Promise.reject(new Error('/signalk/v2/api/history/values answered 500'))
        case 'none':
        case 'data':
          return Promise.resolve(historySeries(query, 'data'))
        case 'gaps':
        case 'empty':
          return Promise.resolve(historySeries(query, scenario.history))
      }
    }
  }
}
