import type { SubscriptionManager } from '@signalk/server-api'
import {
  firstPriority,
  LEVEL_PRIORITY,
  severityOf,
  stepsOf,
  zoneLimitOf,
  type Limit,
  type Priority,
  type Rule,
  type Signal,
  type ZoneLevel
} from '../model/rule.js'
import { ruleAlertPath } from '../model/alertPath.js'
import { wildcards } from '../alerts/paths.js'
import { isPointerPath } from '../model/pointerPath.js'
import type { Clock } from './clock.js'
import {
  AccumulatorDetector,
  createDetector,
  SustainedDetector,
  type Detector,
  type DetectorOptions,
  type DetectorSpec,
  type Progress,
  type Side
} from './detectors/index.js'
import { Gate } from './gates.js'
import {
  limitDirection,
  resolveLimit,
  severerLevels,
  zonePath,
  type MissingZone,
  type Zone
} from './limits.js'
import {
  bindPath,
  inputState,
  openSignal,
  type InputState,
  type Instance,
  type Reading,
  type Sample,
  type SignalValue
} from './signals.js'
import { asGiven, canonicalSources, type Canonicalise } from './sourceRefs.js'
import { stepSpec } from './steps.js'
import { errorMessage } from '../util.js'

export type { InputState }

/** The parts of a path's `meta` the evaluator reads. */
export interface PathMeta {
  zones?: Zone[] | null
  units?: string
  timeout?: number | string
  updateContract?: string
}

/** The server's data-timeout settings, which decide whether a path can time out. */
export interface TimeoutSettings {
  enforce: boolean
  useDefaults: boolean
}

export interface EvaluatorContext {
  subscriptions: SubscriptionManager
  meta: (path: string) => PathMeta | undefined
  /** Undefined when the settings cannot be read; the check then assumes paths can time out. */
  timeoutSettings: () => TimeoutSettings | undefined
  clock: Clock
  /** How a pinned source is matched; absent, refs are compared as given. */
  canonicalSource?: Canonicalise
  /** Called when an accumulator's `resetOn` event zeroes a total, so it can be saved at once. */
  onAccumulatorReset?: () => void
}

/** An alert core already holds for this rule, adopted at start. */
export interface Adopted {
  /** The alert path's instance segment, for a wildcard rule. */
  segment?: string
  /**
   * The priority core holds the alert at, which the alert's reached priority
   * starts from. It seeds no step: core's priority is not evidence of which
   * step's condition held.
   */
  priority?: Priority
}

export type RuleEvent =
  | {
      type: 'raise'
      instance?: Instance
      priority: Priority
      /** The rule as it is at the raise; message and latching come from it. */
      rule: Rule
      value?: SignalValue
      limit?: number
    }
  /**
   * An active alert reached a further step, so it now has this priority.
   * Nothing sends a lower one: core never lowers an alert's priority.
   */
  | { type: 'priority'; instance?: Instance; priority: Priority; limit?: number }
  | { type: 'clear'; instance?: Instance }

/** Why the server can never time a timeout rule's path out. */
export type TimeoutCause =
  'booleanPath' | 'stringPath' | 'notEnforced' | 'updateContract' | 'timeoutOff' | 'noTimeout'

/**
 * Why a rule cannot evaluate an instance, as a reason code and its facts: a
 * zone level missing from the path its limit or a gate's (`gate`, by index)
 * reads, a timeout rule's path the server never times out, an angular
 * combination of an input in other units than radians, or an alert path core
 * would not accept.
 */
export type Problem =
  | ({ reason: 'missingZone'; gate?: number } & MissingZone)
  | { reason: 'timeoutNotPossible'; cause: TimeoutCause; contract?: string }
  | { reason: 'unitsNotRadians'; path: string; units: string }
  | { reason: 'alertPathInvalid' }

export interface GateStatus {
  /** The path the gate reads for this instance; absent for a combined signal. */
  path?: string
  /** The gate input's value in SI units, while it has one. */
  value?: SignalValue
  /** Whether the gate holds for this instance, as the rule reads it. */
  holds: boolean
  input: InputState
}

