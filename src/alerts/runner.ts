import {
  carriesTotals,
  measureOf,
  RuleEvaluator,
  type Adopted,
  type EvaluatorContext,
  type Evidence,
  type InstanceStatus,
  type Judgement,
  type RuleEvent
} from '../engine/evaluator.js'
import { firstPriority, severityOf, type Priority, type Rule } from '../model/rule.js'
import {
  conditionOf,
  instanceState,
  ruleCondition,
  ruleStateOf,
  stateReport,
  type Condition,
  type InstanceFacts,
  type RuleStateReport
} from './state.js'
import { ruleAlertPath } from '../model/alertPath.js'
import { instanceAlertPath } from './paths.js'
import {
  AlertEmitter,
  type AlertBody,
  type AlertHeader,
  type AlertsReader,
  type EmitterDeps,
  type Render
} from './emitter.js'
import { reconcile } from './reconcile.js'
import { referencesOf } from './references.js'
import { renderMessage } from './message.js'
import { signalUnits } from './messageUnits.js'
import { errorMessage } from '../util.js'

const INVALID_PATH = { reason: 'alertPathInvalid' } as const

type InstancePath = ReturnType<typeof instanceAlertPath>

/** A rule's alert path, and its instances' by segment. */
interface AlertPaths {
  rule: string
  instances: Map<string, InstancePath>
}

/** What a change of state is: a change of either axis. */
const stateKey = (disabled: boolean, condition: Condition) =>
  `${ruleStateOf(disabled)} ${condition}`

export interface RunnerDeps extends EvaluatorContext, EmitterDeps {
  pluginId: string
  /** Read once at start, to adopt or clear the alerts SKAR already has in core. */
  alerts: AlertsReader
  /** Wall time, for the raise timestamp in alert data and the times in rule states. */
  wallClock: () => Date
}

/** A rule's accumulator totals by instance segment, with the measure they were built under. */
export interface Accumulated {
  measure: string
  totals: Map<string, number>
}

