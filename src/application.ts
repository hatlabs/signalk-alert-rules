import type { Verdict } from './alerts/badge.js'
import { ruleId, ruleRef } from './alerts/paths.js'
import {
  RuleRunner,
  type Accumulated,
  type LoadedRule,
  type RunnerDeps,
  type RunnerRuleStatus
} from './alerts/runner.js'
import { ownedActiveAlert } from './alerts/reconcile.js'
import type { Progress } from './engine/detectors/index.js'
import { carriesTotals, measureOf, structuralChanges } from './engine/evaluator.js'
import { asGiven, canonicalSources } from './engine/sourceRefs.js'
import { MAX_RULES, type Rule } from './model/rule.js'
import { USER_ORIGIN, type Parameter } from './model/ruleset.js'
import { validateRule, type ValidationError } from './model/validate.js'
import type { DiscoveryProblem, DiscoveryResult, LoadedRuleset } from './rulesets/discovery.js'
import { recordedRules, upgradeRuleset, withParameters } from './rulesets/overrides.js'
import { PathPresence, rulePaths } from './rulesets/presence.js'
import type {
  Checkpoints,
  Controls,
  Disabled,
  LogEntry,
  RuleControl,
  RulesetControl,
  RulesetNotice,
  Store
} from './store/store.js'
import { errorMessage, isRecord, own } from './util.js'

/** How often rules are evaluated: detector durations resolve to this. */
export const TICK_MS = 1000

/** How often accumulator totals are saved, bounding what a crash loses. */
export const CHECKPOINT_MS = 60_000

/** How many operator actions the log keeps. */
export const LOG_LIMIT = 200

/** What a start issue about a failed write names, so the write succeeding later removes it. */
const TOTALS = 'the accumulator totals'
const SETTINGS = 'the operator settings'

export type NotEvaluatedReason =
  'ruleset is disabled' | 'not started' | 'ruleset path missing' | 'starts at the next tick'

/** A row of a rule that is not evaluated: one per accumulator total it keeps. */
export interface NotEvaluatedInstance extends Verdict {
  /** For a wildcard rule; the name is not kept with the total. */
  instance?: { segment: string }
  progress: Progress
}

/**
 * The status of a rule that is not being evaluated: one of a disabled
 * ruleset, or inactive for a ruleset rule whose paths the server has not had yet.
 */
export interface NotEvaluatedStatus extends Verdict {
  badge: 'disabled' | 'inactive'
  reason: NotEvaluatedReason
  issues: string[]
  errors: string[]
  instances: NotEvaluatedInstance[]
}

/** The ruleset a rule comes from, as its provider versions it. */
export interface RuleSource {
  name: string
  version: string
  package?: { name: string; version: string }
}

export type RuleStatus = RunnerRuleStatus | NotEvaluatedStatus

/** A rule with what identifies it, the operator's controls and its status. */
export interface RuleEntry {
  origin: string
  slug: string
  /** For a ruleset rule. */
  ruleset?: RuleSource
  /** A ruleset rule as its parameter values resolve it; read-only. */
  rule: Rule
  /** Present while the rule is disabled. */
  disabled?: Disabled
  status: RuleStatus
}

export type ControlOutcome = 'ok' | 'notFound'

export type SaveOutcome =
  | { ok: true; value: Rule }
  | { ok: false; reason: 'invalid'; errors: ValidationError[] }
  | { ok: false; reason: 'exists' | 'notFound' | 'slugMismatch' }

/** What saving an edit would do to the running rule, per the edit semantics. */
export interface EditPreview {
  /** The edit clears and restarts the rule. */
  restarts: boolean
  /** The changed parts that make it restart, by field path. */
  changes: string[]
  /** Instances of the rule whose alert is active now. */
  activeAlerts: number
  /**
   * The restart clears an active alert. An edit applied in place can still
   * clear one at the next evaluation; this does not count it.
   */
  clearsActiveAlert: boolean
  /** The rule has an accumulator total above zero, running or retained, that saving the edit would discard. */
  discardsTotal: boolean
}

export type PreviewOutcome = { ok: true; value: EditPreview } | Exclude<SaveOutcome, { ok: true }>

export type ResetOutcome = 'reset' | 'notFound' | 'notAccumulator'

/** A discovered ruleset with the operator's settings for it and what keeps its rules from running. */
export interface RulesetEntry {
  slug: string
  name: string
  version: string
  description?: string
  /** Where it was found, e.g. `package some-name` or `file foo.yaml`. */
  source: string
  package?: { name: string; version: string }
  enabled: boolean
  parameters: Parameter[]
  /** Values the operator set, by parameter name; the rest take their defaults. */
  values: RulesetControl['parameters']
  /** Slugs of its rules. */
  rules: string[]
  /** Paths its rules read that the server has not had yet. */
  missingPaths: string[]
  notices: RulesetNotice[]
}

