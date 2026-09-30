import type { Verdict } from './alerts/badge.js'
import { ruleId } from './alerts/paths.js'
import {
  RuleRunner,
  type LoadedRule,
  type RunnerDeps,
  type RunnerInstanceStatus,
  type RunnerRuleStatus,
  type RunnerSuppressions
} from './alerts/runner.js'
import type { Progress } from './engine/detectors/index.js'
import { carriesTotals, structuralChanges } from './engine/evaluator.js'
import { readsPath, signalPaths } from './engine/suppression.js'
import { MAX_RULES, type Rule } from './model/rule.js'
import { USER_ORIGIN } from './model/ruleset.js'
import { validateRule, type ValidationError } from './model/validate.js'
import type {
  Checkpoints,
  Controls,
  EvaluationSwitch,
  LogEntry,
  RuleControl,
  Store,
  Suppression
} from './store/store.js'
import { isRecord } from './util.js'

/** How often rules are evaluated: detector durations resolve to this. */
export const TICK_MS = 1000

/** How often accumulator totals are saved, bounding what a crash loses. */
export const CHECKPOINT_MS = 60_000

/** How many operator actions the log keeps. */
export const LOG_LIMIT = 200

/** The actor recorded when a suppression ends by itself. */
export const AUTO_END_ACTOR = 'auto-end'

export type NotEvaluatedReason = 'disabled' | 'evaluation is off'

/** A row of a rule that is not evaluated: one per accumulator total it keeps. */
export interface NotEvaluatedInstance extends Verdict {
  /** For a wildcard rule; the name is not kept with the total. */
  instance?: { segment: string }
  progress: Progress
}

/** The status of a rule that is not being evaluated. */
export interface NotEvaluatedStatus extends Verdict {
  badge: 'disabled'
  reason: NotEvaluatedReason
  issues: string[]
  errors: string[]
  instances: NotEvaluatedInstance[]
}

export type RuleStatus = RunnerRuleStatus | NotEvaluatedStatus

/** A rule with what identifies it, the operator's controls and its status. */
export interface RuleEntry {
  origin: string
  slug: string
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

/** A suppression in force, with what it suppresses. */
export type SuppressionEntry = Suppression &
  ({ scope: 'rule'; rule: string } | { scope: 'input'; path: string })

/** What suppressing an input path would do, without doing it. */
export interface InputSuppressionPreview {
  path: string
  /** Rules whose detector or combinator reads the path, with the wildcard instance that does. */
  suppresses: { rule: string; instance?: string }[]
  /** Gates that read the path, and the state each instance of their rule would be frozen at. */
  freezes: { rule: string; gate: number; states: { instance?: string; holds: boolean }[] }[]
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

function toMaps(checkpoints: Checkpoints): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(checkpoints).map(([id, totals]) => [id, new Map(Object.entries(totals))])
  )
}

// Input paths are operator-chosen keys, so one named like an Object property must not read it.
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

function notEvaluated(
  rule: Rule,
  totals: ReadonlyMap<string, number> | undefined,
  reason: NotEvaluatedReason
): NotEvaluatedStatus {
  const d = rule.detector
  const instances =
    d.type !== 'accumulator'
      ? []
      : [...(totals ?? [])].map(([segment, total]) => ({
          ...(segment === '' ? {} : { instance: { segment } }),
          badge: 'disabled' as const,
          reason,
          subLabels: [],
          progress: { kind: 'total' as const, total, limit: d.limit }
        }))
  return { badge: 'disabled', reason, subLabels: [], issues: [], errors: [], instances }
}

/**
 * How long every instance has stayed clear since the suppression started;
 * zero without an instance, which leaves nothing to judge by.
 */