/** What the rule says about an instance's alert at a priority. */
function header(rule: Rule, priority: Priority): AlertHeader {
  return { priority, latching: rule.latching ?? false }
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
  private readonly entries = new Map<string, Rule>()
  private readonly evaluators = new Map<string, RuleEvaluator>()
  private readonly errors = new Map<string, Set<string>>()
  /** Rules whose evaluator threw at start; an edit starts them again. */
  private readonly failed = new Set<string>()
  /** Each rule's state as last observed, and when it took it. */
  private readonly changes = new Map<string, { state: string; at: string }>()
  /**
   * Alert paths by rule id. Every evaluation judges each instance's path,
   * which depends only on the rule and the instance, so they are computed
   * once and renewed when the rule changes.
   */
  private readonly paths = new Map<string, AlertPaths>()

  /**
   * @param accumulated accumulator totals restored from the store, by rule id
   *   and instance segment; applied to the rules started by `start`.
   * @param disabled whether a rule, by id, is disabled; read at every
   *   evaluation, and `refresh` applies a change at once.
   */
  constructor(
    private readonly deps: RunnerDeps,
    rules: readonly Rule[],
    private readonly accumulated: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(),
    private readonly disabled: (id: string) => boolean = () => false
  ) {
    this.emitter = new AlertEmitter(deps)
    for (const rule of rules) this.entries.set(rule.slug, rule)
  }

  start(): void {
    const now = this.deps.clock()
    const reconciled = reconcile(this.deps.alerts.list(), this.deps.pluginId, this.entries)
    const { activeByRule } = reconciled
    for (const alert of reconciled.toClear) this.deps.send(alert.path, null)
    for (const { alert, slug: id, segment } of reconciled.kept) {
      const rule = this.entries.get(id)
      if (rule === undefined) continue
      // The segment is the sanitised name; the raise wrote the name itself into data.
      const name = typeof alert.data?.instance === 'string' ? alert.data.instance : segment
      // Core's priority is the alert's reached priority, as the evaluator
      // reports it; the first step's is above it for a rule edited while
      // SKAR was down. Neither needs the steps, which a zone-limit rule may
      // not be able to read yet.
      const first = firstPriority(rule)
      const priority = severityOf(alert.priority) > severityOf(first) ? alert.priority : first
      const render = this.render(id, rule, segment ?? '', name)
      const evidence = this.evidence(id, segment ?? '')
      this.emitter.adopt(alert, header(rule, priority), evidence, now, render)
      this.seedChangedAt(id, alert.data?.raisedAt)
    }
    for (const [id, rule] of this.entries) {
      this.startRule(id, rule, activeByRule.get(id), this.accumulated.get(id))
    }
    this.emitter.sendAdopted()
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
    // Judged every tick, so a change is timed when it happens, not when
    // someone next looks; judging skips the facts the full state builds.
    const now = this.deps.wallClock().toISOString()
    for (const [id, evaluator] of this.evaluators) {
      const rule = this.entries.get(id)
      if (rule !== undefined) this.changedAt(id, this.judge(id, rule, evaluator), now)
    }
  }

  /**
   * Evaluates a rule now, so disabling or enabling it clears or raises at
   * once rather than at the next sample or tick.
   */
  refresh(id: string): void {
    if (this.failed.has(id)) {
      this.clearIfDisabled(id)
      return
    }
    try {
      this.evaluators.get(id)?.refresh()
    } catch (err) {
      this.error(id, `evaluation failed: ${errorMessage(err)}`)
    }
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
  update(rule: Rule, accumulated?: ReadonlyMap<string, number>): void {
    const id = rule.slug
    const previous = this.entries.get(id)
    this.errors.delete(id)
    const evaluator = this.evaluators.get(id)
    const moved =
      previous !== undefined && this.alertPaths(id, previous).rule !== ruleAlertPath(rule)
    if (evaluator === undefined || this.failed.has(id) || moved) {
      this.failed.delete(id)
      let carried = evaluator === undefined ? accumulated : undefined
      if (evaluator !== undefined && previous !== undefined && carriesTotals(previous, rule)) {
        carried = evaluator.accumulators()
      }
      // Removed while the previous rule is still the entry, so its alerts are
      // cleared at the path they were raised at. The new evaluator starts
      // without adoption, so the old one's adopted alerts would otherwise be
      // heartbeated with nothing to clear them.
      evaluator?.remove()
      this.entries.set(id, rule)
      this.paths.delete(id)
      this.startRule(id, rule, undefined, carried)
      return
    }
    this.entries.set(id, rule)
    this.paths.delete(id)
    evaluator.update(rule)
    // An edit that restarts the rule has cleared and re-raised already; any
    // other edit reaches core with the next heartbeat of each active alert.
    for (const { instance, priority, limit } of evaluator.revisions()) {
      const path = this.instancePath(id, rule, instance?.segment)
      if (path.ok) this.emitter.revise(path.value, priority, limit)
    }
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
    this.changes.delete(id)
    this.paths.delete(id)
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
      const rule = this.entries.get(id)
      const measure = rule === undefined ? undefined : measureOf(rule)
      if (totals.size > 0 && measure !== undefined) accumulated.set(id, { measure, totals })
    }
    return accumulated
  }

  state(id: string): RuleStateReport | undefined {
    const rule = this.entries.get(id)
    const evaluator = this.evaluators.get(id)
    if (rule === undefined || evaluator === undefined) return undefined
    const status = evaluator.status()
    const errors = [...status.errors, ...(this.errors.get(id) ?? [])]
    const wall = this.deps.wallClock().getTime()
    const ago = (seconds: number) => new Date(wall - seconds * 1000).toISOString()
    const disabled = this.disabled(id)
    const started = ago(status.runningFor)
    const instances = status.instances.map((instance) =>
      instanceState(this.facts(id, rule, instance, ago), disabled, started)
    )
    const condition = ruleCondition(this.failing(id, status.errors.length), instances)
    const changedAt = this.changedAt(id, stateKey(disabled, condition.condition), ago(0))
    return stateReport(disabled, condition, changedAt, {
      issues: status.issues,
      errors,
      instances
    })
  }

  /** The rule's state as {@link state} reports it, judged without its facts. */
  private judge(id: string, rule: Rule, evaluator: RuleEvaluator): string {
    const disabled = this.disabled(id)
    const { errors, units } = evaluator.judge()
    const conditions = units.map((u) => ({
      condition: conditionOf(this.judged(id, rule, u), disabled)
    }))
    const { condition } = ruleCondition(this.failing(id, errors), conditions)
    return stateKey(disabled, condition)
  }

  /** Whether the rule's evaluation fails, with `evaluatorErrors` the evaluator's own. */
  private failing(id: string, evaluatorErrors: number): boolean {
    return evaluatorErrors + (this.errors.get(id)?.size ?? 0) > 0
  }

  /**
   * The judgement, with an instance whose alert path core would not accept
   * as a problem: its alert is never emitted.
   */
  private judged(id: string, rule: Rule, judgement: Judgement): Judgement {
    if (judgement.problem !== undefined) return judgement
    const path = this.instancePath(id, rule, judgement.instance?.segment)
    return path.ok ? judgement : { ...judgement, problem: INVALID_PATH }
  }

  /**
   * Dates an enabled rule's alerting state from an adopted alert's raise, the
   * earliest of its alerts': the times kept in memory start over at every
   * plugin start, but the raise time survives in core. A rule the first
   * evaluation judges otherwise is timed from that evaluation.
   */
  private seedChangedAt(id: string, raisedAt: unknown): void {
    if (typeof raisedAt !== 'string') return
    const time = Date.parse(raisedAt)
    if (Number.isNaN(time)) return
    const at = new Date(time).toISOString()
    const state = stateKey(false, 'alerting')
    const seeded = this.changes.get(id)
    if (seeded === undefined || at < seeded.at) this.changes.set(id, { state, at })
  }

  /** The rule's alert path and its instances' as far as computed, kept until the rule changes. */
  private alertPaths(id: string, rule: Rule): AlertPaths {
    let paths = this.paths.get(id)
    if (paths === undefined) {
      paths = { rule: ruleAlertPath(rule), instances: new Map() }
      this.paths.set(id, paths)
    }
    return paths
  }

  /** An instance's alert path, or that core would not accept it. */
  private instancePath(id: string, rule: Rule, segment: string | undefined): InstancePath {
    const paths = this.alertPaths(id, rule)
    const key = segment ?? ''
    let path = paths.instances.get(key)
    if (path === undefined) {
      path = instanceAlertPath(paths.rule, segment)
      paths.instances.set(key, path)
    }
    return path
  }

  /** When the rule took the state it has now: `now` when it differs from the one last observed. */
  private changedAt(id: string, state: string, now: string): string {
    const last = this.changes.get(id)
    if (last?.state === state) return last.at
    this.changes.set(id, { state, at: now })
    return now
  }

  private facts(
    id: string,
    rule: Rule,
    instance: InstanceStatus,
    ago: (seconds: number) => string
  ): InstanceFacts {
    const path = this.instancePath(id, rule, instance.instance?.segment)
    const alert = path.ok ? this.emitter.status(path.value) : undefined
    return {
      ...(instance.instance === undefined ? {} : { instance: instance.instance }),
      judgement: this.judged(id, rule, instance.judgement),
      gates: instance.gates,
      value: instance.value,
      limit: instance.limit,
      ...(instance.passed === undefined ? {} : { passed: instance.passed }),
      progress: instance.progress,
      ...(instance.clearedFor === undefined ? {} : { clearedAt: ago(instance.clearedFor) }),
      ...(instance.sinceValue === undefined ? {} : { lastSeen: ago(instance.sinceValue) }),
      awaitingInput: alert?.awaitingInput === true,
      ...(alert === undefined ? {} : { message: alert.message })
    }
  }

  private startRule(
    id: string,
    rule: Rule,
    adopted: Adopted[] | undefined,
    accumulated: ReadonlyMap<string, number> | undefined
  ): void {
    const evaluator = new RuleEvaluator(
      rule,
      this.deps,
      (event) => {
        this.onEvent(id, event)
      },
      adopted,
      accumulated,
      () => this.disabled(id)
    )
    this.evaluators.set(id, evaluator)
    // One rule failing to start, such as on a meta read that throws, must not
    // keep the others from starting. The stopped evaluator stays for its
    // status and its restored accumulator totals; like any stop, it clears
    // nothing, unless the rule is disabled.
    try {
      evaluator.start()
    } catch (err) {
      evaluator.stop()
      this.failed.add(id)
      this.error(id, `failed to start: ${errorMessage(err)}`)
      this.clearIfDisabled(id)
    }
  }

  /**
   * Clears the adopted alerts of a rule that failed to start once it is
   * disabled. Its stopped evaluator never steps, and stepping is what clears
   * a disabled rule's alerts.
   */
  private clearIfDisabled(id: string): void {
    if (this.disabled(id)) this.evaluators.get(id)?.remove()
  }

  private error(id: string, message: string): void {
    const errors = this.errors.get(id) ?? new Set<string>()
    errors.add(message)
    this.errors.set(id, errors)
  }

  private onEvent(id: string, event: RuleEvent): void {
    const rule = this.entries.get(id)
    if (rule === undefined) return
    const now = this.deps.clock()
    const segment = event.instance?.segment
    // An instance whose alert path is invalid shows as inactive in status.
    const path = this.instancePath(id, rule, segment)
    if (!path.ok) return
    switch (event.type) {
      case 'raise':
        this.emitter.raise(
          path.value,
          this.describe(id, event),
          this.evidence(id, segment ?? ''),
          now,
          this.render(id, event.rule, segment ?? '', event.instance?.name)
        )
        break
      case 'priority':
        this.emitter.revise(path.value, event.priority, event.limit)
        this.emitter.repeat(path.value, now)
        break
      case 'clear':
        this.emitter.clear(path.value)
    }
  }

  /**
   * The alert's references and data, fixed at the raise; the emitter renders
   * its message. Data carries only what changes rarely, so heartbeats never
   * rewrite it; live values belong in the rule's status and the message, not
   * in data.
   */
  private describe(id: string, event: Extract<RuleEvent, { type: 'raise' }>): AlertBody {
    const { rule, instance, limit, value } = event
    const data: Record<string, unknown> = { rule: id, name: rule.name }
    if (instance !== undefined) data.instance = instance.name
    if (limit !== undefined) data.limit = limit
    if (value !== undefined) data.valueAtRaise = value
    data.raisedAt = this.deps.wallClock().toISOString()
    const references = referencesOf(rule, instance?.name)
    return {
      ...header(rule, event.priority),
      ...(references.length === 0 ? {} : { references }),
      data
    }
  }

  /**
   * Renders an instance's message as it reads now: the rule as it is now,
   * the input's last value and the limit of the step the alert has reached,
   * or the limit last sent when no step set the alert's priority, or else
   * the step at the alert's index. `rule`
   * stands in for a rule the runner no longer holds.
   */
  private render(id: string, rule: Rule, segment: string, name: string | undefined): Render {
    return (sentLimit) => this.message(id, rule, segment, name, sentLimit)
  }

  private message(
    id: string,
    rule: Rule,
    segment: string,
    name: string | undefined,
    sentLimit: number | undefined
  ): string {
    const current = this.entries.get(id) ?? rule
    const reached = this.evaluators.get(id)?.reached(segment)
    const instance = name === undefined ? undefined : { name, segment }
    let units: string | undefined
    try {
      units = signalUnits(current.signal, instance, this.deps.meta)
    } catch {
      // A meta read that throws already fails the rule's start, which its
      // state reports; the message then goes without a unit rather than
      // stopping the heartbeat of every alert.
    }
    const limit = reached?.limit ?? sentLimit
    // Without a step that set the alert's priority or a limit in its data,
    // the step at the alert's index is the best the rule can name. An adopted
    // alert whose input has not reported yet has no unit, and starts at 0.
    const step = reached?.step ?? (limit === undefined ? (reached?.index ?? 0) : undefined)
    return renderMessage(current, { instance: name, value: reached?.value, step, limit, units })
  }

  private evidence(id: string, segment: string): () => boolean {
    return () => {
      const rule = this.entries.get(id)
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
  private hasEvidence(rule: Rule, instance: Evidence): boolean {
    const d = rule.detector
    if (d.type === 'match' && d.op === 'timedOut') return true
    if (instance.adopted && d.type !== 'absence') return instance.input === 'value'
    return instance.input !== 'unavailable'
  }
}