export interface RulesetListing {
  rulesets: RulesetEntry[]
  /** Rulesets that could not be loaded, from the last discovery. */
  problems: DiscoveryProblem[]
}

export type ParametersOutcome =
  | { ok: true }
  | { ok: false; reason: 'notFound' }
  | { ok: false; reason: 'invalid'; errors: ValidationError[] }

interface RulesetState {
  loaded: LoadedRuleset
  /** Its rules resolved with the operator's parameter values, by slug. */
  rules: Map<string, Rule>
}

const NO_RULESETS: DiscoveryResult = { rulesets: [], problems: [] }

/** The paths a rule reads, as one comparable value. */
function pathSet(rule: Rule): string {
  return JSON.stringify(rulePaths(rule).sort())
}

function toMaps(checkpoints: Checkpoints): Map<string, Accumulated> {
  return new Map(
    Object.entries(checkpoints).map(([id, { measure, totals }]) => [
      id,
      { measure, totals: new Map(Object.entries(totals)) }
    ])
  )
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

function notEvaluated(
  rule: Rule,
  totals: ReadonlyMap<string, number> | undefined,
  reason: NotEvaluatedReason,
  issues: string[] = []
): NotEvaluatedStatus {
  const badge: NotEvaluatedStatus['badge'] =
    reason === 'ruleset is disabled' ? 'disabled' : 'inactive'
  const d = rule.detector
  const instances =
    d.type !== 'accumulator'
      ? []
      : [...(totals ?? [])].map(([segment, total]) => ({
          ...(segment === '' ? {} : { instance: { segment } }),
          badge,
          reason,
          subLabels: [],
          progress: { kind: 'total' as const, total, limit: d.limit }
        }))
  return { badge, reason, subLabels: [], issues, errors: [], instances }
}

/**
 * SKAR's running state: the stored rules, which of them are disabled, the
 * operator action log and, once started, the runner evaluating the rules.
 * Every change is persisted first and then applied to the one rule it
 * concerns, so other rules keep their timers; a change the store fails to
 * write is not applied.
 */
export class Application {
  /** Problems found while loading or starting and still standing, for the plugin status. */
  readonly issues: string[]
  private runner: RuleRunner | undefined
  private readonly rulesBySlug = new Map<string, Rule>()
  /** Slugs of stored rule files, loaded or not, so a skipped one can be deleted. */
  private readonly stored: Set<string>
  /** Slugs of stored rule files that could not be read, which say nothing about their measure. */
  private readonly unreadable: Set<string>
  /**
   * Checkpointed totals of rules the runner does not hold: a stored rule that
   * no longer validates, kept until the rule is deleted or saved again, and
   * a rule's that is not running, such as one of a disabled ruleset.
   */
  private readonly retained: Map<string, Accumulated>
  /**
   * The measure of each stored rule file that did not load but is written as
   * an accumulator, so a valid replacement of the same measure keeps its total.
   */
  private readonly unloadedMeasures = new Map<string, string>()
  /** Oldest first, as stored. */
  private readonly actions: LogEntry[]
  /** The totals last written, serialised; undefined until a checkpoint succeeds. */
  private lastCheckpoint: string | undefined
  private controls: Controls
  /** Loaded rulesets by slug, from the last discovery. */
  private readonly rulesetsBySlug = new Map<string, RulesetState>()
  private problems: DiscoveryProblem[] = []
  private readonly presence: PathPresence
  /**
   * Ruleset rules that have had all their paths in this run, or whose alert
   * core held at start, with the paths they had them for. A rule does not go
   * back to inactive in the run until a parameter change, upgrade or return
   * points it at other paths.
   */
  private readonly present = new Map<string, string>()
  /** Set while start applies discovery: a failed write is then an issue, not a failed start. */
  private starting = false
  private readonly isDisabled = (id: string): boolean => this.control(id).disabled !== undefined

  /**
   * @param discover finds the rulesets installed now; called at start and on
   *   every rescan.
   */
  constructor(
    private readonly deps: RunnerDeps,
    private readonly store: Store,
    private readonly discover: () => DiscoveryResult = () => NO_RULESETS
  ) {
    this.presence = new PathPresence(deps.subscriptions)
    const contents = store.load()
    this.issues = [...contents.issues]
    this.actions = contents.log
    this.controls = contents.controls
    // A rule file that could not be read is still on disk: a create must not overwrite it.
    this.stored = new Set([...contents.rules.map((r) => r.slug), ...contents.unreadableRules])
    for (const { slug, value } of contents.rules) {
      const result = validateRule(value)
      const detector = isRecord(value) && isRecord(value.detector) ? value.detector : undefined
      if (
        (!result.ok || result.value.slug !== slug) &&
        detector?.type === 'accumulator' &&
        typeof detector.measure === 'string'
      ) {
        this.unloadedMeasures.set(slug, detector.measure)
      }
      if (!result.ok) {
        const errors = result.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')
        this.issues.push(`stored rule ${slug} is not valid and does not run: ${errors}`)
      } else if (result.value.slug !== slug) {
        this.issues.push(`stored rule ${slug} has the slug ${result.value.slug} and does not run`)
      } else {
        this.rulesBySlug.set(slug, result.value)
      }
    }
    this.retained = toMaps(contents.accumulators)
    this.unreadable = new Set(contents.unreadableRules)
  }

  /**
   * Loads the rulesets and starts evaluating, adopting the alerts SKAR
   * already has in core. A start that throws leaves no subscription behind.
   */
  start(): void {
    try {
      this.startEvaluating()
    } catch (err) {
      // The plugin is started again on the next configuration save; each
      // failed start would otherwise leave its subscriptions running. A
      // runner that fails to start stops itself.
      this.presence.stop()
      throw err
    }
  }

  private startEvaluating(): void {
    // A full disk must not keep every rule, user rules included, from
    // running: what could not be saved applies in this run.
    this.starting = true
    try {
      if (this.dropUserTotalsOfOtherMeasure()) this.saveDroppedTotals()
      this.applyDiscovery(this.discover())
    } finally {
      this.starting = false
    }
    // Core holding a rule's alert shows its hardware is there, and adopting
    // the alert keeps a restart from clearing it before the paths report.
    for (const alert of this.deps.alerts.list()) {
      const owned = ownedActiveAlert(alert, this.deps.pluginId)
      if (owned === undefined) continue
      const { origin, slug } = ruleRef(owned.ruleId)
      const rule = origin === USER_ORIGIN ? undefined : this.find(origin, slug)
      if (rule !== undefined) this.present.set(owned.ruleId, pathSet(rule))
    }
    this.startRunner()
  }

  /** Starts the ruleset rules whose paths have appeared, then evaluates. */
  tick(): void {
    this.presence.prune()
    for (const [origin, { rules }] of this.rulesetsBySlug) {
      for (const rule of rules.values()) {
        const id = ruleId(origin, rule.slug)
        if (this.missingPaths(id, rule).length === 0) this.present.set(id, pathSet(rule))
        this.sync(origin, rule)
      }
    }
    this.runner?.tick()
  }

  /**
   * Saves accumulator totals that changed since the last successful save;
   * throws when the store cannot write them. Unchanged totals are not
   * rewritten, to spare flash storage a flushed write every minute.
   */
  checkpoint(): void {
    const held = new Map([...this.retained, ...(this.runner?.accumulators() ?? [])])
    const checkpoints: Checkpoints = Object.fromEntries(
      [...held].map(([id, { measure, totals }]) => [
        id,
        { measure, totals: Object.fromEntries(totals) }
      ])
    )
    const text = JSON.stringify(checkpoints)
    if (text === this.lastCheckpoint) return
    this.store.saveCheckpoints(checkpoints)
    this.lastCheckpoint = text
    this.saved(TOTALS)
  }

  /**
   * Checkpoints and stops evaluating. Alerts are left in place: stop runs on
   * every configuration save.
   */
  stop(): void {
    try {
      this.checkpoint()
    } finally {
      this.presence.stop()
      this.runner?.stop()
    }
  }

  userRules(): Rule[] {
    return [...this.rulesBySlug.values()]
  }

  rules(): RuleEntry[] {
    return this.allLoaded().map(({ origin, rule }) => this.entry(origin, rule))
  }

  rule(origin: string, slug: string): RuleEntry | undefined {
    const rule = this.find(origin, slug)
    return rule === undefined ? undefined : this.entry(origin, rule)
  }

  /** The operator action log, newest first. */
  log(): LogEntry[] {
    return [...this.actions].reverse()
  }

  /** The loaded rulesets, in discovery order, and the problems of the last discovery. */
  rulesets(): RulesetListing {
    const rulesets = [...this.rulesetsBySlug].map(([slug, { loaded, rules }]) => {
      const control = this.rulesetControl(slug)
      const { ruleset } = loaded
      const missing = [...rules.values()].flatMap((rule) =>
        this.missingPaths(ruleId(slug, rule.slug), rule)
      )
      return {
        slug,
        name: ruleset.name,
        version: ruleset.version,
        ...(ruleset.description === undefined ? {} : { description: ruleset.description }),
        source: loaded.source,
        ...(loaded.package === undefined ? {} : { package: loaded.package }),
        enabled: control?.enabled ?? false,
        parameters: ruleset.parameters ?? [],
        values: control?.parameters ?? {},
        rules: [...rules.keys()],
        missingPaths: [...new Set(missing)],
        notices: control?.notices ?? []
      }
    })
    return { rulesets, problems: this.problems }
  }

  ruleset(slug: string): RulesetEntry | undefined {
    return this.rulesets().rulesets.find((r) => r.slug === slug)
  }

  /**
   * Discovers the rulesets again and applies what changed: a new ruleset
   * appears disabled, an upgraded one is applied as at start, and a removed
   * one stops its rules and clears their alerts. Rules that did not change
   * keep running untouched. Throws when the store cannot write.
   */
  rescan(actor: string): RulesetListing {
    this.applyDiscovery(this.discover())
    this.record({ at: this.now(), actor, action: 'rescan' })
    return this.rulesets()
  }

  /**
   * Enables or disables a ruleset, starting or stopping each of its rules
   * that is enabled itself. Setting the current value does nothing. Throws
   * when the store cannot write.
   */
  setRulesetEnabled(slug: string, enabled: boolean, actor: string): ControlOutcome {
    const state = this.rulesetsBySlug.get(slug)
    const control = this.rulesetControl(slug)
    if (state === undefined || control === undefined) return 'notFound'
    if (control.enabled === enabled) return 'ok'
    this.saveControls(this.withRuleset(slug, { ...control, enabled }))
    for (const rule of state.rules.values()) this.sync(slug, rule)
    this.record({ at: this.now(), actor, action: enabled ? 'enable' : 'disable', ruleset: slug })
    return 'ok'
  }

  /**
   * Replaces a ruleset's parameter values; parameters left out take their
   * defaults. Only the rules whose resolved form changes are edited, with
   * the edit semantics of a user rule. Throws when the store cannot write.
   */
  setRulesetParameters(slug: string, values: unknown, actor: string): ParametersOutcome {
    const state = this.rulesetsBySlug.get(slug)
    const control = this.rulesetControl(slug)
    if (state === undefined || control === undefined) return { ok: false, reason: 'notFound' }
    const resolved = withParameters(state.loaded.ruleset, values)
    if (!resolved.ok) return { ok: false, reason: 'invalid', errors: resolved.errors }
    const { parameters, rules } = resolved.value
    if (JSON.stringify(parameters) === JSON.stringify(control.parameters)) return { ok: true }
    this.saveControls(
      this.withRuleset(slug, { ...control, parameters, rules: recordedRules(rules) })
    )
    this.presence.watch(rules.flatMap(rulePaths))
    let drops = false
    for (const rule of rules) {
      const previous = state.rules.get(rule.slug)
      state.rules.set(rule.slug, rule)
      if (previous !== undefined) drops = this.editRulesetRule(slug, previous, rule) || drops
    }
    // Logged first: the change is applied even when the checkpoint fails.
    try {
      this.record({ at: this.now(), actor, action: 'parameters', ruleset: slug })
    } finally {
      if (drops) this.checkpoint()
    }
    return { ok: true }
  }

  /** Dismisses a ruleset's notices. Throws when the store cannot write. */
  dismissNotices(slug: string, actor: string): ControlOutcome {
    const control = this.rulesetControl(slug)
    if (!this.rulesetsBySlug.has(slug) || control === undefined) return 'notFound'
    if (control.notices.length === 0) return 'ok'
    this.saveControls(this.withRuleset(slug, { ...control, notices: [] }))
    this.record({ at: this.now(), actor, action: 'dismiss', ruleset: slug })
    return 'ok'
  }

  /**
   * Loads a discovery's rulesets over the ones loaded now. The operator's
   * settings are carried over and saved first; then rules that are gone are
   * removed, clearing their alerts, and new or changed rules are started or
   * edited. A rule that did not change is not touched.
   */
  private applyDiscovery(result: DiscoveryResult): void {
    const at = this.now()
    const upgrades = result.rulesets.map((loaded) => {
      const stored = this.rulesetControl(loaded.slug)
      return { loaded, upgrade: upgradeRuleset(loaded.ruleset, stored, at) }
    })
    const removed = upgrades.flatMap(({ loaded, upgrade }) =>
      upgrade.removed.map((slug) => ruleId(loaded.slug, slug))
    )
    const rules = Object.fromEntries(
      Object.entries(this.controls.rules).filter(([id]) => !removed.includes(id))
    )
    let next: Controls = { ...this.controls, rules }
    for (const { loaded, upgrade } of upgrades) {
      next = { ...next, rulesets: { ...next.rulesets, [loaded.slug]: upgrade.control } }
    }
    // Nothing is written when nothing changed, as on most starts.
    if (JSON.stringify(next) !== JSON.stringify(this.controls)) this.saveControls(next)
    this.problems = result.problems

    const found = new Set(result.rulesets.map((r) => r.slug))
    for (const [slug, { rules: gone }] of this.rulesetsBySlug) {
      if (found.has(slug)) continue
      this.rulesetsBySlug.delete(slug)
      // Its totals are kept, as a disabled ruleset's are, for the ruleset coming back.
      for (const rule of gone.values()) this.stopRule(ruleId(slug, rule.slug))
    }
    let drops = removed.some((id) => this.hasTotal(id))
    for (const id of removed) {
      this.runner?.remove(id)
      this.retained.delete(id)
    }

    const installed: LoadedRule[] = []
    const changes: { origin: string; previous: Rule; rule: Rule }[] = []
    for (const { loaded, upgrade } of upgrades) {
      const origin = loaded.slug
      const before = this.rulesetsBySlug.get(origin)?.rules
      const after = new Map(upgrade.rules.map((rule) => [rule.slug, rule]))
      this.rulesetsBySlug.set(origin, { loaded, rules: after })
      for (const rule of upgrade.rules) {
        const previous = before?.get(rule.slug)
        if (previous === undefined) {
          // With no rule in memory, at start or on a ruleset's return, a
          // total says what it was built under.
          const id = ruleId(origin, rule.slug)
          drops = this.dropTotalOfOtherMeasure(id, measureOf(rule)) || drops
          installed.push({ origin, rule })
        } else if (JSON.stringify(previous) !== JSON.stringify(rule)) {
          changes.push({ origin, previous, rule })
        }
      }
    }
    this.presence.watch(upgrades.flatMap(({ upgrade }) => upgrade.rules.flatMap(rulePaths)))
    for (const { origin, rule } of installed) this.sync(origin, rule)
    let edits = false
    for (const { origin, previous, rule } of changes) {
      edits = this.editRulesetRule(origin, previous, rule) || edits
    }
    if (drops || edits) this.saveDroppedTotals()
  }

  /**
   * Checkpoints a drop at once; while starting, a failure is an issue. A
   * dropped total left on disk would come back after a restart for a rule
   * that took up its old measure again.
   */
  private saveDroppedTotals(): void {
    this.tolerating(TOTALS, 'the next checkpoint retries', () => {
      this.checkpoint()
    })
  }

  /** Drops the stored totals of user rules built under another measure than their rule file's. */
  private dropUserTotalsOfOtherMeasure(): boolean {
    let drops = false
    for (const id of this.retained.keys()) {
      const { origin, slug } = ruleRef(id)
      if (origin !== USER_ORIGIN || !this.stored.has(slug) || this.unreadable.has(slug)) continue
      const rule = this.rulesBySlug.get(slug)
      const measure = rule === undefined ? this.unloadedMeasures.get(slug) : measureOf(rule)
      drops = this.dropTotalOfOtherMeasure(id, measure) || drops
    }
    return drops
  }

  /** Runs a write; while starting, a failure is reported as an issue instead of thrown. */
  private tolerating(what: string, then: string, write: () => void): void {
    try {
      write()
    } catch (err) {
      if (!this.starting) throw err
      const issue = `${what} could not be saved (${errorMessage(err)}); ${then}`
      if (!this.issues.includes(issue)) this.issues.push(issue)
    }
  }

  /** Removes the start issue about a write that has now succeeded. */
  private saved(what: string): void {
    const at = this.issues.findIndex((issue) => issue.startsWith(`${what} could not be saved`))
    if (at !== -1) this.issues.splice(at, 1)
  }

  /**
   * Applies a changed ruleset rule, already in its ruleset's state, with the
   * edit semantics of a user rule. Returns whether it drops an accumulator total.
   */
  private editRulesetRule(origin: string, previous: Rule, rule: Rule): boolean {
    const id = ruleId(origin, rule.slug)
    const carries = carriesTotals(previous, rule)
    const drops = this.hasTotal(id) && !carries
    // Stopped first, so a total the edit drops is not retained on the way out.
    if (!this.shouldRun(origin, rule)) this.stopRule(id)
    if (!carries) this.retained.delete(id)
    if (this.runner?.has(id) === true) this.runner.update({ origin, rule })
    else this.sync(origin, rule)
    return drops
  }

  /**
   * Drops a retained total built under another measure than the one given,
   * none for a rule that is not an accumulator. Returns whether it did.
   */
  private dropTotalOfOtherMeasure(id: string, measure: string | undefined): boolean {
    const retained = this.retained.get(id)
    if (retained === undefined || retained.measure === measure) return false
    this.retained.delete(id)
    return true
  }

  /** Stops a rule, clearing its alerts and keeping its totals, as disabling its ruleset does. */
  private stopRule(id: string): void {
    const runner = this.runner
    if (!runner?.has(id)) return
    const totals = runner.accumulators().get(id)
    if (totals !== undefined) this.retained.set(id, totals)
    runner.remove(id)
  }

  /** Creates or replaces the user rule with a validated rule's slug; throws when the store cannot write. */
  private saveRule(rule: Rule): SaveOutcome {
    if (!this.rulesBySlug.has(rule.slug) && this.rulesBySlug.size >= MAX_RULES) {
      const message = `at most ${String(MAX_RULES)} rules`
      return { ok: false, reason: 'invalid', errors: [{ path: '', message }] }
    }
    const id = this.idOf(rule.slug)
    const carries = this.carriesTotal(rule)
    const drops = this.hasTotal(id) && !carries
    this.store.saveRule(rule)
    this.stored.add(rule.slug)
    this.unloadedMeasures.delete(rule.slug)
    // While a rule is not evaluated an edit keeps the total, as the runner would.
    if (!carries) this.retained.delete(id)
    this.rulesBySlug.set(rule.slug, rule)
    if (this.runner !== undefined) {
      // Once started, only a rule the runner does not hold has a retained
      // total; the runner takes it over.
      const retained = this.retained.get(id)
      this.retained.delete(id)
      this.runner.update({ origin: USER_ORIGIN, rule }, retained?.totals)
    }
    // Written now: the next checkpoint could come after a restart that would
    // give the old total to the new rule.
    if (drops) this.checkpoint()
    return { ok: true, value: rule }
  }

  /**
   * Whether saving the rule keeps the accumulator total its slug has: an
   * edit of a loaded rule per the edit semantics, or the replacement of a
   * stored rule that did not load, by the accumulator measure its file names.
   */
  private carriesTotal(rule: Rule): boolean {
    const previous = this.rulesBySlug.get(rule.slug)
    if (previous !== undefined) return carriesTotals(previous, rule)
    return (
      rule.detector.type === 'accumulator' &&
      this.unloadedMeasures.get(rule.slug) === rule.detector.measure
    )
  }

  /** Whether the rule has an accumulator total, running or retained. */
  private hasTotal(id: string): boolean {
    return this.totalsOf(id) !== undefined
  }

  /** Whether the rule has an accumulator total above zero: one an operator would lose. */
  private hasNonZeroTotal(id: string): boolean {
    return [...(this.totalsOf(id)?.totals.values() ?? [])].some((total) => total !== 0)
  }

  private totalsOf(id: string): Accumulated | undefined {
    return this.retained.get(id) ?? this.runner?.accumulators().get(id)
  }

  /** Saves a new user rule; a stored rule file with its slug, valid or not, makes it exist. */
  createRule(input: unknown): SaveOutcome {
    const result = validateRule(input)
    if (!result.ok) return { ok: false, reason: 'invalid', errors: result.errors }
    if (this.stored.has(result.value.slug)) return { ok: false, reason: 'exists' }
    return this.saveRule(this.withCanonicalSources(result.value))
  }

  /** Replaces the stored user rule `slug` with an input of the same slug. */
  replaceRule(slug: string, input: unknown): SaveOutcome {
    const checked = this.checkEdit(slug, input)
    return checked.ok ? this.saveRule(checked.value) : checked
  }

  /** What replacing the user rule `slug` with the input would do, without doing it. */
  previewRule(slug: string, input: unknown): PreviewOutcome {
    const checked = this.checkEdit(slug, input)
    if (!checked.ok) return checked
    const current = this.rulesBySlug.get(slug)
    // A stored rule that did not validate is not running: saving starts it.
    const changes =
      current === undefined
        ? []
        : structuralChanges(this.withCanonicalSources(current), checked.value)
    const status = this.runner?.status(this.idOf(slug))
    const activeAlerts = status?.instances.filter((i) => i.active).length ?? 0
    const restarts = changes.length > 0 || this.runner?.failedToStart(this.idOf(slug)) === true
    return {
      ok: true,
      value: {
        restarts,
        changes,
        activeAlerts,
        clearsActiveAlert: restarts && activeAlerts > 0,
        discardsTotal: this.hasNonZeroTotal(this.idOf(slug)) && !this.carriesTotal(checked.value)
      }
    }
  }

  /**
   * Deletes a stored user rule with its controls and clears its alerts.
   * False when there is no such rule; throws when the store cannot delete it.
   */
  deleteRule(slug: string, actor: string): boolean {
    if (!this.stored.has(slug)) return false
    const id = this.idOf(slug)
    const drops = this.hasTotal(id)
    this.store.deleteRule(slug)
    this.stored.delete(slug)
    this.unloadedMeasures.delete(slug)
    this.retained.delete(id)
    if (this.rulesBySlug.delete(slug)) this.runner?.remove(id)
    // Logged first: the delete is applied even when the checkpoint fails.
    try {
      this.record({ at: this.now(), actor, action: 'delete', rule: id })
    } finally {
      try {
        // Written now: a restart before the next checkpoint would give the old
        // total to a rule re-created with this slug.
        if (drops) this.checkpoint()
      } finally {
        if (own(this.controls.rules, id) !== undefined) {
          this.saveControls({ ...this.controls, rules: without(this.controls.rules, id) })
        }
      }
    }
    return true
  }

  /**
   * Zeroes an accumulator rule's total, restored and stored ones included,
   * and clears its alerts. Throws when the store cannot write the total.
   */
  resetAccumulator(origin: string, slug: string, actor: string): ResetOutcome {
    const rule = this.find(origin, slug)
    if (rule === undefined) return 'notFound'
    if (rule.detector.type !== 'accumulator') return 'notAccumulator'
    const id = ruleId(origin, slug)
    this.runner?.reset(id)
    this.retained.delete(id)
    // Logged first: the reset is applied even when the checkpoint fails.
    try {
      this.record({ at: this.now(), actor, action: 'reset', rule: id })
    } finally {
      // Written now: the next checkpoint could come after a restart that
      // would bring back the old total.
      this.checkpoint()
    }
    return 'reset'
  }

  /**
   * Disables a rule, replacing the record of a rule already disabled: it goes
   * on evaluating, so its accumulator keeps counting, but raises nothing, and
   * its active alerts are cleared at once. An empty note is no note. Throws
   * when the store cannot write.
   */
  disableRule(
    origin: string,
    slug: string,
    note: string | undefined,
    actor: string
  ): ControlOutcome {
    if (this.find(origin, slug) === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    const noted = note === undefined || note === '' ? {} : { note }
    const disabled: Disabled = { since: this.now(), actor, ...noted }
    this.saveControls(this.withRule(id, { disabled }))
    this.runner?.refresh(id)
    this.record({ at: disabled.since, actor, action: 'disable', rule: id, ...noted })
    return 'ok'
  }

  /**
   * Enables a disabled rule; one whose condition holds raises a new alert at
   * once. Enabling an enabled rule does nothing. Throws when the store
   * cannot write.
   */
  enableRule(origin: string, slug: string, actor: string): ControlOutcome {
    if (this.find(origin, slug) === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    if (!this.isDisabled(id)) return 'ok'
    this.saveControls(this.withRule(id, {}))
    this.runner?.refresh(id)
    this.record({ at: this.now(), actor, action: 'enable', rule: id })
    return 'ok'
  }

  /**
   * Starts a runner on the stored rules and hands it their retained totals.
   * On a throw nothing changes: a runner that failed to start holds no
   * totals, so keeping it would let the next checkpoint drop them.
   */
  private startRunner(): void {
    const loaded = this.loaded()
    const ids = new Set(loaded.map(({ origin, rule }) => ruleId(origin, rule.slug)))
    const accumulated = new Map(
      [...this.retained].filter(([id]) => ids.has(id)).map(([id, { totals }]) => [id, totals])
    )
    const runner = new RuleRunner(this.deps, loaded, accumulated, this.isDisabled)
    try {
      runner.start()
    } catch (err) {
      runner.stop()
      throw err
    }
    for (const id of accumulated.keys()) this.retained.delete(id)
    this.runner = runner
  }

  private checkEdit(slug: string, input: unknown): SaveOutcome {
    if (!this.stored.has(slug)) return { ok: false, reason: 'notFound' }
    const result = validateRule(input)
    if (!result.ok) return { ok: false, reason: 'invalid', errors: result.errors }
    if (result.value.slug !== slug) return { ok: false, reason: 'slugMismatch' }
    return { ok: true, value: this.withCanonicalSources(result.value) }
  }

  // A pick stored in the address form of an NMEA 2000 device would stop
  // matching once the device claims another address.
  private withCanonicalSources(rule: Rule): Rule {
    return canonicalSources(rule, this.deps.canonicalSource ?? asGiven)
  }

  private record(entry: LogEntry): void {
    this.actions.push(entry)
    this.actions.splice(0, this.actions.length - LOG_LIMIT)
    this.store.saveLog(this.actions)
  }

  private now(): string {
    return this.deps.wallClock().toISOString()
  }

  private entry(origin: string, rule: Rule): RuleEntry {
    const id = ruleId(origin, rule.slug)
    const { disabled } = this.control(id)
    const loaded = this.rulesetsBySlug.get(origin)?.loaded
    return {
      origin,
      slug: rule.slug,
      ...(loaded === undefined
        ? {}
        : {
            ruleset: {
              name: loaded.ruleset.name,
              version: loaded.ruleset.version,
              ...(loaded.package === undefined ? {} : { package: loaded.package })
            }
          }),
      rule,
      ...(disabled === undefined ? {} : { disabled }),
      status: this.runner?.status(id) ?? this.notEvaluatedStatus(origin, rule)
    }
  }

  private notEvaluatedStatus(origin: string, rule: Rule): NotEvaluatedStatus {
    const id = ruleId(origin, rule.slug)
    const totals = this.retained.get(id)?.totals
    if (origin !== USER_ORIGIN && !this.rulesetEnabled(origin)) {
      return notEvaluated(rule, totals, 'ruleset is disabled')
    }
    if (this.runner === undefined) return notEvaluated(rule, totals, 'not started')
    const missing = this.missingPaths(id, rule).map((path) => `path ${path} has not been seen`)
    // Its paths have appeared since the last tick, which starts it.
    if (missing.length === 0) return notEvaluated(rule, totals, 'starts at the next tick')
    return notEvaluated(rule, totals, 'ruleset path missing', missing)
  }

  private idOf(slug: string): string {
    return ruleId(USER_ORIGIN, slug)
  }

  private find(origin: string, slug: string): Rule | undefined {
    return origin === USER_ORIGIN
      ? this.rulesBySlug.get(slug)
      : this.rulesetsBySlug.get(origin)?.rules.get(slug)
  }

  /** Every loaded rule, running or not: user rules, then each ruleset's. */
  private allLoaded(): LoadedRule[] {
    return [
      ...[...this.rulesBySlug.values()].map((rule) => ({ origin: USER_ORIGIN, rule })),
      ...[...this.rulesetsBySlug].flatMap(([origin, { rules }]) =>
        [...rules.values()].map((rule) => ({ origin, rule }))
      )
    ]
  }

  /** The rules the runner evaluates. */
  private loaded(): LoadedRule[] {
    return this.allLoaded().filter(({ origin, rule }) => this.shouldRun(origin, rule))
  }

  /**
   * Whether a rule is to be evaluated: a user rule always, disabled or not,
   * and a ruleset rule while its ruleset is enabled and the server has had
   * its paths.
   */
  private shouldRun(origin: string, rule: Rule): boolean {
    if (origin === USER_ORIGIN) return true
    const id = ruleId(origin, rule.slug)
    return this.rulesetEnabled(origin) && this.missingPaths(id, rule).length === 0
  }

  /** Starts or stops a rule in the runner as `shouldRun` says, keeping its totals either way. */
  private sync(origin: string, rule: Rule): void {
    const runner = this.runner
    if (runner === undefined) return
    const id = ruleId(origin, rule.slug)
    const should = this.shouldRun(origin, rule)
    if (should === runner.has(id)) return
    if (should) {
      const retained = this.retained.get(id)
      this.retained.delete(id)
      runner.update({ origin, rule }, retained?.totals)
    } else {
      this.stopRule(id)
    }
  }

  /** The paths of a ruleset rule the server has not had in this run; none for a rule present with these paths. */
  private missingPaths(id: string, rule: Rule): string[] {
    if (this.present.get(id) === pathSet(rule)) return []
    return rulePaths(rule).filter((path) => !this.presence.has(path))
  }

  private rulesetEnabled(slug: string): boolean {
    return this.rulesetControl(slug)?.enabled ?? false
  }

  private rulesetControl(slug: string): RulesetControl | undefined {
    return own(this.controls.rulesets ?? {}, slug)
  }

  private control(id: string): RuleControl {
    return own(this.controls.rules, id) ?? {}
  }

  /** Controls with a rule's replaced; an enabled rule has no entry. */
  private withRule(id: string, { disabled }: RuleControl): Controls {
    const rules =
      disabled === undefined
        ? without(this.controls.rules, id)
        : { ...this.controls.rules, [id]: { disabled } }
    return { ...this.controls, rules }
  }

  private withRuleset(slug: string, control: RulesetControl): Controls {
    return { ...this.controls, rulesets: { ...this.controls.rulesets, [slug]: control } }
  }

  private saveControls(controls: Controls): void {
    this.tolerating(SETTINGS, 'they apply until the next change saves them', () => {
      this.store.saveControls(controls)
      this.saved(SETTINGS)
    })
    this.controls = controls
  }
}