function clearTime(
  instances: readonly Pick<RunnerInstanceStatus, 'clearFor'>[],
  started: number | undefined,
  now: number
): number {
  if (instances.length === 0) return 0
  const sinceStart = started === undefined ? Infinity : now - started
  return Math.min(sinceStart, ...instances.map((i) => i.clearFor ?? 0))
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
  /**
   * When each suppression started in this run, on the monotonic clock, by
   * `rule:<id>` or `input:<path>`: a clear before it does not count toward
   * its auto-end. One loaded at start needs none, as every evaluator starts
   * then.
   */
  private readonly suppressedAt = new Map<string, number>()
  private readonly suppressionsInForce: RunnerSuppressions = {
    rule: (id) => own(this.controls.rules, id)?.suppression,
    path: (path) => own(this.controls.inputs, path)
  }

  constructor(
    private readonly deps: RunnerDeps,
    private readonly store: Store
  ) {
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
   * Starts evaluating, adopting the alerts SKAR already has in core. With
   * evaluation off nothing is evaluated and nothing is cleared: the alerts
   * were cleared when it was turned off.
   */
  start(): void {
    if (this.evaluationSwitch.enabled) this.startRunner(true)
  }

  /** Evaluates, then ends the suppressions whose condition has stayed clear long enough. */
  tick(): void {
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
    this.suppressedAt.delete(`rule:${id}`)
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
    const rule = origin === USER_ORIGIN ? this.rulesBySlug.get(slug) : undefined
    if (rule === undefined) return 'notFound'
    if (rule.detector.type !== 'accumulator') return 'notAccumulator'
    const id = this.idOf(slug)
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
    if (this.runner !== undefined) {
      if (enabled) {
        const retained = this.retained.get(id)
        this.retained.delete(id)
        this.runner.update({ origin, rule }, retained)
      } else {
        const totals = this.runner.accumulators().get(id)
        if (totals !== undefined) this.retained.set(id, totals)
        this.runner.remove(id)
      }
    }
    this.record({ at: this.now(), actor, action: enabled ? 'enable' : 'disable', rule: id })
    return 'ok'
  }

  /** Sets a rule's note; an empty note removes it. Throws when the store cannot write. */
  setNote(origin: string, slug: string, note: string, actor: string): ControlOutcome {
    if (this.find(origin, slug) === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    const control = this.control(id)
    this.saveControls(this.withRule(id, { ...control, note: note === '' ? undefined : note }))
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
    this.suppressedAt.set(`rule:${id}`, this.deps.clock())
    this.runner?.refresh()
    this.record({ at: suppression.since, actor, action: 'suppress', rule: id })
    return 'ok'
  }

  /**
   * Ends a rule's own suppression; an alert whose condition holds is raised
   * as a new alert. Throws when the store cannot write.
   */
  endRuleSuppression(
    origin: string,
    slug: string,
    actor: string
  ): ControlOutcome | 'notSuppressed' {
    if (this.find(origin, slug) === undefined) return 'notFound'
    const id = ruleId(origin, slug)
    if (this.control(id).suppression === undefined) return 'notSuppressed'
    this.endSuppressionOf(id, actor)
    return 'ok'
  }

  /**
   * Suppresses an exact concrete path, replacing a suppression it has: every
   * rule instance whose detector or combinator reads it is suppressed, and
   * every gate reading it keeps the state it has. Throws when the store
   * cannot write.
   */
  suppressInput(path: string, request: SuppressionRequest, actor: string): SuppressionEntry {
    const suppression = this.newSuppression(request, actor)
    this.saveControls({
      ...this.controls,
      inputs: { ...this.controls.inputs, [path]: suppression }
    })
    this.suppressedAt.set(`input:${path}`, this.deps.clock())
    this.runner?.refresh()
    this.record({ at: suppression.since, actor, action: 'suppress', path })
    return { scope: 'input', path, ...suppression }
  }

  /** Ends an input suppression; false when there is none. Throws when the store cannot write. */
  endInputSuppression(path: string, actor: string): boolean {
    if (own(this.controls.inputs, path) === undefined) return false
    this.saveControls({ ...this.controls, inputs: without(this.controls.inputs, path) })
    this.suppressedAt.delete(`input:${path}`)
    this.runner?.refresh()
    this.record({ at: this.now(), actor, action: 'unsuppress', path })
    return true
  }

  /** Every suppression in force, newest first. */
  suppressions(): SuppressionEntry[] {
    const rules = Object.entries(this.controls.rules).flatMap(([rule, { suppression }]) =>
      suppression === undefined ? [] : [{ scope: 'rule' as const, rule, ...suppression }]
    )
    const inputs = Object.entries(this.controls.inputs).map(([path, suppression]) => ({
      scope: 'input' as const,
      path,
      ...suppression
    }))
    return [...rules, ...inputs].sort((a, b) => b.since.localeCompare(a.since))
  }

  /** What suppressing an exact concrete path would suppress and freeze, as the rules stand now. */
  previewInputSuppression(path: string): InputSuppressionPreview {
    const suppresses: InputSuppressionPreview['suppresses'] = []
    const freezes: InputSuppressionPreview['freezes'] = []
    for (const { origin, rule } of this.allLoaded()) {
      const id = ruleId(origin, rule.slug)
      const read = readsPath(rule.signal, path)
      if (read.reads) {
        suppresses.push(
          read.instance === undefined ? { rule: id } : { rule: id, instance: read.instance }
        )
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
        freezes.push({ rule: id, gate: i, states })
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
    this.suppressedAt.delete(`rule:${id}`)
    this.runner?.refresh()
    this.record({ at: this.now(), actor, action: 'unsuppress', rule: id })
  }

  /**
   * Ends each suppression with an auto-end whose condition has stayed clear
   * for its time: for a rule, every instance of it; for an input, every
   * instance it suppresses directly, those whose detector or combinator
   * reads the path. Gates reading the path do not count.
   */
  private endClearedSuppressions(): void {
    const runner = this.runner
    if (runner === undefined) return
    const now = this.deps.clock()
    for (const [id, { enabled, suppression }] of Object.entries(this.controls.rules)) {
      const after = suppression?.autoEndAfter
      if (after === undefined || !enabled) continue
      const instances = runner.status(id)?.instances ?? []
      if (clearTime(instances, this.suppressedAt.get(`rule:${id}`), now) >= after) {
        this.endSuppressionOf(id, AUTO_END_ACTOR)
      }
    }
    for (const [path, { autoEndAfter }] of Object.entries(this.controls.inputs)) {
      if (autoEndAfter === undefined) continue
      const direct = this.loaded().flatMap(({ origin, rule }) => {
        if (!readsPath(rule.signal, path).reads) return []
        const instances = runner.status(ruleId(origin, rule.slug))?.instances ?? []
        return instances.filter((row) => signalPaths(rule.signal, row.instance).includes(path))
      })
      if (clearTime(direct, this.suppressedAt.get(`input:${path}`), now) >= autoEndAfter) {
        this.endInputSuppression(path, AUTO_END_ACTOR)
      }
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
    const running = enabled ? this.runner?.status(id) : undefined
    const status =
      running ??
      notEvaluated(rule, this.retained.get(id), enabled ? 'evaluation is off' : 'disabled')
    return {
      origin,
      slug: rule.slug,
      rule,
      enabled,
      ...(note === undefined ? {} : { note }),
      ...(suppression === undefined ? {} : { suppression }),
      status
    }
  }

  private idOf(slug: string): string {
    return ruleId(USER_ORIGIN, slug)
  }

  private find(origin: string, slug: string): Rule | undefined {
    return origin === USER_ORIGIN ? this.rulesBySlug.get(slug) : undefined
  }

  /** Every loaded rule, enabled or not. */
  private allLoaded(): LoadedRule[] {
    return [...this.rulesBySlug.values()].map((rule) => ({ origin: USER_ORIGIN, rule }))
  }

  /** The rules the runner evaluates. */
  private loaded(): LoadedRule[] {
    return this.allLoaded().filter(
      ({ origin, rule }) => this.control(ruleId(origin, rule.slug)).enabled
    )
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

  private saveControls(controls: Controls): void {
    this.store.saveControls(controls)
    this.controls = controls
  }
}
