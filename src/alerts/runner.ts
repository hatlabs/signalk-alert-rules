import {
  RuleEvaluator,
  type Adopted,
  type EvaluatorContext,
  type InstanceStatus,
  type RuleEvent
} from '../engine/evaluator.js'
import type { Rule } from '../model/rule.js'
import { alertPathFor } from '../model/validate.js'
import { AlertEmitter, type AlertStatus, type AlertValue, type EmitterDeps } from './emitter.js'
import { ruleId } from './paths.js'
import { reconcile } from './reconcile.js'

export interface RunnerDeps extends EvaluatorContext, EmitterDeps {
  /** Wall time, only for the raise timestamp in alert data. */
  wallClock: () => Date
}

export interface LoadedRule {
  /** `user` or the providing ruleset's slug. */
  origin: string
  rule: Rule
}

export type RunnerInstanceStatus = InstanceStatus & Partial<AlertStatus>

export interface RunnerRuleStatus {
  issues: string[]
  instances: RunnerInstanceStatus[]
}

const idOf = (entry: LoadedRule) => ruleId(entry.origin, entry.rule.slug)

/**
 * Runs a set of rules against the server: one evaluator per rule, their
 * events turned into core alerts by one emitter, and at start the alerts SKAR
 * already owns in core adopted or cleared. Rules loaded later through
 * `update` start without adoption, so every rule known at start belongs in
 * the constructor.
 */
export class RuleRunner {
  private readonly emitter: AlertEmitter
  private readonly entries = new Map<string, LoadedRule>()
  private readonly evaluators = new Map<string, RuleEvaluator>()
  private readonly issues = new Map<string, Set<string>>()

  constructor(
    private readonly deps: RunnerDeps,
    rules: readonly LoadedRule[]
  ) {
    this.emitter = new AlertEmitter(deps)
    for (const entry of rules) this.entries.set(idOf(entry), entry)
  }

  start(): void {
    const now = this.deps.clock()
    const rules = new Map([...this.entries].map(([id, e]) => [id, e.rule]))
    const { kept, activeByRule, orphaned } = reconcile(
      this.deps.alerts.list(),
      this.deps.pluginId,
      rules
    )
    for (const alert of orphaned) if (alert.condition) this.deps.send(alert.path, null)
    for (const { alert, ruleId: id, segment } of kept) {
      this.emitter.adopt(alert, this.evidence(id, segment ?? ''), now)
    }
    for (const [id, entry] of this.entries) this.startRule(id, entry, activeByRule.get(id))
  }

  tick(): void {
    for (const [id, evaluator] of this.evaluators) {
      // One rule failing must not stop the others or the heartbeat that keeps their alerts live.
      try {
        evaluator.tick()
      } catch (err) {
        this.issue(id, `evaluation failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.emitter.beat(this.deps.clock())
  }

  /** Stops evaluating without clearing anything: stop runs on every configuration save. */
  stop(): void {
    for (const evaluator of this.evaluators.values()) evaluator.stop()
  }

  /** Applies an edited rule, or starts a new one. */
  update(entry: LoadedRule): void {
    const id = idOf(entry)
    this.entries.set(id, entry)
    this.issues.delete(id)
    const evaluator = this.evaluators.get(id)
    if (evaluator === undefined) this.startRule(id, entry, undefined)
    else evaluator.update(entry.rule)
  }

  /** Clears a rule's alerts and forgets it, for a deleted rule. */
  remove(id: string): void {
    this.evaluators.get(id)?.remove()
    this.evaluators.delete(id)
    this.entries.delete(id)
    this.issues.delete(id)
  }

  status(id: string): RunnerRuleStatus | undefined {
    const entry = this.entries.get(id)
    const evaluator = this.evaluators.get(id)
    if (entry === undefined || evaluator === undefined) return undefined
    const status = evaluator.status()
    return {
      issues: [...status.issues, ...(this.issues.get(id) ?? [])],
      instances: status.instances.map((instance) => {
        const path = alertPathFor(entry.origin, entry.rule.slug, instance.instance?.segment)
        const alert = path.ok ? this.emitter.status(path.value) : undefined
        return alert === undefined
          ? instance
          : { ...instance, ...alert, awaitingInput: !this.hasEvidence(entry.rule, instance) }
      })
    }
  }

  private startRule(id: string, entry: LoadedRule, adopted: Adopted[] | undefined): void {
    const evaluator = new RuleEvaluator(
      entry.rule,
      this.deps,
      (event) => {
        this.onEvent(id, event)
      },
      adopted
    )
    this.evaluators.set(id, evaluator)
    evaluator.start()
  }

  private issue(id: string, message: string): void {
    const issues = this.issues.get(id) ?? new Set<string>()
    issues.add(message)
    this.issues.set(id, issues)
  }

  private onEvent(id: string, event: RuleEvent): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const now = this.deps.clock()
    const segment = event.instance?.segment
    const path = alertPathFor(entry.origin, entry.rule.slug, segment)
    if (!path.ok) {
      for (const error of path.errors) this.issue(id, error.message)
      return
    }
    if (event.type === 'raise') {
      this.emitter.raise(
        path.value,
        this.describe(id, event),
        this.evidence(id, segment ?? ''),
        now
      )
    } else {
      this.emitter.clear(path.value, now)
    }
  }

  /**
   * The alert's message and data, fixed at the raise. Data carries only what
   * changes rarely, so heartbeats never rewrite it; live values are in status.
   */
  private describe(id: string, event: Extract<RuleEvent, { type: 'raise' }>): AlertValue {
    const { rule, instance, priority, limit, value } = event
    const data: Record<string, unknown> = { rule: id, name: rule.name }
    if (instance !== undefined) data.instance = instance.name
    if (limit !== undefined) data.limit = limit
    if (value !== undefined) data.valueAtRaise = value
    data.raisedAt = this.deps.wallClock().toISOString()
    return {
      priority,
      message: rule.message.replaceAll('{instance}', instance?.name ?? ''),
      latching: rule.latching ?? false,
      data
    }
  }

  private evidence(id: string, segment: string): () => boolean {
    return () => {
      const rule = this.entries.get(id)?.rule
      const instance = this.evaluators
        .get(id)
        ?.status()
        .instances.find((i) => (i.instance?.segment ?? '') === segment)
      return rule !== undefined && instance !== undefined && this.hasEvidence(rule, instance)
    }
  }

  /**
   * Whether an instance's input is reporting, which is what keeps its alert
   * live in core. A running rule has evidence unless its input is
   * unavailable, so an absence rule whose input has never been seen does. An
   * adopted alert needs a value since start, because its condition was never
   * evaluated here. Absence and timeout rules are the exceptions: their
   * condition is the input's silence, which the detector evaluates from start,
   * so an absence rule has evidence unless its input is unavailable and a
   * timeout rule always has it.
   */
  private hasEvidence(rule: Rule, instance: InstanceStatus): boolean {
    const d = rule.detector
    if (d.type === 'match' && d.op === 'timedOut') return true
    if (instance.adopted && d.type !== 'absence') return instance.input === 'value'
    return instance.input !== 'unavailable'
  }
}