export interface InstanceStatus {
  instance?: Instance
  inUse: boolean
  /** The signal's current value in SI units, while it has one; a combined signal's combined value. */
  value?: SignalValue
  /**
   * A sustained or projection rule's limit in force, in SI units: the reached
   * step's while the alert is active, else the first step's. An outside
   * rule's is that step's limit on the side the value last went past, absent
   * until it has gone past one.
   */
  limit?: number
  /** The side of an outside rule's limit. */
  passed?: Side
  /** How far the detector is toward its next transition. */
  progress?: Progress
  /** One entry per gate of the rule, in its order. */
  gates: GateStatus[]
  /**
   * Whether the condition holds, as last judged. While the rule is out of use
   * or unable to evaluate the last judged value is kept, and back in use it
   * is kept until the restarted detector has decided.
   */
  conditionPresent: boolean
  /**
   * Seconds since the condition last stopped holding; absent while it holds
   * or when it has not held since start. Being out of use neither starts nor
   * stops it, and coming back into use is no clear while the restarted
   * detector waits out its duration.
   */
  clearedFor?: number
  /**
   * The condition is present only because an adopted alert seeded it: the
   * input has not reported since start, and the rule's condition is not the
   * input's silence.
   */
  conditionAssumed: boolean
  /** Seconds since the input last had a value; absent when it has had none since start. */
  sinceValue?: number
  /** What its condition is judged from, as {@link RuleEvaluator.judge} reports it. */
  judgement: Judgement
}

/**
 * What an instance's condition is judged from, the one derivation both the
 * timing of a change and the reported state read.
 */
export interface Judgement {
  instance?: Instance
  /** Why the rule cannot evaluate the instance. */
  problem?: Problem
  /** The active alert: the furthest step it reached, with the priority and zone level it has. */
  alert?: { step: number; priority: Priority; level?: ZoneLevel }
  gatesHold: boolean
  /** The condition holds, judged in this run rather than assumed from an adopted alert. */
  present: boolean
  /**
   * The condition held when the gate last closed, and the restarted detector
   * has not decided since: it is neither present nor known to have cleared.
   */
  undecided: boolean
  input: InputState
}

/** What an instance's input evidence depends on. */
export interface Evidence {
  input: InputState
  /** The alert was adopted from core at start and has not cleared since. */
  adopted: boolean
}

export interface RuleStatus {
  /** Conditions that do not stop the rule, such as a rejected wildcard instance. */
  issues: string[]
  /** Subscription failures, which leave the rule without its input. */
  errors: string[]
  /** Seconds since the rule last started, at plugin start or on an edit that restarts it. */
  runningFor: number
  instances: InstanceStatus[]
}

interface Track {
  detector?: Detector
  specKey?: string
}

interface Unit {
  key: string
  instance?: Instance
  last?: Reading
  /** The last value the input had, which outlives an unavailable reading. */
  lastValue?: SignalValue
  /** When the input last had a value. */
  lastValueAt?: number
  /** One detector per step, the first step's first. */
  tracks: Track[]
  /** The steps as last resolved; empty while they cannot be. */
  steps: ResolvedStep[]
  /**
   * The furthest step the active alert has reached; never lowered while it
   * lasts, but clamped when an edit removes steps.
   */
  step?: number
  /**
   * The most severe priority the active alert has had, starting from core's
   * for an adopted alert. An edit that removes the reached step or lowers its
   * priority does not lower the alert's, as core never does.
   */
  reached?: Priority
  /** Create the first step's next detector in the condition-active state. */
  startActive: boolean
  /** The alert was adopted from core and has not cleared; never-seen gates hold for it. */
  adoptedAlert: boolean
  alerting: boolean
  inUse: boolean
  inactive?: Problem
  present: boolean
  /**
   * The detectors restarted while the condition was present, so until the
   * first step's detector has decided its state is no evidence of a clear.
   */
  resuming: boolean
  /** When the condition last stopped holding. */
  clearedAt?: number
}

/** A step with its limit resolved, and the detector that judges it. */
interface ResolvedStep {
  priority: Priority
  spec: DetectorSpec
  /**
   * The SI limit of a sustained or projection step. An outside step has two,
   * and which one applies is known only from its detector: {@link passedAt}.
   */
  limit?: number
  /** The zone level the step comes from, for a zone-limit rule. */
  level?: ZoneLevel
}

type Resolved = { ok: true; steps: ResolvedStep[] } | { ok: false; missing: MissingZone }

// Rule fields whose change clears and restarts the rule; every other detector
// field is re-evaluated in place. Latching is one of them because a latching
// rule holds no active alert: an ongoing alert is cleared before the rule
// turns momentary, and a momentary one is raised afresh when it turns ongoing.
const STRUCTURAL: {
  [T in DetectorSpec['type']]: (keyof Extract<DetectorSpec, { type: T }>)[]
} = {
  match: ['op'],
  sustained: ['direction'],
  outside: [],
  slope: ['direction'],
  projection: ['direction'],
  accumulator: ['measure', 'while', 'resetOn'],
  count: ['event'],
  absence: ['event']
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )
}

