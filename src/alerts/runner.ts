import {
  carriesTotals,
  measureOf,
  RuleEvaluator,
  type Adopted,
  type EvaluatorContext,
  type InstanceStatus,
  type RuleEvent
} from '../engine/evaluator.js'
import { NO_SUPPRESSIONS, ruleScope, type Suppressions } from '../engine/suppression.js'
import { priorityOf, type Priority, type Rule } from '../model/rule.js'
import { alertPathFor } from '../model/validate.js'
import { statusBadge, type Verdict } from './badge.js'
import {
  AlertEmitter,
  type AlertHeader,
  type AlertStatus,
  type AlertValue,
  type AlertsReader,
  type EmitterDeps
} from './emitter.js'
import { ruleId } from './paths.js'
import { ownedActiveAlert, reconcile } from './reconcile.js'
import { errorMessage } from '../util.js'

export interface RunnerDeps extends EvaluatorContext, EmitterDeps {
  pluginId: string
  /** Read once at start, to adopt or clear the alerts SKAR already has in core. */
  alerts: AlertsReader
  /** Wall time, only for the raise timestamp in alert data. */
  wallClock: () => Date
}

export interface LoadedRule {
  /** `user` or the providing ruleset's slug. */
  origin: string
  rule: Rule
}

export type RunnerInstanceStatus = InstanceStatus & Partial<AlertStatus> & Verdict

export interface RunnerRuleStatus extends Verdict {
  /** Conditions that do not stop the rule, such as a rejected wildcard instance. */
  issues: string[]
  /** Failures that make the rule errored, such as an evaluation that threw. */
  errors: string[]
  instances: RunnerInstanceStatus[]
}

/** A rule's accumulator totals by instance segment, with the measure they were built under. */
export interface Accumulated {
  measure: string
  totals: Map<string, number>
}

const idOf = (entry: LoadedRule) => ruleId(entry.origin, entry.rule.slug)

