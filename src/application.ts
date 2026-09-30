import { ruleId } from './alerts/paths.js'
import { RuleRunner, type LoadedRule, type RunnerDeps } from './alerts/runner.js'
import { MAX_RULES, type Rule } from './model/rule.js'
import { USER_ORIGIN } from './model/ruleset.js'
import { validateRule, type Result } from './model/validate.js'
import type { Checkpoints, EvaluationSwitch, Store } from './store/store.js'

/** How often rules are evaluated: detector durations resolve to this. */
export const TICK_MS = 1000

/** How often accumulator totals are saved, bounding what a crash loses. */
export const CHECKPOINT_MS = 60_000

function toMaps(checkpoints: Checkpoints): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(checkpoints).map(([id, totals]) => [id, new Map(Object.entries(totals))])
  )
}

/**
 * SKAR's running state: the stored rules and the runner evaluating them.
 * Every change is persisted first and then applied to the one rule it
 * concerns, so other rules keep their timers; a change the store fails to
 * write is not applied.
 */
export class Application {
  /** Problems found while loading, for the plugin status. */
  readonly issues: string[]
  readonly evaluation: EvaluationSwitch
  private readonly runner: RuleRunner
  private readonly rules = new Map<string, Rule>()
  /** Slugs of stored rule files, loaded or not, so a skipped one can be deleted. */
  private readonly stored: Set<string>
  /**
   * Checkpointed totals of rules that are not running, such as a stored rule
   * that no longer validates, kept until the rule is deleted or saved again.
   */
  private readonly retained: Map<string, Map<string, number>>

  constructor(
    deps: RunnerDeps,
    private readonly store: Store
  ) {
    const contents = store.load()
    this.issues = [...contents.issues]
    this.evaluation = contents.evaluation
    this.stored = new Set(contents.rules.map((r) => r.slug))
    for (const { slug, value } of contents.rules) {
      const result = validateRule(value)
      if (!result.ok) {
        const errors = result.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')
        this.issues.push(`stored rule ${slug} is not valid and does not run: ${errors}`)
      } else if (result.value.slug !== slug) {
        this.issues.push(`stored rule ${slug} has the slug ${result.value.slug} and does not run`)
      } else {
        this.rules.set(slug, result.value)
      }
    }
    const accumulated = toMaps(contents.accumulators)
    const running = new Set([...this.rules.keys()].map((slug) => this.idOf(slug)))
    this.retained = new Map([...accumulated].filter(([id]) => !running.has(id)))
    this.runner = new RuleRunner(deps, this.loaded(), accumulated)
  }

  start(): void {
    this.runner.start()
  }

  tick(): void {
    this.runner.tick()
  }

  /** Saves accumulator totals; throws when the store cannot write them. */
  checkpoint(): void {
    const totals = new Map([...this.retained, ...this.runner.accumulators()])
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
      this.runner.stop()
    }
  }

  userRules(): Rule[] {
    return [...this.rules.values()]
  }

  userRule(slug: string): Rule | undefined {
    return this.rules.get(slug)
  }

  /**
   * Creates or replaces the user rule with the input's slug. Returns the
   * validation errors of an invalid rule; throws when the store cannot write.
   */
  saveRule(input: unknown): Result<Rule> {
    const result = validateRule(input)
    if (!result.ok) return result
    const rule = result.value
    if (!this.rules.has(rule.slug) && this.rules.size >= MAX_RULES) {
      return { ok: false, errors: [{ path: '', message: `at most ${String(MAX_RULES)} rules` }] }
    }
    this.store.saveRule(rule)
    this.stored.add(rule.slug)
    this.retained.delete(this.idOf(rule.slug))
    this.rules.set(rule.slug, rule)
    this.runner.update({ origin: USER_ORIGIN, rule })
    return result
  }

  /**
   * Deletes a stored user rule and clears its alerts. False when there is no
   * such rule; throws when the store cannot delete it.
   */
  deleteRule(slug: string): boolean {
    if (!this.stored.has(slug)) return false
    this.store.deleteRule(slug)
    this.stored.delete(slug)
    this.retained.delete(this.idOf(slug))
    if (this.rules.delete(slug)) this.runner.remove(this.idOf(slug))
    return true
  }

  private idOf(slug: string): string {
    return ruleId(USER_ORIGIN, slug)
  }

  private loaded(): LoadedRule[] {
    return [...this.rules.values()].map((rule) => ({ origin: USER_ORIGIN, rule }))
  }
}