// A match's values are structural like its operator: re-evaluated in place, an
// active match of a value no longer listed would hold until the next sample.
// A zone limit's named level is structural too: re-evaluated in place, an
// active alert would at once report the new level, which the value may never
// have entered, while its detector stays active within the hysteresis. The
// alert path is listed so that the edit preview names it: `RuleRunner.update`
// moves an alert whose path changes before an evaluator sees the edit.
function structure(rule: Rule): Record<string, unknown> {
  const fields: readonly string[] = ['type', ...STRUCTURAL[rule.detector.type]]
  return {
    alertPath: ruleAlertPath(rule),
    signal: rule.signal,
    gates: rule.gates ?? [],
    latching: rule.latching ?? false,
    'detector.limit': zoneLimitOf(rule) === undefined ? 'steps' : 'zone',
    'detector.limit.level': zoneLimitOf(rule)?.level,
    'detector.steps.value':
      rule.detector.type === 'match' ? rule.detector.steps.map((s) => s.value) : undefined,
    ...Object.fromEntries(
      Object.entries(rule.detector)
        .filter(([key]) => fields.includes(key))
        .map(([key, value]) => [`detector.${key}`, value])
    )
  }
}

/**
 * The parts of a rule an edit changes that make it clear and restart, named
 * by field path; empty for an edit re-evaluated in place.
 */
export function structuralChanges(current: Rule, next: Rule): string[] {
  const a = structure(current)
  const b = structure(next)
  const parts = new Set([...Object.keys(a), ...Object.keys(b)])
  const changes = [...parts].filter((part) => canonical(a[part]) !== canonical(b[part]))
  // Steps have no zone level, so a switch between kinds changes the level too;
  // it is one change.
  return changes.includes('detector.limit')
    ? changes.filter((part) => part !== 'detector.limit.level')
    : changes
}

export function isWildcard(signal: Signal): boolean {
  return !('combinator' in signal) && wildcards(signal.path) > 0
}

/**
 * Evaluates one rule on the self vessel: its signal per instance through a
 * detector per step, its gates and zone limits. It reports raises, climbs to
 * a further step and clears; what happens to the alert after that is core's
 * lifecycle, not the evaluator's. A rule is in use only while every gate holds. Out of use, a detector is dropped and
 * started afresh when the rule comes back into use, fed the last reading, so
 * durations count from then; an accumulator keeps its total and only its
 * alert is held back. A disabled rule is evaluated as usual, so whether its
 * condition holds is known and an accumulator keeps counting, but it raises
 * nothing: its active alert is cleared, and one whose condition still holds
 * when the rule is enabled again is raised as a new alert.
 */
export class RuleEvaluator {
  private readonly units = new Map<string, Unit>()
  private gates: Map<string, Gate>[] = []
  private closers: (() => void)[] = []
  private readonly issues = new Set<string>()
  private readonly errors = new Set<string>()
  /** Adopted alerts' core priorities, by instance key. */
  private adopted: Map<string, Priority | undefined>
  private carried = new Map<string, number>()
  private running = false
  private startedAt = 0

  constructor(
    private rule: Rule,
    private readonly ctx: EvaluatorContext,
    private readonly onEvent: (event: RuleEvent) => void,
    adopted: readonly Adopted[] = [],
    accumulated: ReadonlyMap<string, number> = new Map(),
    /** Read at every evaluation; `refresh` applies a change at once. */
    private readonly disabled: () => boolean = () => false
  ) {
    this.adopted = new Map(adopted.map((a) => [a.segment ?? '', a.priority]))
    this.carried = new Map(accumulated)
  }

  start(): void {
    const now = this.ctx.clock()
    this.running = true
    this.startedAt = now
    const gates = this.rule.gates ?? []
    this.gates = gates.map(() => new Map<string, Gate>())
    for (const key of this.adopted.keys()) {
      this.unit(key, key === '' ? undefined : { name: key, segment: key })
    }
    if (!isWildcard(this.rule.signal)) this.unit('')
    const handlers = (onSample: (s: Sample) => void) => ({
      onSample,
      onIssue: (message: string) => {
        this.issues.add(message)
      },
      onError: (err: unknown) => {
        this.errors.add(errorMessage(err))
      }
    })
    gates.forEach((gate, i) => {
      this.closers.push(
        openSignal(
          gate.signal,
          this.ctx.subscriptions,
          handlers((s) => {
            this.onGate(i, s)
          }),
          this.ctx.canonicalSource
        )
      )
    })
    this.closers.push(
      openSignal(
        this.rule.signal,
        this.ctx.subscriptions,
        handlers((s) => {
          this.onSignal(s)
        }),
        this.ctx.canonicalSource
      )
    )
    for (const unit of this.units.values()) this.step(unit, now)
  }

  tick(): void {
    if (!this.running) return
    const now = this.ctx.clock()
    for (const byKey of this.gates) for (const gate of byKey.values()) gate.tick(now)
    for (const unit of this.units.values()) this.step(unit, now)
  }

