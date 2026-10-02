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
import { angularUnitsMessage, timeoutValueTypeMessage } from '../model/validate.js'
import type { Clock } from './clock.js'
import {
  AccumulatorDetector,
  createDetector,
  type Detector,
  type DetectorOptions,
  type DetectorSpec,
  type Progress
} from './detectors/index.js'
import { Gate } from './gates.js'
import { resolveLimit, severerLevels, type Zone } from './limits.js'
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

export interface GateStatus {
  /** Whether the gate holds for this instance, as the rule reads it. */
  holds: boolean
  input: InputState
}

export interface InstanceStatus {
  instance?: Instance
  active: boolean
  inUse: boolean
  input: InputState
  /** The signal's current value in SI units, while it has one; a combined signal's combined value. */
  value?: SignalValue
  /**
   * A sustained or projection rule's limit in force, in SI units: the reached
   * step's while the alert is active, else the first step's.
   */
  limit?: number
  /** How far the detector is toward its next transition. */
  progress?: Progress
  /** One entry per gate of the rule, in its order. */
  gates: GateStatus[]
  /** The alert was adopted from core at start and has not cleared since. */
  adopted: boolean
  /** The furthest step an active alert has reached, an index into the rule's steps. */
  step?: number
  /** The zone level of that step, for a zone-limit rule. */
  level?: ZoneLevel
  /** The priority an active alert has now: the most severe it has reached. */
  priority?: Priority
  /** Why the rule cannot evaluate this instance. */
  inactive?: string
  /**
   * Whether the condition holds: the alert would be active were the rule
   * enabled. While the rule is out of use or unable to evaluate, the last
   * judged value is kept.
   */
  conditionPresent: boolean
  /**
   * Seconds since the condition last stopped holding; absent while it holds
   * or when it has not held since start. Being out of use neither starts nor
   * stops it.
   */
  clearedFor?: number
}

export interface RuleStatus {
  /** Conditions that do not stop the rule, such as a rejected wildcard instance. */
  issues: string[]
  /** Subscription failures, which leave the rule without its input. */
  errors: string[]
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
  inactive?: string
  present: boolean
  /** When the condition last stopped holding. */
  clearedAt?: number
}

/** A step with its limit resolved, and the detector that judges it. */
interface ResolvedStep {
  priority: Priority
  spec: DetectorSpec
  /** The SI limit of a sustained or projection step. */
  limit?: number
  /** The zone level the step comes from, for a zone-limit rule. */
  level?: ZoneLevel
}

type Resolved = { ok: true; steps: ResolvedStep[] } | { ok: false; reason: string }

