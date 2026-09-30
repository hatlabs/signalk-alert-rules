import type { Verdict } from './alerts/badge.js'
import { ruleId, ruleRef } from './alerts/paths.js'
import {
  RuleRunner,
  type LoadedRule,
  type RunnerDeps,
  type RunnerInstanceStatus,
  type RunnerRuleStatus
} from './alerts/runner.js'
import { ownedActiveAlert } from './alerts/reconcile.js'
import type { Progress } from './engine/detectors/index.js'
import { carriesTotals, structuralChanges } from './engine/evaluator.js'
import {
  readsPath,
  signalPaths,
  type FrozenGates,
  type Suppressions
} from './engine/suppression.js'
import { MAX_RULES, type Rule } from './model/rule.js'
import { USER_ORIGIN, type Parameter } from './model/ruleset.js'
import { validateRule, type ValidationError } from './model/validate.js'
import type { DiscoveryProblem, DiscoveryResult, LoadedRuleset } from './rulesets/discovery.js'
import { upgradeRuleset, withParameters } from './rulesets/overrides.js'
import { PathPresence, rulePaths } from './rulesets/presence.js'
import type {
  Checkpoints,
  Controls,
  EvaluationSwitch,
  InputSuppression,
  LogEntry,
  RuleControl,
  RulesetControl,
  RulesetNotice,
  Store,
  Suppression
} from './store/store.js'
import { errorMessage, isRecord, own } from './util.js'

/** How often rules are evaluated: detector durations resolve to this. */
export const TICK_MS = 1000

/** How often accumulator totals are saved, bounding what a crash loses. */
export const CHECKPOINT_MS = 60_000

/** How many operator actions the log keeps. */
export const LOG_LIMIT = 200

/** The actor recorded when a suppression ends by itself. */
export const AUTO_END_ACTOR = 'auto-end'

export type NotEvaluatedReason =
  'disabled' | 'ruleset is disabled' | 'evaluation is off' | 'ruleset path missing'

/** A row of a rule that is not evaluated: one per accumulator total it keeps. */
export interface NotEvaluatedInstance extends Verdict {
  /** For a wildcard rule; the name is not kept with the total. */
  instance?: { segment: string }
  progress: Progress
}

/**
 * The status of a rule that is not being evaluated: disabled, or inactive for
 * a ruleset rule whose paths the server has not had yet.
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
  enabled: boolean
  note?: string
  /** The rule's own suppression, not one of an input it reads. */
  suppression?: Suppression
  status: RuleStatus
}

export interface SuppressionRequest {
  note?: string
  autoEndAfter?: number
}

/** A rule by its id and by the origin and slug the id is made of. */
export type RuleRef = ReturnType<typeof ruleRef>

/** A suppression in force, with what it suppresses. */
export type SuppressionEntry = Suppression &
  (({ scope: 'rule' } & RuleRef) | { scope: 'input'; path: string })

/** What suppressing an input path would do, without doing it. */
export interface InputSuppressionPreview {
  path: string
  /** Rules whose detector or combinator reads the path, with the wildcard instance that does. */
  suppresses: (RuleRef & { instance?: string })[]
  /** Gates that read the path, and the state each instance of their rule would be frozen at. */
  freezes: (RuleRef & { gate: number; states: { instance?: string; holds: boolean }[] })[]
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

function toMaps(checkpoints: Checkpoints): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(checkpoints).map(([id, totals]) => [id, new Map(Object.entries(totals))])
  )
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

/** The gate states a preview lists, as an input suppression stores them; undefined for none. */
function frozenGates(freezes: InputSuppressionPreview['freezes']): FrozenGates | undefined {
  const frozen: FrozenGates = {}
  for (const { rule, gate, states } of freezes) {
    if (states.length === 0) continue
    const instances = Object.fromEntries(states.map((s) => [s.instance ?? '', s.holds]))
    frozen[rule] = { ...own(frozen, rule), [String(gate)]: instances }
  }
  return Object.keys(frozen).length === 0 ? undefined : frozen
}

/** An input suppression as listed: the stored gate states are the engine's, not the operator's. */
function inputEntry(path: string, suppression: InputSuppression): SuppressionEntry {
  const { frozen: _frozen, ...listed } = suppression
  return { scope: 'input', path, ...listed }
}