  /** Evaluates every instance now, so disabling or enabling the rule applies at once. */
  refresh(): void {
    if (!this.running) return
    const now = this.ctx.clock()
    for (const unit of this.units.values()) this.step(unit, now)
  }

  /** Applies an edited rule per the edit semantics. */
  update(rule: Rule): void {
    // A stopped evaluator must not clear: stop means the plugin is going away.
    if (!this.running) {
      this.rule = rule
      this.units.clear()
      return
    }
    const now = this.ctx.clock()
    // A pin running in address form that only changes form is no change:
    // the open subscription matches by canonical form either way.
    const canonical = this.ctx.canonicalSource ?? asGiven
    const current = canonicalSources(this.rule, canonical)
    if (structuralChanges(current, canonicalSources(rule, canonical)).length > 0) {
      this.carried = this.totals(rule)
      this.remove()
      this.rule = rule
      this.adopted = new Map()
      this.units.clear()
      this.issues.clear()
      this.errors.clear()
      this.start()
      return
    }
    this.rule = rule
    for (const unit of this.units.values()) this.step(unit, now)
  }

  /** Stops evaluating without clearing: stop runs on every configuration save. */
  stop(): void {
    this.running = false
    for (const close of this.closers) close()
    this.closers = []
  }

  /**
   * Zeroes an accumulator rule's totals, restored ones included, and clears
   * its alerts. A running rule goes on accumulating from zero.
   */
  reset(): void {
    this.carried.clear()
    for (const unit of this.units.values()) {
      if (unit.alerting) this.clear(unit)
      unit.tracks = []
    }
    if (!this.running) return
    const now = this.ctx.clock()
    for (const unit of this.units.values()) this.step(unit, now)
  }

  /** Clears the rule's alerts and stops, for a deleted rule. */
  remove(): void {
    for (const unit of this.units.values()) if (unit.alerting) this.clear(unit)
    this.stop()
  }

  /**
   * An accumulator rule's totals by instance segment, for the store's
   * checkpoint. An instance restored but not seen since start keeps its
   * restored total, so a checkpoint before it reports does not lose it.
   */
  accumulators(): Map<string, number> {
    if (this.rule.detector.type !== 'accumulator') return new Map()
    const totals = new Map(this.carried)
    for (const unit of this.units.values()) {
      const total = accumulatedOf(unit)
      if (total !== undefined) totals.set(unit.key, total)
    }
    return totals
  }

  status(): RuleStatus {
    const now = this.ctx.clock()
    const silence = judgesSilence(this.rule)
    return {
      issues: [...this.issues],
      errors: [...this.errors],
      runningFor: now - this.startedAt,
      instances: [...this.units.values()].map((u) => {
        const step = u.alerting ? (u.step ?? 0) : 0
        const passed = passedAt(u, step)
        return {
          instance: u.instance,
          inUse: u.inUse,
          value: u.last?.available === true ? u.last.value : undefined,
          limit: stepLimit(u, step),
          ...(passed === undefined ? {} : { passed: passed.side }),
          progress: u.tracks.at(0)?.detector?.progress(now),
          gates: this.gateStatus(u),
          conditionPresent: u.present,
          clearedFor: u.present || u.clearedAt === undefined ? undefined : now - u.clearedAt,
          conditionAssumed: assumed(u, silence),
          sinceValue: u.lastValueAt === undefined ? undefined : now - u.lastValueAt,
          judgement: this.judgeUnit(u, silence)
        }
      })
    }
  }

  /**
   * What each instance's condition is judged from, read without building the
   * status: the runner judges every rule at every evaluation. `errors` are
   * the rule's subscription failures, as in the status.
   */
  judge(): { errors: number; units: Judgement[] } {
    const silence = judgesSilence(this.rule)
    return {
      errors: this.errors.size,
      units: [...this.units.values()].map((u) => this.judgeUnit(u, silence))
    }
  }

  private judgeUnit(u: Unit, silence: boolean): Judgement {
    const step = u.step ?? 0
    const level = u.alerting ? this.levelAt(u, step) : undefined
    return {
      instance: u.instance,
      ...(u.inactive === undefined ? {} : { problem: u.inactive }),
      ...(u.alerting
        ? {
            alert: {
              step,
              priority: this.reachedAt(u, step),
              ...(level === undefined ? {} : { level })
            }
          }
        : {}),
      gatesHold: (this.rule.gates ?? []).every((_, i) => this.holds(this.gateOf(u, i), u)),
      present: u.present && !u.resuming && !assumed(u, silence),
      undecided: u.resuming,
      input: inputState(u.last)
    }
  }

