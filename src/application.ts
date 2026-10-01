import type { Verdict } from './alerts/badge.js'
import {
  RuleRunner,
  type Accumulated,
  type RunnerDeps,
  type RunnerRuleStatus
} from './alerts/runner.js'
import type { Progress } from './engine/detectors/index.js'
import { carriesTotals, measureOf, structuralChanges } from './engine/evaluator.js'
import { asGiven, canonicalSources } from './engine/sourceRefs.js'
import { MAX_RULES, type Rule } from './model/rule.js'
import type { Template } from './model/template.js'
import { validateRule, type ValidationError } from './model/validate.js'
import type {
  Checkpoints,
  Controls,
  Disabled,
  LogEntry,
  RuleControl,
  Store
} from './store/store.js'
import type { DiscoveryProblem, DiscoveryResult } from './templates/discovery.js'
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

export type NotEvaluatedReason = 'not started'

/** A row of a rule that is not evaluated: one per accumulator total it keeps. */
export interface NotEvaluatedInstance extends Verdict {
  /** For a wildcard rule; the name is not kept with the total. */
  instance?: { segment: string }
  progress: Progress
}

/** The status of a rule while the runner is not started. */
export interface NotEvaluatedStatus extends Verdict {
  badge: 'inactive'
  reason: NotEvaluatedReason
  issues: string[]
  errors: string[]
  instances: NotEvaluatedInstance[]
}

export type RuleStatus = RunnerRuleStatus | NotEvaluatedStatus

/** A rule with the operator's controls and its status. */
export interface RuleEntry {
  slug: string
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

/** A template set as `GET /templates` lists it. */
export interface TemplateSetEntry {
  id: string
  name: string
  version: string
  description?: string
  /** Where it was found: `built-in`, `package some-name` or `file foo.yaml`. */
  source: string
  package?: { name: string; version: string }
  templates: Template[]
  /** Ids of its templates whose notice nobody has dismissed. */
  new: string[]
}

export interface TemplateListing {
  sets: TemplateSetEntry[]
  /** Template sets that could not be loaded, with the reason. */
  problems: DiscoveryProblem[]
}

const NO_TEMPLATES: DiscoveryResult = { sets: [], problems: [] }

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

function notStarted(
  rule: Rule,
  totals: ReadonlyMap<string, number> | undefined
): NotEvaluatedStatus {
  const badge = 'inactive' as const
  const reason = 'not started' as const
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
  return { badge, reason, subLabels: [], issues: [], errors: [], instances }
}

/**
 * SKAR's running state: the stored rules, which of them are disabled, the
 * operator action log and, once started, the runner evaluating the rules.
 * A rule is identified by its slug. Every change is persisted first and then
 * applied to the one rule it concerns, so other rules keep their timers; a
 * change the store fails to write is not applied.
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
   * no longer validates, kept until the rule is deleted or saved again.
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
  /** Set while starting: a failed write is then an issue, not a failed start. */
  private starting = false
  private readonly isDisabled = (slug: string): boolean => this.control(slug).disabled !== undefined

  /**
   * @param discover finds the template sets installed now. Templates never
   *   affect a rule, so they are discovered when listed rather than kept.
   */
  constructor(
    private readonly deps: RunnerDeps,
    private readonly store: Store,
    private readonly discover: () => DiscoveryResult = () => NO_TEMPLATES
  ) {
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

  /** Starts evaluating, adopting the alerts SKAR already has in core. */
  start(): void {
    // A full disk must not keep every rule from running: what could not be
    // saved applies in this run.
    this.starting = true
    try {
      if (this.dropTotalsOfOtherMeasure()) this.saveDroppedTotals()
    } finally {
      this.starting = false
    }
    this.startRunner()
  }

  tick(): void {
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
      this.runner?.stop()
    }
  }

  allRules(): Rule[] {
    return [...this.rulesBySlug.values()]
  }

  rules(): RuleEntry[] {
    return this.allRules().map((rule) => this.entry(rule))
  }

  rule(slug: string): RuleEntry | undefined {
    const rule = this.rulesBySlug.get(slug)
    return rule === undefined ? undefined : this.entry(rule)
  }

  /** The operator action log, newest first. */
  log(): LogEntry[] {
    return [...this.actions].reverse()
  }

  /** The template sets installed now, in discovery order, and those that failed to load. */
  templates(): TemplateListing {
    return this.templateListing(this.discover())
  }