function notEvaluated(
  rule: Rule,
  totals: ReadonlyMap<string, number> | undefined,
  reason: NotEvaluatedReason,
  issues: string[] = []
): NotEvaluatedStatus {
  const badge: NotEvaluatedStatus['badge'] =
    reason === 'ruleset path missing' ? 'inactive' : 'disabled'
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
 * How long every instance has stayed clear, counted from the suppression's
 * start; zero without an instance, which leaves nothing to judge by.
 */
function stayedClearFor(instances: readonly Pick<RunnerInstanceStatus, 'clearFor'>[]): number {
  if (instances.length === 0) return 0
  return Math.min(...instances.map((i) => i.clearFor ?? 0))
}

/**
 * SKAR's running state: the stored rules, the evaluation switch, the
 * operator's per-rule controls and input suppressions, the operator action
 * log and, while evaluation is on, the runner evaluating the enabled rules.
 * Every change is persisted first and then applied to the one rule it
 * concerns, so other rules keep their timers; a change the store fails to
 * write is not applied.
 */
export class Application {
  /** Problems found while loading, for the plugin status. */
  readonly issues: string[]
  private evaluationSwitch: EvaluationSwitch
  private runner: RuleRunner | undefined
  private readonly rulesBySlug = new Map<string, Rule>()
  /** Slugs of stored rule files, loaded or not, so a skipped one can be deleted. */
  private readonly stored: Set<string>
  /**
   * Checkpointed totals of rules the runner does not hold: a stored rule that
   * no longer validates, kept until the rule is deleted or saved again, and
   * every rule's while evaluation is off.
   */
  private readonly retained: Map<string, Map<string, number>>
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
   * core held at start. A rule never goes back to inactive in the run.
   */
  private readonly present = new Set<string>()
  private readonly suppressionsInForce: Suppressions = {
    rule: (id) => own(this.controls.rules, id)?.suppression,
    path: (path) => own(this.controls.inputs, path)
  }

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
    this.evaluationSwitch = contents.evaluation
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
  }

  get evaluation(): EvaluationSwitch {
    return this.evaluationSwitch
  }

  /**
   * Loads the rulesets and starts evaluating, adopting the alerts SKAR
   * already has in core. With evaluation off nothing is evaluated and
   * nothing is cleared: the alerts were cleared when it was turned off.
   */
  start(): void {
    this.applyDiscovery(this.discover())
    // Core holding a rule's alert shows its hardware is there, and adopting
    // the alert keeps a restart from clearing it before the paths report.
    for (const alert of this.deps.alerts.list()) {
      const owned = ownedActiveAlert(alert, this.deps.pluginId)
      if (owned !== undefined && !owned.ruleId.startsWith(`${USER_ORIGIN}.`)) {
        this.present.add(owned.ruleId)
      }
    }
    if (this.evaluationSwitch.enabled) this.startRunner(true)
  }

  /**
   * Starts the ruleset rules whose paths have appeared, evaluates, then ends
   * the suppressions whose condition has stayed clear long enough. Throws
   * when one of those ends cannot be saved.
   */
  tick(): void {
    this.presence.prune()
    for (const [origin, { rules }] of this.rulesetsBySlug) {
      for (const rule of rules.values()) this.sync(origin, rule)
    }
    this.runner?.tick()
    this.endClearedSuppressions()
  }

  /**
   * Saves accumulator totals that changed since the last successful save;
   * throws when the store cannot write them. Unchanged totals are not
   * rewritten, to spare flash storage a flushed write every minute.
   */
  checkpoint(): void {
    const totals = new Map([...this.retained, ...(this.runner?.accumulators() ?? [])])
    const checkpoints = Object.fromEntries(
      [...totals].map(([id, t]) => [id, Object.fromEntries(t)])
    )
    const text = JSON.stringify(checkpoints)
    if (text === this.lastCheckpoint) return
    this.store.saveCheckpoints(checkpoints)
    this.lastCheckpoint = text
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
    this.saveControls(this.withRuleset(slug, { ...control, parameters }))
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
    const upgrades = result.rulesets.map((loaded) => ({
      loaded,
      upgrade: upgradeRuleset(loaded.ruleset, this.rulesetControl(loaded.slug), at)
    }))
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
      // Its totals are kept, like a disabled rule's, for the ruleset coming back.
      for (const rule of gone.values()) this.stopRule(ruleId(slug, rule.slug))
    }
    const drops = removed.some((id) => this.hasTotal(id))
    for (const id of removed) {
      this.runner?.remove(id)
      this.retained.delete(id)
      this.dropFrozenGates(id)
    }

    const changes: { origin: string; previous: Rule | undefined; rule: Rule }[] = []
    for (const { loaded, upgrade } of upgrades) {
      const before = this.rulesetsBySlug.get(loaded.slug)?.rules
      const after = new Map(upgrade.rules.map((rule) => [rule.slug, rule]))
      this.rulesetsBySlug.set(loaded.slug, { loaded, rules: after })
      for (const rule of upgrade.rules) {
        const previous = before?.get(rule.slug)
        if (JSON.stringify(previous) !== JSON.stringify(rule)) {
          changes.push({ origin: loaded.slug, previous, rule })
        }
      }
    }
    this.presence.watch(upgrades.flatMap(({ upgrade }) => upgrade.rules.flatMap(rulePaths)))
    let edits = false
    for (const { origin, previous, rule } of changes) {
      if (previous === undefined) this.sync(origin, rule)
      else edits = this.editRulesetRule(origin, previous, rule) || edits
    }
    // Written now: the next checkpoint could come after a restart that would
    // give an old total to a rule that no longer carries it.
    if (drops || edits) this.checkpoint()
  }

  /**
   * Applies a changed ruleset rule, already in its ruleset's state, with the
   * edit semantics of a user rule. Returns whether it drops an accumulator total.
   */
  private editRulesetRule(origin: string, previous: Rule, rule: Rule): boolean {
    const id = ruleId(origin, rule.slug)
    const carries = carriesTotals(previous, rule)
    const drops = this.hasTotal(id) && !carries
    if (structuralChanges(previous, rule).includes('gates')) this.dropFrozenGates(id)
    if (!carries) this.retained.delete(id)
    if (this.runner?.has(id) === true) this.runner.update({ origin, rule })
    else this.sync(origin, rule)
    return drops
  }

  /** Stops a rule, clearing its alerts and keeping its totals, as disabling it does. */
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
    const previous = this.rulesBySlug.get(rule.slug)
    // Stored gate states are by gate index: a gate reordered or changed
    // must not inherit another's, so the new gates take one reading instead.
    if (previous !== undefined && structuralChanges(previous, rule).includes('gates')) {
      this.dropFrozenGates(id)
    }
    this.store.saveRule(rule)
    this.stored.add(rule.slug)
    this.unloadedMeasures.delete(rule.slug)
    // While a rule is not evaluated an edit keeps the total, as the runner would.
    if (!carries) this.retained.delete(id)
    this.rulesBySlug.set(rule.slug, rule)
    if (this.runner !== undefined && this.control(id).enabled) {
      // While evaluation is on, only a rule the runner does not hold has a
      // retained total; the runner takes it over.
      const retained = this.retained.get(id)
      this.retained.delete(id)
      this.runner.update({ origin: USER_ORIGIN, rule }, retained)
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
    return [...(this.totalsOf(id)?.values() ?? [])].some((total) => total !== 0)
  }

  private totalsOf(id: string): ReadonlyMap<string, number> | undefined {
    return this.retained.get(id) ?? this.runner?.accumulators().get(id)
  }

  /** Saves a new user rule; a stored rule file with its slug, valid or not, makes it exist. */
  createRule(input: unknown): SaveOutcome {
    const result = validateRule(input)
    if (!result.ok) return { ok: false, reason: 'invalid', errors: result.errors }
    if (this.stored.has(result.value.slug)) return { ok: false, reason: 'exists' }
    return this.saveRule(result.value)
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
    const changes = current === undefined ? [] : structuralChanges(current, checked.value)
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
        // Stored gate states are by gate index, so a rule re-created with this
        // slug would inherit them for gates they were not taken from.
        this.dropFrozenGates(id)
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
   * Turns evaluation off, clearing every alert SKAR owns, or on, starting
   * every rule from nothing. Accumulator totals are kept either way. Setting
   * the current value does nothing. Throws when the store cannot write.
   */
  setEvaluation(enabled: boolean, actor: string): void {
    if (enabled === this.evaluationSwitch.enabled) return
    const at = this.now()
    const next = { enabled, actor, at }
    if (enabled) {
      // Saved only once the runner has started, so a runner that cannot
      // start leaves evaluation off rather than on with nothing evaluated.
      this.startRunner(false, () => {
        this.store.saveEvaluation(next)
      })
      this.evaluationSwitch = next
      this.record({ at, actor, action: 'evaluation', enabled })
      return
    }
    this.store.saveEvaluation(next)
    this.evaluationSwitch = next
    const runner = this.runner
    this.runner = undefined
    // Evaluation is off even when its alerts cannot be cleared: the runner
    // is dropped and its totals retained before the clear can throw.
    try {
      this.record({ at, actor, action: 'evaluation', enabled })
    } finally {
      if (runner !== undefined) {
        for (const [id, totals] of runner.accumulators()) this.retained.set(id, totals)
        runner.clearAll()
      }
    }
  }

  /**
   * Enables or disables a rule. A disabled rule is not evaluated: disabling
   * clears its alerts, and enabling starts it as a new rule. Its accumulator
   * totals are kept either way. Setting the current value does nothing.
   * Throws when the store cannot write.
   */
  setEnabled(origin: string, slug: string, enabled: boolean, actor: string): ControlOutcome {
    const rule = this.find(origin, slug)
    if (rule === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    const control = this.control(id)
    if (control.enabled === enabled) return 'ok'
    this.saveControls(this.withRule(id, { ...control, enabled }))
    this.sync(origin, rule)
    this.record({ at: this.now(), actor, action: enabled ? 'enable' : 'disable', rule: id })
    return 'ok'
  }

  /** Sets a rule's note; an empty note removes it. Throws when the store cannot write. */
  setNote(origin: string, slug: string, note: string, actor: string): ControlOutcome {
    if (this.find(origin, slug) === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    const control = this.control(id)
    const next = note === '' ? undefined : note
    if (next === control.note) return 'ok'
    this.saveControls(this.withRule(id, { ...control, note: next }))
    this.record({ at: this.now(), actor, action: 'note', rule: id })
    return 'ok'
  }

  /**
   * Suppresses a rule, replacing a suppression it has: it goes on evaluating
   * but raises nothing, and its active alerts are cleared. Throws when the
   * store cannot write.
   */
  suppressRule(
    origin: string,
    slug: string,
    request: SuppressionRequest,
    actor: string
  ): ControlOutcome {
    if (this.find(origin, slug) === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    const suppression = this.newSuppression(request, actor)
    this.saveControls(this.withRule(id, { ...this.control(id), suppression }))
    this.runner?.restartClearCount({ rule: id })
    this.runner?.refresh()
    this.record({ at: suppression.since, actor, action: 'suppress', rule: id })
    return 'ok'
  }

  /**
   * Ends a rule's own suppression; an alert whose condition holds is raised
   * as a new alert. A suppression the controls hold ends even for a rule that
   * did not load, and a rule that is not suppressed is left as it is. Throws
   * when the store cannot write.
   */
  endRuleSuppression(origin: string, slug: string, actor: string): ControlOutcome {
    const id = ruleId(origin, slug)
    if (this.control(id).suppression !== undefined) {
      this.endSuppressionOf(id, actor)
      return 'ok'
    }
    return this.find(origin, slug) === undefined ? 'notFound' : 'ok'
  }

  /**
   * Suppresses an exact concrete path, replacing a suppression it has: every
   * rule instance whose detector or combinator reads it is suppressed, and
   * every gate reading it keeps the state it has. Throws when the store
   * cannot write.
   */
  suppressInput(path: string, request: SuppressionRequest, actor: string): SuppressionEntry {
    // Stored, so a gate rebuilt while frozen, as on every restart, keeps its state.
    const frozen = frozenGates(this.previewInputSuppression(path).freezes)
    const suppression: InputSuppression = {
      ...this.newSuppression(request, actor),
      ...(frozen === undefined ? {} : { frozen })
    }
    this.saveControls({
      ...this.controls,
      inputs: { ...this.controls.inputs, [path]: suppression }
    })
    this.runner?.restartClearCount({ path })
    this.runner?.refresh()
    this.record({ at: suppression.since, actor, action: 'suppress', path })
    return inputEntry(path, suppression)
  }

  /** Ends an input suppression; false when there is none. Throws when the store cannot write. */
  endInputSuppression(path: string, actor: string): boolean {
    if (own(this.controls.inputs, path) === undefined) return false
    this.saveControls({ ...this.controls, inputs: without(this.controls.inputs, path) })
    this.runner?.refresh()
    this.record({ at: this.now(), actor, action: 'unsuppress', path })
    return true
  }

  /** Every suppression in force, newest first. */
  suppressions(): SuppressionEntry[] {
    const rules = Object.entries(this.controls.rules).flatMap(([id, { suppression }]) =>
      suppression === undefined ? [] : [{ scope: 'rule' as const, ...ruleRef(id), ...suppression }]
    )
    const inputs = Object.entries(this.controls.inputs).map(([path, suppression]) =>
      inputEntry(path, suppression)
    )
    return [...rules, ...inputs].sort((a, b) => b.since.localeCompare(a.since))
  }

  /** What suppressing an exact concrete path would suppress and freeze, as the rules stand now. */
  previewInputSuppression(path: string): InputSuppressionPreview {
    const suppresses: InputSuppressionPreview['suppresses'] = []
    const freezes: InputSuppressionPreview['freezes'] = []
    for (const { origin, rule } of this.allLoaded()) {
      const id = ruleId(origin, rule.slug)
      const ref = { rule: id, origin, slug: rule.slug }
      const read = readsPath(rule.signal, path)
      if (read.reads) {
        suppresses.push(read.instance === undefined ? ref : { ...ref, instance: read.instance })
      }
      const status = this.control(id).enabled ? this.runner?.status(id) : undefined
      ;(rule.gates ?? []).forEach((gate, i) => {
        const gateRead = readsPath(gate.signal, path)
        if (!gateRead.reads) return
        const states = (status?.instances ?? [])
          .filter(
            (row) => gateRead.instance === undefined || row.instance?.name === gateRead.instance
          )
          .map((row) => ({
            ...(row.instance === undefined ? {} : { instance: row.instance.name }),
            holds: row.gates[i]?.holds ?? false
          }))
        freezes.push({ ...ref, gate: i, states })
      })
    }
    return { path, suppresses, freezes }
  }

  private newSuppression({ note, autoEndAfter }: SuppressionRequest, actor: string): Suppression {
    return {
      since: this.now(),
      actor,
      ...(note === undefined || note === '' ? {} : { note }),
      ...(autoEndAfter === undefined ? {} : { autoEndAfter })
    }
  }

  private endSuppressionOf(id: string, actor: string): void {
    this.saveControls(this.withRule(id, { ...this.control(id), suppression: undefined }))
    this.runner?.refresh()
    this.record({ at: this.now(), actor, action: 'unsuppress', rule: id })
  }

  /**
   * Ends each suppression with an auto-end whose condition has stayed clear
   * for its time: for a rule, every instance of it; for an input, every
   * instance it suppresses directly, those whose detector or combinator
   * reads the path. Gates reading the path do not count. One that cannot be
   * saved stays for the next tick and does not keep the others from ending;
   * the failures are thrown once the pass is done.
   */
  private endClearedSuppressions(): void {
    const runner = this.runner
    if (runner === undefined) return
    const failures: string[] = []
    const end = (what: string, action: () => void) => {
      try {
        action()
      } catch (err) {
        failures.push(`${what}: ${errorMessage(err)}`)
      }
    }
    for (const [id, { enabled, suppression }] of Object.entries(this.controls.rules)) {
      const after = suppression?.autoEndAfter
      if (after === undefined || !enabled) continue
      const instances = runner.status(id)?.instances ?? []
      if (stayedClearFor(instances) >= after) {
        end(id, () => {
          this.endSuppressionOf(id, AUTO_END_ACTOR)
        })
      }
    }
    for (const [path, { autoEndAfter }] of Object.entries(this.controls.inputs)) {
      if (autoEndAfter === undefined) continue
      const direct = this.loaded().flatMap(({ origin, rule }) => {
        if (!readsPath(rule.signal, path).reads) return []
        const instances = runner.status(ruleId(origin, rule.slug))?.instances ?? []
        return instances.filter((row) => signalPaths(rule.signal, row.instance).includes(path))
      })
      if (stayedClearFor(direct) >= autoEndAfter) {
        end(path, () => {
          this.endInputSuppression(path, AUTO_END_ACTOR)
        })
      }
    }
    if (failures.length > 0) {
      throw new Error(`could not end a suppression by itself: ${failures.join('; ')}`)
    }
  }

  /**
   * Starts a runner on the stored rules and, once `commit` has succeeded too,
   * hands it their retained totals. On a throw from either, nothing changes:
   * a runner that failed to start holds no totals, so keeping it would let
   * the next checkpoint drop them.
   */
  private startRunner(adopt: boolean, commit?: () => void): void {
    const loaded = this.loaded()
    const ids = new Set(loaded.map(({ origin, rule }) => ruleId(origin, rule.slug)))
    const accumulated = new Map([...this.retained].filter(([id]) => ids.has(id)))
    const runner = new RuleRunner(this.deps, loaded, accumulated, this.suppressionsInForce)
    runner.start(adopt)
    try {
      commit?.()
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
    return result
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
    const { enabled, note, suppression } = this.control(id)
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
      enabled,
      ...(note === undefined ? {} : { note }),
      ...(suppression === undefined ? {} : { suppression }),
      status: this.runner?.status(id) ?? this.notEvaluatedStatus(origin, rule)
    }
  }

  private notEvaluatedStatus(origin: string, rule: Rule): NotEvaluatedStatus {
    const id = ruleId(origin, rule.slug)
    const totals = this.retained.get(id)
    if (!this.control(id).enabled) return notEvaluated(rule, totals, 'disabled')
    if (origin !== USER_ORIGIN && !this.rulesetEnabled(origin)) {
      return notEvaluated(rule, totals, 'ruleset is disabled')
    }
    if (this.runner === undefined) return notEvaluated(rule, totals, 'evaluation is off')
    const missing = this.missingPaths(id, rule).map((path) => `path ${path} has not been seen`)
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

  /** Every loaded rule, enabled or not: user rules, then each ruleset's. */
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
   * Whether a rule is to be evaluated while evaluation is on: it is enabled
   * and, for a ruleset rule, so is its ruleset and the server has had its paths.
   */
  private shouldRun(origin: string, rule: Rule): boolean {
    const id = ruleId(origin, rule.slug)
    if (!this.control(id).enabled) return false
    if (origin === USER_ORIGIN) return true
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
      runner.update({ origin, rule }, retained)
    } else {
      this.stopRule(id)
    }
  }

  /**
   * The paths of a ruleset rule the server has not had in this run. Once it
   * has had them all the rule counts as present for the rest of the run, so
   * that it never goes back to inactive.
   */
  private missingPaths(id: string, rule: Rule): string[] {
    if (this.present.has(id)) return []
    const missing = rulePaths(rule).filter((path) => !this.presence.has(path))
    if (missing.length === 0) this.present.add(id)
    return missing
  }

  private rulesetEnabled(slug: string): boolean {
    return this.rulesetControl(slug)?.enabled ?? false
  }

  private rulesetControl(slug: string): RulesetControl | undefined {
    return own(this.controls.rulesets ?? {}, slug)
  }

  private control(id: string): RuleControl {
    return own(this.controls.rules, id) ?? { enabled: true }
  }

  /** Controls with a rule's replaced; a rule back at the defaults has no entry. */
  private withRule(id: string, control: RuleControl): Controls {
    const { enabled, note, suppression } = control
    const rules =
      enabled && note === undefined && suppression === undefined
        ? without(this.controls.rules, id)
        : {
            ...this.controls.rules,
            [id]: {
              enabled,
              ...(note === undefined ? {} : { note }),
              ...(suppression === undefined ? {} : { suppression })
            }
          }
    return { ...this.controls, rules }
  }

  private withRuleset(slug: string, control: RulesetControl): Controls {
    return { ...this.controls, rulesets: { ...this.controls.rulesets, [slug]: control } }
  }

  /** Removes a rule's stored gate states from every input suppression. */
  private dropFrozenGates(id: string): void {
    const hasRule = (s: InputSuppression) =>
      s.frozen !== undefined && own(s.frozen, id) !== undefined
    if (!Object.values(this.controls.inputs).some(hasRule)) return
    const inputs = Object.fromEntries(
      Object.entries(this.controls.inputs).map(([path, suppression]) => {
        const { frozen, ...rest } = suppression
        if (frozen === undefined) return [path, suppression]
        const others = without(frozen, id)
        return [path, Object.keys(others).length === 0 ? rest : { ...rest, frozen: others }]
      })
    )
    this.saveControls({ ...this.controls, inputs })
  }

  private saveControls(controls: Controls): void {
    this.store.saveControls(controls)
    this.controls = controls
  }
}