  /**
   * What an instance's input evidence depends on, read without building the
   * status: the heartbeat asks for it for every active alert.
   */
  evidence(segment: string): Evidence | undefined {
    const unit = this.units.get(segment)
    return unit === undefined
      ? undefined
      : { input: inputState(unit.last), adopted: unit.adoptedAlert }
  }

  /**
   * What an instance's alert message is filled in from, read without
   * building the status: the input's last value, which outlives an
   * unavailable reading, and the step the alert has reached with its SI
   * limit, the first step's while no alert is active. The step and its limit
   * are left out when {@link ownStep} finds no step that set the alert's
   * priority; `index` is the alert's step index either way.
   */
  reached(
    segment: string
  ): { value?: SignalValue; index: number; step?: number; limit?: number } | undefined {
    const unit = this.units.get(segment)
    if (unit === undefined) return undefined
    const value = unit.lastValue
    if (!unit.alerting) return { value, index: 0, step: 0, limit: limitOf(unit, 0) }
    const index = unit.step ?? 0
    return this.ownStep(unit, index) === undefined
      ? { value, index }
      : { value, index, step: index, limit: limitOf(unit, index) }
  }

  /**
   * What each active alert's emissions say after an edit applied in place:
   * the reached priority, and the limit of the step that set it, as
   * {@link ownStep} finds it. Without such a step the edit sends no limit,
   * and core keeps the one it holds.
   */
  revisions(): { instance?: Instance; priority: Priority; limit?: number }[] {
    return [...this.units.values()].flatMap((u) => {
      if (!u.alerting) return []
      const step = u.step ?? 0
      const priority = this.reachedAt(u, step)
      const limit = this.ownStep(u, step) === undefined ? undefined : stepLimit(u, step)
      return [{ instance: u.instance, priority, limit }]
    })
  }

  /**
   * The step at an active alert's index while that step has the alert's
   * reached priority. Otherwise it is not the step that set it: an edit
   * inserted one ahead of it or lowered its priority, or an adopted alert
   * came with a priority above the first step's.
   */
  private ownStep(unit: Unit, step: number): ResolvedStep | undefined {
    const own = unit.steps.at(step)
    return own?.priority === this.reachedAt(unit, step) ? own : undefined
  }

  private unit(key: string, instance?: Instance): Unit {
    let unit = this.units.get(key)
    if (unit === undefined) {
      const adopted = this.adopted.has(key)
      unit = {
        key,
        instance,
        tracks: [],
        steps: [],
        step: adopted ? 0 : undefined,
        startActive: adopted,
        adoptedAlert: adopted,
        reached: this.adopted.get(key),
        alerting: adopted,
        inUse: false,
        present: adopted,
        resuming: false
      }
      this.units.set(key, unit)
    } else if (instance !== undefined) {
      unit.instance = instance
    }
    return unit
  }

  private onSignal(sample: Sample): void {
    const unit = this.unit(sample.instance?.segment ?? '', sample.instance)
    unit.last = sample.reading
    if (sample.reading.available) {
      unit.lastValue = sample.reading.value
      unit.lastValueAt = this.ctx.clock()
    }
    this.step(unit, this.ctx.clock(), sample)
  }

  private onGate(i: number, sample: Sample): void {
    const now = this.ctx.clock()
    const key = sample.instance?.segment ?? ''
    this.gate(i, key, sample.instance).sample(sample.reading, sample.replayed, now)
    if (sample.instance === undefined) {
      for (const unit of this.units.values()) this.step(unit, now)
    } else {
      const unit = this.units.get(key)
      if (unit !== undefined) this.step(unit, now)
    }
  }

  private gate(i: number, key: string, instance?: Instance): Gate {
    const model = (this.rule.gates ?? [])[i]
    const byKey = this.gates[i]
    const shared = !isWildcard(model.signal)
    const k = shared ? '' : key
    let gate = byKey.get(k)
    if (gate === undefined) {
      const bound = () => this.units.get(k)?.instance ?? instance
      gate = new Gate(model, () => this.zones(model.limit, model.signal, bound()), this.ctx.clock())
      byKey.set(k, gate)
    }
    return gate
  }

  private gatesOf(unit: Unit): Gate[] {
    return (this.rule.gates ?? []).map((_, i) => this.gate(i, unit.key, unit.instance))
  }

  /** The gates as the unit reads them, without creating any. */
  private gateStatus(unit: Unit): GateStatus[] {
    return (this.rule.gates ?? []).map((model, i) => {
      const gate = this.gateOf(unit, i)
      const path =
        'combinator' in model.signal ? {} : { path: bindPath(model.signal.path, unit.instance) }
      if (gate === undefined) return { ...path, holds: unit.adoptedAlert, input: 'neverSeen' }
      const value = gate.value
      return {
        ...path,
        ...(value === undefined ? {} : { value }),
        holds: this.holds(gate, unit),
        input: gate.input
      }
    })
  }