// Rule fields whose change clears and restarts the rule; every other detector
// field is re-evaluated in place. Latching is one of them because a latching
// rule holds no active alert: an ongoing alert is cleared before the rule
// turns momentary, and a momentary one is raised afresh when it turns ongoing.
const STRUCTURAL: {
  [T in DetectorSpec['type']]: (keyof Extract<DetectorSpec, { type: T }>)[]
} = {
  match: ['op'],
  sustained: ['direction'],
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
// have entered, while its detector waits out the clear duration. The alert
// path is listed so that the edit preview names it: `RuleRunner.update` moves
// an alert whose path changes before an evaluator sees the edit.
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
  return !('combinator' in signal) && signal.path.split('.').includes('*')
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
    return {
      issues: [...this.issues],
      errors: [...this.errors],
      instances: [...this.units.values()].map((u) => {
        const step = u.alerting ? (u.step ?? 0) : undefined
        return {
          instance: u.instance,
          active: u.alerting,
          inUse: u.inUse,
          input: inputState(u.last),
          value: u.last?.available === true ? u.last.value : undefined,
          limit: u.steps.at(step ?? 0)?.limit,
          progress: u.tracks.at(0)?.detector?.progress(now),
          gates: this.gateStatus(u),
          adopted: u.adoptedAlert,
          step,
          level: step === undefined ? undefined : this.levelAt(u, step),
          priority: step === undefined ? undefined : this.reachedAt(u, step),
          inactive: u.inactive,
          conditionPresent: u.present,
          clearedFor: u.present || u.clearedAt === undefined ? undefined : now - u.clearedAt
        }
      })
    }
  }

  /**
   * What an instance's input evidence depends on, read without building the
   * status: the heartbeat asks for it for every active alert.
   */
  evidence(segment: string): Pick<InstanceStatus, 'input' | 'adopted'> | undefined {
    const unit = this.units.get(segment)
    return unit === undefined
      ? undefined
      : { input: inputState(unit.last), adopted: unit.adoptedAlert }
  }

  /**
   * What each active alert's emissions say after an edit applied in place:
   * the reached priority, and the limit of the step at the alert's index only
   * while that step has that priority. Otherwise it is not the step the alert
   * reached: an edit inserted one ahead of it or lowered its priority, or core
   * escalated an adopted alert by itself. Core then keeps the limit it holds
   * until the next climb, so `data.limit` only names a step that set.
   */
  revisions(): { instance?: Instance; priority: Priority; limit?: number }[] {
    return [...this.units.values()].flatMap((u) => {
      if (!u.alerting) return []
      const step = u.step ?? 0
      const priority = this.reachedAt(u, step)
      const own = u.steps.at(step)
      const limit = own?.priority === priority ? own.limit : undefined
      return [{ instance: u.instance, priority, limit }]
    })
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
        present: adopted
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
    if (sample.reading.available) unit.lastValue = sample.reading.value
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
      const gate = this.gates[i]?.get(isWildcard(model.signal) ? unit.key : '')
      return gate === undefined
        ? { holds: unit.adoptedAlert, input: 'neverSeen' }
        : { holds: this.holds(gate, unit), input: gate.input }
    })
  }

  private holds(gate: Gate, unit: Unit): boolean {
    return gate.seen ? gate.holdsFor(unit.adoptedAlert) : unit.adoptedAlert
  }

  private zones(limit: Limit, signal: Signal, instance: Instance | undefined) {
    if (limit.kind !== 'zone') return undefined
    const path = limit.path ?? ('combinator' in signal ? undefined : signal.path)
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
    const direction =
      d.type === 'sustained' ? d.direction : d.direction === 'rising' ? 'above' : 'below'
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
  private unitsProblem(): string | undefined {
    const signal = this.rule.signal
    if (!('combinator' in signal) || signal.angular !== true) return undefined
    for (const input of signal.inputs) {
      const units = this.ctx.meta(input.path)?.units
      if (units !== undefined && units !== 'rad') {
        return `${input.path}: ${angularUnitsMessage(units)}`
      }
    }
    return undefined
  }

  private timeoutProblem(unit: Unit): string | undefined {
    const d = this.rule.detector
    if (d.type !== 'match' || d.op !== 'timedOut' || 'combinator' in this.rule.signal) {
      return undefined
    }
    if (typeof unit.lastValue === 'boolean') return timeoutValueTypeMessage('boolean')
    if (typeof unit.lastValue === 'string') return timeoutValueTypeMessage('string')
    const settings = this.ctx.timeoutSettings()
    if (settings !== undefined && !settings.enforce) {
      return 'the server does not enforce data timeouts'
    }
    // Meta exists only once the path has a value; a path never seen since
    // start is the dead-at-boot case, which fires without a marker.
    if (unit.last === undefined) return undefined
    const meta = this.ctx.meta(bindPath(this.rule.signal.path, unit.instance))
    const contract = meta?.updateContract
    if (contract !== undefined && contract !== 'periodic') {
      return `the path's update contract is ${contract}, so the server never times it out`
    }
    if (typeof meta?.timeout === 'number' && meta.timeout <= 0) {
      return "the path's meta.timeout turns timing out off"
    }
    if (settings !== undefined && !settings.useDefaults && meta?.timeout === undefined) {
      return "the path has no timeout and the server's default timeouts are off"
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
      gates.find((g) => g.seen && g.issue !== undefined)?.issue ??
      (resolved.ok ? undefined : resolved.reason)
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
    this.recordCondition(unit, active, now)
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
        accumulated: (i === 0 ? undefined : accumulatedOf(unit)) ?? this.carried.get(unit.key)
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
      limit: unit.steps.at(step)?.limit
    })
  }

  /**
   * A latching alert is raised again at the further step: core holds it
   * without repeats, escalating it while it waits for acknowledgment and
   * raising a new one after. Any other alert is sent at the step's priority.
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
      limit: unit.steps.at(step)?.limit
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
