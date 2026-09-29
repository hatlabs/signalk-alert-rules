import type { SubscriptionManager } from '@signalk/server-api'
import type { Limit, Priority, Rule, Signal } from '../model/rule.js'
import type { Clock } from './clock.js'
import {
  AccumulatorDetector,
  createDetector,
  type Detector,
  type DetectorSpec
} from './detectors/index.js'
import { Gate } from './gates.js'
import { resolveLimit, type Zone } from './limits.js'
import {
  openSignal,
  type Instance,
  type Reading,
  type Sample,
  type SignalValue
} from './signals.js'

/** The parts of a path's `meta` the evaluator reads. */
export interface PathMeta {
  zones?: Zone[] | null
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
}

/** An alert core already holds for this rule, adopted at start. */
export interface Adopted {
  /** The alert path's instance segment, for a wildcard rule. */
  segment?: string
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
  | { type: 'clear'; instance?: Instance }

export interface InstanceStatus {
  instance?: Instance
  active: boolean
  inUse: boolean
  input: 'value' | 'unavailable' | 'neverSeen'
  /** The alert was adopted from core at start and has not cleared since. */
  adopted: boolean
  gateInputUnavailable: boolean
  /** Why the rule cannot evaluate this instance. */
  inactive?: string
}

export interface RuleStatus {
  issues: string[]
  instances: InstanceStatus[]
}

interface Unit {
  key: string
  instance?: Instance
  last?: Reading
  detector?: Detector
  specKey?: string
  /** Create the next detector in the condition-active state. */
  startActive: boolean
  /** The alert was adopted from core and has not cleared; never-seen gates hold for it. */
  adoptedAlert: boolean
  alerting: boolean
  limit?: number
  inUse: boolean
  inactive?: string
}

type Resolved = { ok: true; spec: DetectorSpec; limit?: number } | { ok: false; reason: string }

// Rule fields whose change clears and restarts the rule; every other detector
// field is re-evaluated in place.
const STRUCTURAL: {
  [T in DetectorSpec['type']]: (keyof Extract<DetectorSpec, { type: T }>)[]
} = {
  match: ['op', 'value'],
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

function structure(rule: Rule): string {
  const fields: readonly string[] = ['type', ...STRUCTURAL[rule.detector.type]]
  return canonical({
    signal: rule.signal,
    gates: rule.gates ?? [],
    detector: Object.fromEntries(
      Object.entries(rule.detector).filter(([key]) => fields.includes(key))
    )
  })
}

export function isWildcard(signal: Signal): boolean {
  return !('combinator' in signal) && signal.path.split('.').includes('*')
}

function bind(path: string, instance: Instance | undefined): string {
  if (instance === undefined) return path
  return path
    .split('.')
    .map((s) => (s === '*' ? instance.name : s))
    .join('.')
}

/**
 * Evaluates one rule on the self vessel: its signal per instance through a
 * detector, its gates and zone limits. It reports raises and clears; what
 * happens to the alert after that is core's lifecycle, not the evaluator's. A rule is in
 * use only while every gate holds. Out of use, a detector is dropped and
 * started afresh when the rule comes back into use, fed the last reading, so
 * durations count from then; an accumulator keeps its total and only its
 * alert is held back.
 */
export class RuleEvaluator {
  private readonly units = new Map<string, Unit>()
  private gates: Map<string, Gate>[] = []
  private closers: (() => void)[] = []
  private readonly issues = new Set<string>()
  private adopted: Set<string>
  private carried = new Map<string, number>()
  private running = false

  constructor(
    private rule: Rule,
    private readonly ctx: EvaluatorContext,
    private readonly onEvent: (event: RuleEvent) => void,
    adopted: readonly Adopted[] = []
  ) {
    this.adopted = new Set(adopted.map((a) => a.segment ?? ''))
  }

  start(): void {
    const now = this.ctx.clock()
    this.running = true
    const gates = this.rule.gates ?? []
    this.gates = gates.map(() => new Map<string, Gate>())
    for (const key of this.adopted) {
      this.unit(key, key === '' ? undefined : { name: key, segment: key })
    }
    if (!isWildcard(this.rule.signal)) this.unit('')
    const handlers = (onSample: (s: Sample) => void) => ({
      onSample,
      onIssue: (message: string) => {
        this.issues.add(message)
      },
      onError: (err: unknown) => {
        this.issues.add(err instanceof Error ? err.message : String(err))
      }
    })
    gates.forEach((gate, i) => {
      this.closers.push(
        openSignal(
          gate.signal,
          this.ctx.subscriptions,
          handlers((s) => {
            this.onGate(i, s)
          })
        )
      )
    })
    this.closers.push(
      openSignal(
        this.rule.signal,
        this.ctx.subscriptions,
        handlers((s) => {
          this.onSignal(s)
        })
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

  /** Applies an edited rule per the edit semantics. */
  update(rule: Rule): void {
    // A stopped evaluator must not clear: stop means the plugin is going away.
    if (!this.running) {
      this.rule = rule
      this.units.clear()
      return
    }
    const now = this.ctx.clock()
    if (structure(rule) !== structure(this.rule)) {
      this.carried = this.totals(rule)
      this.remove()
      this.rule = rule
      this.adopted = new Set()
      this.units.clear()
      this.issues.clear()
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

  /** Clears the rule's alerts and stops, for a deleted rule. */
  remove(): void {
    for (const unit of this.units.values()) if (unit.alerting) this.clear(unit)
    this.stop()
  }

  status(): RuleStatus {
    return {
      issues: [...this.issues],
      instances: [...this.units.values()].map((u) => ({
        instance: u.instance,
        active: u.alerting,
        inUse: u.inUse,
        input: u.last === undefined ? 'neverSeen' : u.last.available ? 'value' : 'unavailable',
        adopted: u.adoptedAlert,
        gateInputUnavailable: this.existingGatesOf(u).some((g) => g.inputUnavailable),
        inactive: u.inactive
      }))
    }
  }

  private unit(key: string, instance?: Instance): Unit {
    let unit = this.units.get(key)
    if (unit === undefined) {
      const adopted = this.adopted.has(key)
      unit = {
        key,
        instance,
        startActive: adopted,
        adoptedAlert: adopted,
        alerting: adopted,
        inUse: false
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
      gate = new Gate(
        model,
        () => this.zones(model.limit, model.signal, this.units.get(k)?.instance ?? instance),
        this.ctx.clock()
      )
      byKey.set(k, gate)
    }
    return gate
  }

  private gatesOf(unit: Unit): Gate[] {
    return (this.rule.gates ?? []).map((_, i) => this.gate(i, unit.key, unit.instance))
  }

  private existingGatesOf(unit: Unit): Gate[] {
    return (this.rule.gates ?? []).flatMap((model, i) => {
      const gate = this.gates[i]?.get(isWildcard(model.signal) ? unit.key : '')
      return gate === undefined ? [] : [gate]
    })
  }

  private zones(limit: Limit, signal: Signal, instance: Instance | undefined) {
    if (limit.kind !== 'zone') return undefined
    const path = limit.path ?? ('combinator' in signal ? undefined : signal.path)
    return path === undefined ? undefined : this.ctx.meta(bind(path, instance))?.zones
  }

  private resolve(unit: Unit): Resolved {
    const d = this.rule.detector
    if (d.type !== 'sustained' && d.type !== 'projection') return { ok: true, spec: d }
    const direction =
      d.type === 'sustained' ? d.direction : d.direction === 'rising' ? 'above' : 'below'
    const resolved = resolveLimit(
      d.limit,
      direction,
      this.zones(d.limit, this.rule.signal, unit.instance)
    )
    if (!resolved.ok) return resolved
    return { ok: true, spec: { ...d, limit: resolved.value }, limit: resolved.value }
  }

  private timeoutProblem(unit: Unit): string | undefined {
    const d = this.rule.detector
    if (d.type !== 'match' || d.op !== 'timedOut' || 'combinator' in this.rule.signal) {
      return undefined
    }
    const settings = this.ctx.timeoutSettings()
    if (settings !== undefined && !settings.enforce) {
      return 'the server does not enforce data timeouts'
    }
    // Meta exists only once the path has a value; a path never seen since
    // start is the dead-at-boot case, which fires without a marker.
    if (unit.last === undefined) return undefined
    const meta = this.ctx.meta(bind(this.rule.signal.path, unit.instance))
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
    const resolved = this.resolve(unit)
    // Zones are readable only once the path has a value; until then hold.
    if (!resolved.ok && unit.last === undefined) return
    const gates = this.gatesOf(unit)
    const problem =
      this.timeoutProblem(unit) ??
      gates.find((g) => g.seen && g.issue !== undefined)?.issue ??
      (resolved.ok ? undefined : resolved.reason)
    unit.inactive = problem

    const gatesHold = gates.every((g) =>
      g.seen ? g.holdsFor(unit.adoptedAlert) : unit.adoptedAlert
    )
    if (problem !== undefined || !gatesHold || !resolved.ok) {
      unit.inUse = false
      if (resolved.ok && resolved.spec.type === 'accumulator') {
        this.drive(unit, resolved, now, feed)
      } else {
        unit.detector = undefined
      }
      if (unit.alerting) this.clear(unit)
      return
    }
    unit.inUse = true
    unit.limit = resolved.limit
    const transition = this.drive(unit, resolved, now, feed)
    const detector = unit.detector
    if (detector === undefined) return
    if (transition === 'pulse') {
      if (!unit.alerting) {
        this.raise(unit)
        this.clear(unit)
      }
      return
    }
    if (detector.active && !unit.alerting) this.raise(unit)
    else if (!detector.active && unit.alerting) this.clear(unit)
  }

  /** Creates, reconfigures and feeds the unit's detector, and returns its transition. */
  private drive(unit: Unit, resolved: Extract<Resolved, { ok: true }>, now: number, feed?: Sample) {
    const specKey = canonical(resolved.spec)
    let detector = unit.detector
    if (detector === undefined) {
      detector = createDetector(resolved.spec, {
        start: now,
        active: unit.startActive,
        accumulated: this.carried.get(unit.key)
      })
      unit.startActive = false
      unit.detector = detector
      unit.specKey = specKey
      if (feed === undefined && unit.last !== undefined) detector.sample(unit.last, true, now)
    } else if (unit.specKey !== specKey) {
      unit.specKey = specKey
      const transition = detector.reconfigure(resolved.spec, now)
      // A sample arriving with the change is the newer evidence, so it decides.
      if (feed === undefined && transition !== undefined) return transition
    }
    return feed === undefined
      ? detector.tick(now)
      : detector.sample(feed.reading, feed.replayed, now)
  }

  private raise(unit: Unit): void {
    unit.alerting = true
    const value = unit.last?.available === true ? unit.last.value : undefined
    this.onEvent({
      type: 'raise',
      instance: unit.instance,
      priority: this.rule.priority,
      rule: this.rule,
      value,
      limit: unit.limit
    })
  }

  private clear(unit: Unit): void {
    unit.alerting = false
    unit.startActive = false
    unit.adoptedAlert = false
    this.onEvent({ type: 'clear', instance: unit.instance })
  }

  /** Accumulator totals to carry into a restarted rule with the same measure. */
  private totals(next: Rule): Map<string, number> {
    const current = this.rule.detector
    const edited = next.detector
    const carried = new Map<string, number>()
    if (
      current.type !== 'accumulator' ||
      edited.type !== 'accumulator' ||
      current.measure !== edited.measure
    ) {
      return carried
    }
    for (const unit of this.units.values()) {
      if (unit.detector instanceof AccumulatorDetector) {
        carried.set(unit.key, unit.detector.accumulated)
      }
    }
    return carried
  }
}