  /** The unit's gate `i`, without creating it. */
  private gateOf(unit: Unit, i: number): Gate | undefined {
    const model = (this.rule.gates ?? [])[i]
    return this.gates[i]?.get(isWildcard(model.signal) ? unit.key : '')
  }

  /** Whether the gate holds for the unit; one not seen holds only for an adopted alert. */
  private holds(gate: Gate | undefined, unit: Unit): boolean {
    return gate?.seen === true ? gate.holdsFor(unit.adoptedAlert) : unit.adoptedAlert
  }

  private zones(limit: Limit, signal: Signal, instance: Instance | undefined) {
    if (limit.kind !== 'zone') return undefined
    const path = zonePath(limit, signal)
    return path === undefined ? undefined : this.ctx.meta(bindPath(path, instance))?.zones
  }

  private resolve(unit: Unit): Resolved {
    const d = this.rule.detector
    const zone = zoneLimitOf(this.rule)
    if (zone === undefined || (d.type !== 'sustained' && d.type !== 'projection')) {
      const steps = stepsOf(this.rule).flatMap((step, i) => {
        const spec = stepSpec(d, i)
        if (spec === undefined) return []
        const limit =
          spec.type === 'sustained' || spec.type === 'projection' ? spec.limit : undefined
        return [{ priority: step.priority, spec, limit }]
      })
      return { ok: true, steps }
    }
    const { steps: _steps, limit: _zone, ...rest } = d
    const direction = limitDirection(d)
    const zones = this.zones(zone, this.rule.signal, unit.instance)
    const resolved = resolveLimit(zone, direction, zones)
    if (!resolved.ok) return resolved
    // Only a sustained zone-limit rule escalates through levels: a
    // projection's detectors for more severe levels would share its horizon,
    // so a steady trend would set them all at once and the first alert would
    // name a level the value is nowhere near.
    const levels = [
      { level: zone.level, value: resolved.value },
      ...(rest.type === 'sustained' ? severerLevels(zone, direction, zones) : [])
    ]
    const steps = levels.map(({ level, value }) => ({
      priority: LEVEL_PRIORITY[level],
      spec: { ...rest, limit: value },
      limit: value,
      level
    }))
    return { ok: true, steps }
  }

  /** An angular combination of an input the server reports in units other than radians. */
  private unitsProblem(): Problem | undefined {
    const signal = this.rule.signal
    if (!('combinator' in signal) || signal.angular !== true) return undefined
    for (const input of signal.inputs) {
      const units = this.ctx.meta(input.path)?.units
      if (units !== undefined && units !== 'rad') {
        return { reason: 'unitsNotRadians', path: input.path, units }
      }
    }
    return undefined
  }

  private timeoutProblem(unit: Unit): Problem | undefined {
    const d = this.rule.detector
    if (d.type !== 'match' || d.op !== 'timedOut' || 'combinator' in this.rule.signal) {
      return undefined
    }
    const problem = (cause: TimeoutCause, contract?: string): Problem => ({
      reason: 'timeoutNotPossible',
      cause,
      ...(contract === undefined ? {} : { contract })
    })
    // Core times out an object path whatever its fields hold.
    if (!isPointerPath(this.rule.signal.path)) {
      if (typeof unit.lastValue === 'boolean') return problem('booleanPath')
      if (typeof unit.lastValue === 'string') return problem('stringPath')
    }
    const settings = this.ctx.timeoutSettings()
    if (settings !== undefined && !settings.enforce) return problem('notEnforced')
    // Meta exists only once the path has a value; a path never seen since
    // start is the dead-at-boot case, which fires without a marker.
    if (unit.last === undefined) return undefined
    const meta = this.ctx.meta(bindPath(this.rule.signal.path, unit.instance))
    const contract = meta?.updateContract
    if (contract !== undefined && contract !== 'periodic')
      return problem('updateContract', contract)
    if (typeof meta?.timeout === 'number' && meta.timeout <= 0) return problem('timeoutOff')
    if (settings !== undefined && !settings.useDefaults && meta?.timeout === undefined) {
      return problem('noTimeout')
    }
    return undefined
  }