/** What the rule says about an instance's alert at a priority. */
function header(rule: Rule, instance: string | undefined, priority: Priority): AlertHeader {
  return {
    priority,
    message: rule.message.replaceAll('{instance}', instance ?? ''),
    latching: rule.latching ?? false
  }
}

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
  private readonly errors = new Map<string, Set<string>>()
  /** Rules whose evaluator threw at start; an edit starts them again. */
  private readonly failed = new Set<string>()

  /**
   * @param accumulated accumulator totals restored from the store, by rule id
   *   and instance segment; applied to the rules started by `start`.
   * @param suppressions read at every evaluation; `refresh` applies a change at once.
   */
  constructor(
    private readonly deps: RunnerDeps,
    rules: readonly LoadedRule[],
    private readonly accumulated: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(),
    private readonly suppressions: Suppressions = NO_SUPPRESSIONS
  ) {
    this.emitter = new AlertEmitter(deps)
    for (const entry of rules) this.entries.set(idOf(entry), entry)
  }

  /**
   * @param adopt whether active alerts SKAR already has in core are adopted;
   *   without it they are cleared and every rule starts from nothing.
   */
  start(adopt = true): void {
    const now = this.deps.clock()
    const rules = new Map([...this.entries].map(([id, e]) => [id, e.rule]))
    const reconciled = reconcile(this.deps.alerts.list(), this.deps.pluginId, rules)
    const { activeByRule } = reconciled
    const kept = adopt ? reconciled.kept : []
    const toClear = adopt
      ? reconciled.toClear
      : [...reconciled.toClear, ...reconciled.kept.map((k) => k.alert)]
    for (const alert of toClear) this.deps.send(alert.path, null)
    for (const { alert, ruleId: id, segment } of kept) {
      const rule = this.entries.get(id)?.rule
      if (rule === undefined) continue
      // The segment is the sanitised name; the raise wrote the name itself into data.
      const name = typeof alert.data?.instance === 'string' ? alert.data.instance : segment
      // Until its evaluator sees a more severe level entered, an adopted
      // zone-limit alert reports its rule's own level; core keeps any higher
      // priority it holds.
      this.emitter.adopt(
        alert,
        header(rule, name, priorityOf(rule)),
        this.evidence(id, segment ?? ''),
        now
      )
    }
    for (const [id, entry] of this.entries) {
      const adopted = adopt ? activeByRule.get(id) : undefined
      this.startRule(id, entry, adopted, this.accumulated.get(id))
    }
  }

  tick(): void {
    for (const [id, evaluator] of this.evaluators) {
      // One rule failing must not stop the others or the heartbeat that keeps their alerts live.
      try {
        evaluator.tick()
      } catch (err) {
        this.error(id, `evaluation failed: ${errorMessage(err)}`)
      }
    }
    this.emitter.beat(this.deps.clock())
  }

  /**
   * Evaluates every rule now, so a change of the suppressions clears or
   * raises at once rather than at the next sample or tick.
   */
  refresh(): void {
    for (const [id, evaluator] of this.evaluators) {
      try {
        evaluator.refresh()
      } catch (err) {
        this.error(id, `evaluation failed: ${errorMessage(err)}`)
      }
    }
  }

  /** Restarts the clear count of a rule's instances, or of the instances of any rule that read a path. */
  restartClearCount(target: { rule: string } | { path: string }): void {
    if ('rule' in target) {
      this.evaluators.get(target.rule)?.restartClearCount()
      return
    }
    for (const evaluator of this.evaluators.values()) evaluator.restartClearCount(target.path)
  }

  /** Stops evaluating without clearing anything: stop runs on every configuration save. */
  stop(): void {
    for (const evaluator of this.evaluators.values()) evaluator.stop()
  }

  /**
   * Applies an edited rule, or starts a new one.
   *
   * @param accumulated accumulator totals a rule the runner does not hold
   *   starts with, by instance segment.
   */
  update(entry: LoadedRule, accumulated?: ReadonlyMap<string, number>): void {
    const id = idOf(entry)
    const previous = this.entries.get(id)
    this.entries.set(id, entry)
    this.errors.delete(id)
    const evaluator = this.evaluators.get(id)
    if (evaluator === undefined || this.failed.has(id)) {
      this.failed.delete(id)
      let carried = evaluator === undefined ? accumulated : undefined
      if (
        evaluator !== undefined &&
        previous !== undefined &&
        carriesTotals(previous.rule, entry.rule)
      ) {
        carried = evaluator.accumulators()
      }
      // The new evaluator starts without adoption, so the failed one's adopted
      // alerts would otherwise be heartbeated with nothing to clear them.
      evaluator?.remove()
      this.startRule(id, entry, undefined, carried)
      return
    }
    evaluator.update(entry.rule)
    // An edit that restarts the rule has cleared and re-raised already; any
    // other edit reaches core with the next heartbeat of each active alert.
    for (const { instance, priority } of evaluator.status().instances) {
      if (priority === undefined) continue
      const path = alertPathFor(entry.origin, entry.rule.slug, instance?.segment)
      if (path.ok) this.emitter.revise(path.value, header(entry.rule, instance?.name, priority))
    }
  }

  /**
   * Stops evaluating and clears every active alert SKAR owns: those it
   * heartbeats, and any other active alert core holds under SKAR's prefix
   * from SKAR, such as one whose clear was lost. For turning evaluation off;
   * the runner is not started again.
   */
  clearAll(): void {
    this.stop()
    const owned = this.deps.alerts
      .list()
      .filter((a) => ownedActiveAlert(a, this.deps.pluginId) !== undefined)
    const cleared = new Set(this.emitter.clearAll())
    for (const { path } of owned) if (!cleared.has(path)) this.deps.send(path, null)
  }

  /** Zeroes an accumulator rule's totals and clears its alerts. */
  reset(id: string): void {
    this.evaluators.get(id)?.reset()
  }

  /** Clears a rule's alerts and forgets it, for a deleted rule. */
  remove(id: string): void {
    this.evaluators.get(id)?.remove()
    this.evaluators.delete(id)
    this.entries.delete(id)
    this.errors.delete(id)
    this.failed.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Whether the rule's evaluator threw at start, so any edit starts it again. */
  failedToStart(id: string): boolean {
    return this.failed.has(id)
  }

  /** Accumulator totals by rule id, for the store's checkpoint. */
  accumulators(): Map<string, Accumulated> {
    const accumulated = new Map<string, Accumulated>()
    for (const [id, evaluator] of this.evaluators) {
      const totals = evaluator.accumulators()
      const rule = this.entries.get(id)?.rule
      const measure = rule === undefined ? undefined : measureOf(rule)
      if (totals.size > 0 && measure !== undefined) accumulated.set(id, { measure, totals })
    }
    return accumulated
  }

  status(id: string): RunnerRuleStatus | undefined {
    const entry = this.entries.get(id)
    const evaluator = this.evaluators.get(id)
    if (entry === undefined || evaluator === undefined) return undefined
    const status = evaluator.status()
    const errors = [...status.errors, ...(this.errors.get(id) ?? [])]
    const instances = status.instances.map((instance) => {
      const path = alertPathFor(entry.origin, entry.rule.slug, instance.instance?.segment)
      if (!path.ok) return { ...instance, inactive: instance.inactive ?? path.errors[0]?.message }
      const alert = this.emitter.status(path.value)
      return alert === undefined
        ? instance
        : { ...instance, ...alert, awaitingInput: !this.hasEvidence(entry.rule, instance) }
    })
    const verdict = statusBadge(errors, instances, ruleScope(this.suppressions.rule(id)))
    return {
      badge: verdict.badge,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      ...(verdict.suppression === undefined ? {} : { suppression: verdict.suppression }),
      subLabels: verdict.subLabels,
      issues: status.issues,
      errors,
      instances: instances.map((instance, i) => ({ ...instance, ...verdict.instances[i] }))
    }
  }

  private startRule(
    id: string,
    entry: LoadedRule,
    adopted: Adopted[] | undefined,
    accumulated: ReadonlyMap<string, number> | undefined
  ): void {
    const evaluator = new RuleEvaluator(
      entry.rule,
      this.deps,
      (event) => {
        this.onEvent(id, event)
      },
      adopted,
      accumulated,
      { id, suppressions: this.suppressions }
    )
    this.evaluators.set(id, evaluator)
    // One rule failing to start, such as on a meta read that throws, must not
    // keep the others from starting. The stopped evaluator stays for its
    // status and its restored accumulator totals; like any stop, it clears
    // nothing.
    try {
      evaluator.start()
    } catch (err) {
      evaluator.stop()
      this.failed.add(id)
      this.error(id, `failed to start: ${errorMessage(err)}`)
    }
  }

  private error(id: string, message: string): void {
    const errors = this.errors.get(id) ?? new Set<string>()
    errors.add(message)
    this.errors.set(id, errors)
  }

  private onEvent(id: string, event: RuleEvent): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const now = this.deps.clock()
    const segment = event.instance?.segment
    // An instance whose alert path is invalid shows as inactive in status.
    const path = alertPathFor(entry.origin, entry.rule.slug, segment)
    if (!path.ok) return
    switch (event.type) {
      case 'raise':
        this.emitter.raise(
          path.value,
          this.describe(id, event),
          this.evidence(id, segment ?? ''),
          now
        )
        break
      case 'priority':
        this.emitter.revise(path.value, header(entry.rule, event.instance?.name, event.priority))
        this.emitter.repeat(path.value, now)
        break
      case 'clear':
        this.emitter.clear(path.value)
    }
  }

  /**
   * The alert's message and data, fixed at the raise. Data carries only what
   * changes rarely, so heartbeats never rewrite it; live values belong in
   * the rule's status, not in the alert.
   */
  private describe(id: string, event: Extract<RuleEvent, { type: 'raise' }>): AlertValue {
    const { rule, instance, limit, value } = event
    const data: Record<string, unknown> = { rule: id, name: rule.name }
    if (instance !== undefined) data.instance = instance.name
    if (limit !== undefined) data.limit = limit
    if (value !== undefined) data.valueAtRaise = value
    data.raisedAt = this.deps.wallClock().toISOString()
    return { ...header(rule, instance?.name, event.priority), data }
  }

  private evidence(id: string, segment: string): () => boolean {
    return () => {
      const rule = this.entries.get(id)?.rule
      const instance = this.evaluators.get(id)?.evidence(segment)
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
  private hasEvidence(rule: Rule, instance: Pick<InstanceStatus, 'input' | 'adopted'>): boolean {
    const d = rule.detector
    if (d.type === 'match' && d.op === 'timedOut') return true
    if (instance.adopted && d.type !== 'absence') return instance.input === 'value'
    return instance.input !== 'unavailable'
  }
}
