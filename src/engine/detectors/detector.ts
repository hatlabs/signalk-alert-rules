import type { Detector as DetectorModel, Event } from '../../model/rule.js'
import type { Stopwatch } from '../clock.js'
import type { Reading, SignalValue } from '../signals.js'

/**
 * A change of a detector's condition. `pulse` is a momentary condition: it
 * starts and ends at the same instant, as for a transition match.
 */
export type Transition = 'set' | 'clear' | 'pulse'

type Model<T extends DetectorModel['type']> = Omit<
  Extract<DetectorModel, { type: T }>,
  'steps' | 'limit'
>

/**
 * The detector of one step: the rule's detector with that step's limit, or an
 * outside step's low and high limits, resolved to SI values, in place of its
 * steps. A match step holds the values of that step and every later one, so
 * that like a threshold it holds for any value at or beyond it.
 */
export type DetectorSpec =
  | (Model<'match'> & { values: SignalValue[] })
  | (Model<'sustained'> & { limit: number })
  | (Model<'outside'> & { low: number; high: number })
  | (Model<'slope'> & { limit: number })
  | (Model<'projection'> & { limit: number })
  | (Model<'accumulator'> & { limit: number })
  | (Model<'count'> & { limit: number })
  | (Model<'absence'> & { within: number })

/**
 * How far a detector is toward its next transition, for status: a duration
 * timer in seconds (paused time excluded), the events in a count's window, or
 * an accumulator's total.
 */
export type Progress =
  | { kind: 'timer'; elapsed: number; target: number }
  | { kind: 'events'; count: number; limit: number }
  | { kind: 'total'; total: number; limit: number }

export interface DetectorOptions {
  /** The monotonic time the detector was created. */
  start: number
  /** Start in the condition-active state, for an alert adopted from core. */
  active?: boolean
  /** An accumulator's total restored from the store. */
  accumulated?: number
  /** Called when an accumulator's `resetOn` event zeroes its total. */
  onReset?: () => void
}

/**
 * A condition over one signal as a state machine on a monotonic clock. Time
 * moves only through `now`, so a detector never reads wall time. The caller
 * ticks it so that durations and windows can elapse between samples.
 */
export interface Detector {
  readonly active: boolean
  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined
  tick(now: number): Transition | undefined
  /**
   * Applies new parameters of the same detector type in place, keeping timers
   * and windows, and evaluates them at `now`.
   */
  reconfigure(spec: DetectorSpec, now: number): Transition | undefined
  /** How far it is toward its next transition at `now`, without changing state. */
  progress(now: number): Progress | undefined
  /**
   * Whether its state is a judgement: it is set, or since it was created it
   * has had evidence that the condition does not hold. A detector created
   * while the condition held says nothing about a clear until then.
   */
  readonly decided: boolean
}

/**
 * A duration timer's progress, or undefined while it is not timing: stopped
 * and at zero, or with nothing to wait for.
 */
export function timerProgress(
  timer: Stopwatch,
  target: number | undefined,
  now: number
): Progress | undefined {
  const elapsed = timer.elapsed(now)
  if (target === undefined || target <= 0 || (!timer.running && elapsed === 0)) return undefined
  return { kind: 'timer', elapsed, target }
}

export function sameValue(a: SignalValue, b: SignalValue): boolean {
  if (typeof a === 'object' && typeof b === 'object') {
    return a.latitude === b.latitude && a.longitude === b.longitude
  }
  return a === b
}

export function numeric(reading: Reading): number | undefined {
  return reading.available && typeof reading.value === 'number' ? reading.value : undefined
}

/**
 * Recognises events in a signal's samples. A replayed value only sets the
 * baseline, and unavailable samples leave it alone. With `firstLive`, a live
 * value with no baseline is a change from nothing, so a value appearing for
 * the first time after start counts, except as a decrease.
 */
export class EventWatcher {
  private baseline: SignalValue | undefined

  constructor(
    private readonly event: Event,
    private readonly firstLive: boolean
  ) {}

  observe(reading: Reading, replayed: boolean): boolean {
    if (!reading.available) return false
    const previous = this.baseline
    const current = reading.value
    this.baseline = current
    if (replayed) return false
    if (previous === undefined) {
      if (!this.firstLive) return false
    } else if (sameValue(previous, current)) {
      return false
    }
    switch (this.event.op) {
      case 'changes':
        return true
      case 'changesTo':
        return this.event.value !== undefined && sameValue(current, this.event.value)
      case 'decreases':
        return typeof previous === 'number' && typeof current === 'number' && current < previous
    }
  }
}

/** Holds a detector's parameters and condition, and reports the transitions of it. */
export abstract class ConditionDetector<S extends DetectorSpec> implements Detector {
  private isActive: boolean
  /** Set by a subclass on evidence that the condition does not hold. */
  protected refuted = false

  constructor(
    protected spec: S,
    options: DetectorOptions
  ) {
    this.isActive = options.active ?? false
  }

  get active(): boolean {
    return this.isActive
  }

  get decided(): boolean {
    return this.isActive || this.refuted
  }

  abstract sample(reading: Reading, replayed: boolean, now: number): Transition | undefined
  abstract tick(now: number): Transition | undefined

  progress(_now: number): Progress | undefined {
    return undefined
  }

  reconfigure(spec: DetectorSpec, now: number): Transition | undefined {
    this.replaceSpec(spec)
    return this.tick(now)
  }

  protected replaceSpec(spec: DetectorSpec): void {
    if (spec.type !== this.spec.type) {
      throw new Error(`cannot reconfigure a ${this.spec.type} detector as ${spec.type}`)
    }
    // Equal types make the variants equal.
    this.spec = spec as S
  }

  protected change(active: boolean): Transition | undefined {
    if (active === this.isActive) return undefined
    this.isActive = active
    return active ? 'set' : 'clear'
  }
}