  private step(unit: Unit, now: number, feed?: Sample): void {
    const disabled = this.disabled()
    if (disabled && unit.alerting) this.clear(unit)
    const resolved = this.resolve(unit)
    // Zones are readable only once the path has a value; until then hold.
    if (!resolved.ok && unit.last === undefined) return
    const gates = this.gatesOf(unit)
    const problem =
      this.timeoutProblem(unit) ??
      this.unitsProblem() ??
      gateProblem(gates) ??
      limitProblem(resolved)
    unit.inactive = problem
    unit.steps = resolved.ok ? resolved.steps : []
    // A step an edit or a zone change removed is no longer reached; the
    // alert stays at the furthest step left, and core at its priority. An
    // edit that raised the reached step's priority has reached core through
    // the next emission, so it is reached too.
    if (unit.step !== undefined) {
      unit.step = Math.min(unit.step, Math.max(unit.steps.length - 1, 0))
      if (unit.alerting) unit.reached = this.reachedAt(unit, unit.step)
    }

    const gatesHold = gates.every((g) => this.holds(g, unit))
    if (problem !== undefined || !gatesHold || !resolved.ok) {
      unit.inUse = false
      if (resolved.ok && this.rule.detector.type === 'accumulator') {
        this.drive(unit, resolved.steps, now, feed)
      } else {
        unit.tracks = []
      }
      if (unit.alerting) this.clear(unit)
      return
    }
    unit.inUse = true
    if (unit.tracks.length === 0 && unit.present) unit.resuming = true
    const transitions = this.drive(unit, resolved.steps, now, feed)
    const pulsed = transitions.lastIndexOf('pulse')
    if (pulsed >= 0) {
      // An event holds for a moment only: it has cleared again by now.
      this.recordCondition(unit, true, now)
      this.recordCondition(unit, false, now)
      if (!disabled && !unit.alerting) {
        this.raise(unit, pulsed)
        this.clear(unit)
      }
      return
    }
    const furthest = unit.tracks.map((t) => t.detector?.active === true).lastIndexOf(true)
    const active = furthest >= 0
    if (active || unit.tracks.at(0)?.detector?.decided !== false) unit.resuming = false
    if (!unit.resuming) this.recordCondition(unit, active, now)
    if (disabled) return
    if (active && !unit.alerting) this.raise(unit, furthest)
    else if (!active && unit.alerting) this.clear(unit)
    else if (unit.alerting && furthest > (unit.step ?? 0)) this.escalate(unit, furthest)
  }

  /**
   * Creates, reconfigures and feeds the detector of each step, and returns
   * their transitions. A step's condition holds at that step and beyond it,
   * so the alert is active while any step's detector is. Only the first
   * starts active for an adopted alert, which so holds the first step until a
   * further one has been reached for the duration.
   */
  private drive(unit: Unit, steps: ResolvedStep[], now: number, feed?: Sample) {
    unit.tracks = unit.tracks.slice(0, steps.length)
    const transitions = steps.map((step, i) => {
      const track = unit.tracks.at(i) ?? {}
      unit.tracks[i] = track
      const options = {
        start: now,
        active: i === 0 && unit.startActive,
        // A step added later starts from the total the first step has reached.
        accumulated: (i === 0 ? undefined : accumulatedOf(unit)) ?? this.carried.get(unit.key),
        onReset: this.ctx.onAccumulatorReset
      }
      return this.run(track, step.spec, options, unit.last, now, feed)
    })
    unit.startActive = false
    return transitions
  }

  /** Creates, reconfigures and feeds a detector, and returns its transition. */
  private run(
    track: Track,
    spec: DetectorSpec,
    options: DetectorOptions,
    last: Reading | undefined,
    now: number,
    feed?: Sample
  ) {
    const specKey = canonical(spec)
    let detector = track.detector
    if (detector === undefined) {
      detector = createDetector(spec, options)
      track.detector = detector
      track.specKey = specKey
      if (feed === undefined && last !== undefined) detector.sample(last, true, now)
    } else if (track.specKey !== specKey) {
      track.specKey = specKey
      const transition = detector.reconfigure(spec, now)
      // A sample arriving with the change is the newer evidence, so it decides.
      if (feed === undefined && transition !== undefined) return transition
    }
    return feed === undefined
      ? detector.tick(now)
      : detector.sample(feed.reading, feed.replayed, now)
  }

  private recordCondition(unit: Unit, present: boolean, now: number): void {
    if (unit.present && !present) unit.clearedAt = now
    unit.present = present
  }

  // An adopted zone-limit alert whose zones are not yet readable has no
  // resolved steps; it holds the rule's first.
  private priorityAt(unit: Unit, step: number): Priority {
    return unit.steps.at(step)?.priority ?? firstPriority(this.rule)
  }

  /** A step's priority, or the alert's reached one if that is more severe. */
  private reachedAt(unit: Unit, step: number): Priority {
    const priority = this.priorityAt(unit, step)
    const reached = unit.reached
    return reached !== undefined && severityOf(reached) > severityOf(priority) ? reached : priority
  }

  private levelAt(unit: Unit, step: number): ZoneLevel | undefined {
    return unit.steps.at(step)?.level ?? (step === 0 ? zoneLimitOf(this.rule)?.level : undefined)
  }