  /**
   * Dismisses the notice of every template installed now, for everyone. A
   * template stays dismissed when its set is gone or fails to load, so an
   * update that breaks a set and the next that fixes it raise no notice.
   * Throws when the store cannot write.
   */
  dismissTemplates(): TemplateListing {
    const found = this.discover()
    const before = this.controls.dismissedTemplates ?? {}
    const after = { ...before }
    for (const { set } of found.sets) {
      const seen = new Set(own(before, set.id) ?? [])
      if (set.templates.every((t) => seen.has(t.id))) continue
      after[set.id] = [...seen, ...set.templates.map((t) => t.id).filter((id) => !seen.has(id))]
    }
    if (JSON.stringify(after) !== JSON.stringify(before))
      this.saveControls({ ...this.controls, dismissedTemplates: after })
    return this.templateListing(found)
  }

  private templateListing({ sets, problems }: DiscoveryResult): TemplateListing {
    const dismissed = this.controls.dismissedTemplates ?? {}
    return {
      sets: sets.map(({ source, package: pkg, set }) => {
        const seen = new Set(own(dismissed, set.id) ?? [])
        return {
          id: set.id,
          name: set.name,
          version: set.version,
          ...(set.description === undefined ? {} : { description: set.description }),
          source,
          ...(pkg === undefined ? {} : { package: pkg }),
          templates: set.templates,
          new: set.templates.map((t) => t.id).filter((id) => !seen.has(id))
        }
      }),
      problems
    }
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

  /** Drops the stored totals of rules built under another measure than their rule file's. */
  private dropTotalsOfOtherMeasure(): boolean {
    let drops = false
    for (const [slug, retained] of this.retained) {
      if (!this.stored.has(slug) || this.unreadable.has(slug)) continue
      const rule = this.rulesBySlug.get(slug)
      const measure = rule === undefined ? this.unloadedMeasures.get(slug) : measureOf(rule)
      if (retained.measure === measure) continue
      this.retained.delete(slug)
      drops = true
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

  /** Creates or replaces the rule with a validated rule's slug; throws when the store cannot write. */
  private saveRule(rule: Rule): SaveOutcome {
    if (!this.rulesBySlug.has(rule.slug) && this.rulesBySlug.size >= MAX_RULES) {
      const message = `at most ${String(MAX_RULES)} rules`
      return { ok: false, reason: 'invalid', errors: [{ path: '', message }] }
    }
    const slug = rule.slug
    const carries = this.carriesTotal(rule)
    const drops = this.hasTotal(slug) && !carries
    this.store.saveRule(rule)
    this.stored.add(slug)
    this.unloadedMeasures.delete(slug)
    // While a rule is not evaluated an edit keeps the total, as the runner would.
    if (!carries) this.retained.delete(slug)
    this.rulesBySlug.set(slug, rule)
    if (this.runner !== undefined) {
      // Once started, only a rule the runner does not hold has a retained
      // total; the runner takes it over.
      const retained = this.retained.get(slug)
      this.retained.delete(slug)
      this.runner.update(rule, retained?.totals)
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
  private hasTotal(slug: string): boolean {
    return this.totalsOf(slug) !== undefined
  }

  /** Whether the rule has an accumulator total above zero: one an operator would lose. */
  private hasNonZeroTotal(slug: string): boolean {
    return [...(this.totalsOf(slug)?.totals.values() ?? [])].some((total) => total !== 0)
  }

  private totalsOf(slug: string): Accumulated | undefined {
    return this.retained.get(slug) ?? this.runner?.accumulators().get(slug)
  }

  /** Saves a new rule; a stored rule file with its slug, valid or not, makes it exist. */
  createRule(input: unknown): SaveOutcome {
    const result = validateRule(input)
    if (!result.ok) return { ok: false, reason: 'invalid', errors: result.errors }
    if (this.stored.has(result.value.slug)) return { ok: false, reason: 'exists' }
    return this.saveRule(this.withCanonicalSources(result.value))
  }

  /** Replaces the stored rule `slug` with an input of the same slug. */
  replaceRule(slug: string, input: unknown): SaveOutcome {
    const checked = this.checkEdit(slug, input)
    return checked.ok ? this.saveRule(checked.value) : checked
  }

  /** What replacing the rule `slug` with the input would do, without doing it. */
  previewRule(slug: string, input: unknown): PreviewOutcome {
    const checked = this.checkEdit(slug, input)
    if (!checked.ok) return checked
    const current = this.rulesBySlug.get(slug)
    // A stored rule that did not validate is not running: saving starts it.
    const changes =
      current === undefined
        ? []
        : structuralChanges(this.withCanonicalSources(current), checked.value)
    const status = this.runner?.status(slug)
    const activeAlerts = status?.instances.filter((i) => i.active).length ?? 0
    const restarts = changes.length > 0 || this.runner?.failedToStart(slug) === true
    return {
      ok: true,
      value: {
        restarts,
        changes,
        activeAlerts,
        clearsActiveAlert: restarts && activeAlerts > 0,
        discardsTotal: this.hasNonZeroTotal(slug) && !this.carriesTotal(checked.value)
      }
    }
  }

  /**
   * Deletes a stored rule with its controls and clears its alerts. False
   * when there is no such rule; throws when the store cannot delete it.
   */
  deleteRule(slug: string, actor: string): boolean {
    if (!this.stored.has(slug)) return false
    const drops = this.hasTotal(slug)
    this.store.deleteRule(slug)
    this.stored.delete(slug)
    this.unloadedMeasures.delete(slug)
    this.retained.delete(slug)
    if (this.rulesBySlug.delete(slug)) this.runner?.remove(slug)
    // Logged first: the delete is applied even when the checkpoint fails.
    try {
      this.record({ at: this.now(), actor, action: 'delete', rule: slug })
    } finally {
      try {
        // Written now: a restart before the next checkpoint would give the old
        // total to a rule re-created with this slug.
        if (drops) this.checkpoint()
      } finally {
        if (own(this.controls.rules, slug) !== undefined) {
          this.saveControls({ ...this.controls, rules: without(this.controls.rules, slug) })
        }
      }
    }
    return true
  }

  /**
   * Zeroes an accumulator rule's total, restored and stored ones included,
   * and clears its alerts. Throws when the store cannot write the total.
   */
  resetAccumulator(slug: string, actor: string): ResetOutcome {
    const rule = this.rulesBySlug.get(slug)
    if (rule === undefined) return 'notFound'
    if (rule.detector.type !== 'accumulator') return 'notAccumulator'
    this.runner?.reset(slug)
    this.retained.delete(slug)
    // Logged first: the reset is applied even when the checkpoint fails.
    try {
      this.record({ at: this.now(), actor, action: 'reset', rule: slug })
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
  disableRule(slug: string, note: string | undefined, actor: string): ControlOutcome {
    if (!this.rulesBySlug.has(slug)) return 'notFound'
    const noted = note === undefined || note === '' ? {} : { note }
    const disabled: Disabled = { since: this.now(), actor, ...noted }
    this.saveControls(this.withRule(slug, { disabled }))
    this.runner?.refresh(slug)
    this.record({ at: disabled.since, actor, action: 'disable', rule: slug, ...noted })
    return 'ok'
  }

  /**
   * Enables a disabled rule; one whose condition holds raises a new alert at
   * once. Enabling an enabled rule does nothing. Throws when the store
   * cannot write.
   */
  enableRule(slug: string, actor: string): ControlOutcome {
    if (!this.rulesBySlug.has(slug)) return 'notFound'
    if (!this.isDisabled(slug)) return 'ok'
    this.saveControls(this.withRule(slug, {}))
    this.runner?.refresh(slug)
    this.record({ at: this.now(), actor, action: 'enable', rule: slug })
    return 'ok'
  }

  /**
   * Starts a runner on the stored rules and hands it their retained totals.
   * On a throw nothing changes: a runner that failed to start holds no
   * totals, so keeping it would let the next checkpoint drop them.
   */
  private startRunner(): void {
    const loaded = this.allRules()
    const accumulated = new Map(
      [...this.retained]
        .filter(([slug]) => this.rulesBySlug.has(slug))
        .map(([slug, { totals }]) => [slug, totals])
    )
    const runner = new RuleRunner(this.deps, loaded, accumulated, this.isDisabled)
    try {
      runner.start()
    } catch (err) {
      runner.stop()
      throw err
    }
    for (const slug of accumulated.keys()) this.retained.delete(slug)
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

  private entry(rule: Rule): RuleEntry {
    const { disabled } = this.control(rule.slug)
    return {
      slug: rule.slug,
      rule,
      ...(disabled === undefined ? {} : { disabled }),
      status:
        this.runner?.status(rule.slug) ?? notStarted(rule, this.retained.get(rule.slug)?.totals)
    }
  }

  private control(slug: string): RuleControl {
    return own(this.controls.rules, slug) ?? {}
  }

  /** Controls with a rule's replaced; an enabled rule has no entry. */
  private withRule(slug: string, { disabled }: RuleControl): Controls {
    const rules =
      disabled === undefined
        ? without(this.controls.rules, slug)
        : { ...this.controls.rules, [slug]: { disabled } }
    return { ...this.controls, rules }
  }

  private saveControls(controls: Controls): void {
    this.tolerating(SETTINGS, 'they apply until the next change saves them', () => {
      this.store.saveControls(controls)
      this.saved(SETTINGS)
    })
    this.controls = controls
  }
}
