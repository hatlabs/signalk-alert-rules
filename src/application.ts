import { ruleId } from './alerts/paths.js'
import {
  RuleRunner,
  type LoadedRule,
  type RunnerDeps,
  type RunnerRuleStatus
} from './alerts/runner.js'
import { carriesTotals, structuralChanges } from './engine/evaluator.js'
import { MAX_RULES, type Rule } from './model/rule.js'
import { USER_ORIGIN } from './model/ruleset.js'
import { validateRule, type ValidationError } from './model/validate.js'
import type { Checkpoints, EvaluationSwitch, LogEntry, Store } from './store/store.js'

/** How often rules are evaluated: detector durations resolve to this. */
export const TICK_MS = 1000

/** How often accumulator totals are saved, bounding what a crash loses. */
export const CHECKPOINT_MS = 60_000

/** How many operator actions the log keeps. */
export const LOG_LIMIT = 200

/** A rule with what identifies it and its status; the status is null while evaluation is off. */
export interface RuleEntry {
  origin: string
  slug: string
  rule: Rule
  status: RunnerRuleStatus | null
}

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
  /** Saving the edit would clear an active alert. */
  clearsActiveAlert: boolean
}

export type PreviewOutcome = { ok: true; value: EditPreview } | Exclude<SaveOutcome, { ok: true }>

export type ResetOutcome = 'reset' | 'notFound' | 'notAccumulator'

function toMaps(checkpoints: Checkpoints): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(checkpoints).map(([id, totals]) => [id, new Map(Object.entries(totals))])
  )
}

/**
 * SKAR's running state: the stored rules, the evaluation switch, the
 * operator action log and, while evaluation is on, the runner evaluating the
 * rules. Every change is persisted first and then applied to the one rule it
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
  /** Oldest first, as stored. */
  private readonly actions: LogEntry[]

  constructor(
    private readonly deps: RunnerDeps,
    private readonly store: Store
  ) {
    const contents = store.load()
    this.issues = [...contents.issues]
    this.evaluationSwitch = contents.evaluation
    this.actions = contents.log
    this.stored = new Set(contents.rules.map((r) => r.slug))
    for (const { slug, value } of contents.rules) {
      const result = validateRule(value)
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

  tick(): void {
    this.runner?.tick()
  }

  /** Saves accumulator totals; throws when the store cannot write them. */
  checkpoint(): void {
    const totals = new Map([...this.retained, ...(this.runner?.accumulators() ?? [])])
    this.store.saveCheckpoints(
      Object.fromEntries([...totals].map(([id, t]) => [id, Object.fromEntries(t)]))
    )
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
    return this.userRules().map((rule) => this.entry(rule))
  }

  rule(origin: string, slug: string): RuleEntry | undefined {
    const rule = origin === USER_ORIGIN ? this.rulesBySlug.get(slug) : undefined
    return rule === undefined ? undefined : this.entry(rule)
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
    this.store.saveRule(rule)
    const previous = this.rulesBySlug.get(rule.slug)
    this.stored.add(rule.slug)
    // While evaluation is off an edit keeps the total, as the runner would.
    if (previous === undefined || !carriesTotals(previous, rule)) {
      this.retained.delete(this.idOf(rule.slug))
    }
    this.rulesBySlug.set(rule.slug, rule)
    this.runner?.update({ origin: USER_ORIGIN, rule })
    return { ok: true, value: rule }
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
    const restarts = changes.length > 0
    return {
      ok: true,
      value: { restarts, changes, activeAlerts, clearsActiveAlert: restarts && activeAlerts > 0 }
    }
  }

  /**
   * Deletes a stored user rule and clears its alerts. False when there is no
   * such rule; throws when the store cannot delete it.
   */
  deleteRule(slug: string, actor: string): boolean {
    if (!this.stored.has(slug)) return false
    this.store.deleteRule(slug)
    this.stored.delete(slug)
    this.retained.delete(this.idOf(slug))
    if (this.rulesBySlug.delete(slug)) this.runner?.remove(this.idOf(slug))
    this.record({ at: this.now(), actor, action: 'delete', rule: this.idOf(slug) })
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
    // Written now: the next checkpoint could come after a restart that
    // would bring back the old total.
    this.checkpoint()
    this.record({ at: this.now(), actor, action: 'reset', rule: id })
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
    this.store.saveEvaluation(next)
    this.evaluationSwitch = next
    if (enabled) {
      this.startRunner(false)
    } else if (this.runner !== undefined) {
      for (const [id, totals] of this.runner.accumulators()) this.retained.set(id, totals)
      this.runner.clearAll()
      this.runner = undefined
    }
    this.record({ at, actor, action: 'evaluation', enabled })
  }

  private startRunner(adopt: boolean): void {
    const ids = new Set([...this.rulesBySlug.keys()].map((slug) => this.idOf(slug)))
    const accumulated = new Map([...this.retained].filter(([id]) => ids.has(id)))
    for (const id of accumulated.keys()) this.retained.delete(id)
    this.runner = new RuleRunner(this.deps, this.loaded(), accumulated)
    this.runner.start(adopt)
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

  private entry(rule: Rule): RuleEntry {
    const status = this.runner?.status(this.idOf(rule.slug)) ?? null
    return { origin: USER_ORIGIN, slug: rule.slug, rule, status }
  }

  private idOf(slug: string): string {
    return ruleId(USER_ORIGIN, slug)
  }

  private loaded(): LoadedRule[] {
    return [...this.rulesBySlug.values()].map((rule) => ({ origin: USER_ORIGIN, rule }))
  }
}