  private raise(unit: Unit, step: number): void {
    unit.alerting = true
    unit.step = step
    unit.reached = this.reachedAt(unit, step)
    const value = unit.last?.available === true ? unit.last.value : undefined
    this.onEvent({
      type: 'raise',
      instance: unit.instance,
      priority: unit.reached,
      rule: this.rule,
      value,
      limit: stepLimit(unit, step)
    })
  }

  /**
   * A latching alert is raised again at the further step, since SKAR never
   * repeats a latching alert. Any other alert is sent at the step's priority.
   */
  private escalate(unit: Unit, step: number): void {
    if (this.rule.latching === true) {
      this.raise(unit, step)
      return
    }
    unit.step = step
    unit.reached = this.reachedAt(unit, step)
    this.onEvent({
      type: 'priority',
      instance: unit.instance,
      priority: unit.reached,
      limit: stepLimit(unit, step)
    })
  }

  private clear(unit: Unit): void {
    unit.alerting = false
    unit.step = undefined
    unit.reached = undefined
    unit.startActive = false
    unit.adoptedAlert = false
    this.onEvent({ type: 'clear', instance: unit.instance })
  }

  /** Accumulator totals to carry into a restarted rule with the same measure. */
  private totals(next: Rule): Map<string, number> {
    return carriesTotals(this.rule, next) ? this.accumulators() : new Map<string, number>()
  }
}

/**
 * A step's SI limit as a message's `{limit}` renders it: a sustained,
 * projection, slope, accumulator or count step's `limit` (a zone limit's
 * resolved threshold), or an outside step's on the side passed. A match or
 * absence step has none: the message reads its value or window from the
 * rule's step.
 */
function limitOf(unit: Unit, step: number): number | undefined {
  const spec = unit.steps.at(step)?.spec
  return (
    passedAt(unit, step)?.limit ?? (spec !== undefined && 'limit' in spec ? spec.limit : undefined)
  )
}

/**
 * A step's SI limit as events and the status report it: a sustained or
 * projection step's, or an outside step's on the side passed. Only these are
 * thresholds of the value itself; a slope's rate or a count's number of
 * events is no `limit` in an alert's data.
 */
function stepLimit(unit: Unit, step: number): number | undefined {
  return passedAt(unit, step)?.limit ?? unit.steps.at(step)?.limit
}

/**
 * An outside step's limit on the side the value last went past; undefined for
 * any other step and before the value has gone past either limit. The side is
 * the first step's detector's: its range is the narrowest, so it sees every
 * value beyond any step, including a fall past its own other limit that a
 * wider step reached earlier never sees.
 */
function passedAt(unit: Unit, step: number): { side: Side; limit: number } | undefined {
  const spec = unit.steps.at(step)?.spec
  const detector = unit.tracks.at(0)?.detector
  if (spec?.type !== 'outside' || !(detector instanceof SustainedDetector)) return undefined
  const side = detector.passed
  return side === undefined ? undefined : { side, limit: side === 'low' ? spec.low : spec.high }
}

function gateProblem(gates: readonly Gate[]): Problem | undefined {
  const at = gates.findIndex((g) => g.seen && g.issue !== undefined)
  const missing = gates[at]?.issue
  return missing === undefined ? undefined : { reason: 'missingZone', ...missing, gate: at }
}

function limitProblem(resolved: Resolved): Problem | undefined {
  return resolved.ok ? undefined : { reason: 'missingZone', ...resolved.missing }
}

/**
 * Whether only an adopted alert makes the condition present: the input has
 * not reported since start, and the condition is not the silence itself.
 */
function assumed(unit: Unit, silence: boolean): boolean {
  return unit.present && unit.last === undefined && !silence
}

/** Whether the rule's condition is its input's silence: an absence or a timeout rule. */
function judgesSilence(rule: Rule): boolean {
  const d = rule.detector
  return d.type === 'absence' || (d.type === 'match' && d.op === 'timedOut')
}

/** The total of an accumulator rule's first step, which every step shares. */
function accumulatedOf(unit: Unit): number | undefined {
  const detector = unit.tracks.at(0)?.detector
  return detector instanceof AccumulatorDetector ? detector.accumulated : undefined
}

/** The measure of an accumulator rule; undefined for any other detector. */
export function measureOf(rule: Rule): string | undefined {
  return rule.detector.type === 'accumulator' ? rule.detector.measure : undefined
}

/** Whether an edit keeps an accumulator's total: it is still an accumulator of the same measure. */
export function carriesTotals(current: Rule, next: Rule): boolean {
  const measure = measureOf(current)
  return measure !== undefined && measure === measureOf(next)
}
