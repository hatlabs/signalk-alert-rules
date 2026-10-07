import { Stopwatch } from '../clock.js'
import type { Reading, SignalValue } from '../signals.js'
import {
  ConditionDetector,
  EventWatcher,
  sameValue,
  timerProgress,
  type DetectorOptions,
  type DetectorSpec,
  type Progress,
  type Transition
} from './detector.js'

type MatchSpec = Extract<DetectorSpec, { type: 'match' }>

/**
 * `changesTo` and `decreases` are transitions and pulse. They need a baseline,
 * so a device reporting for the first time after start, such as an engine
 * controller powered on at key-on, raises nothing. The other operators are
 * states that must hold for the duration. For `timedOut` the timed-out marker
 * is the matched value rather than unavailability, and a path not seen since
 * start matches until it first reports, because the server marks only paths
 * it has seen.
 */
export class MatchDetector extends ConditionDetector<MatchSpec> {
  private readonly events: EventWatcher | undefined
  private readonly timer = new Stopwatch()
  private seen = false

  constructor(spec: MatchSpec, options: DetectorOptions) {
    super(spec, options)
    // A change to any of the step's values is the event, so the watcher
    // recognises a change and `sample` checks the value it changed to.
    this.events =
      spec.op === 'changesTo' || spec.op === 'decreases'
        ? new EventWatcher({ op: spec.op === 'changesTo' ? 'changes' : spec.op }, false)
        : undefined
    if (spec.op === 'timedOut') this.timer.start(options.start)
  }

  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined {
    if (this.events !== undefined) {
      const event = this.events.observe(reading, replayed)
      if (!reading.available) return undefined
      // An event's condition lasts a moment, so any reading shows it gone.
      this.refuted = true
      if (this.active) return this.change(false)
      return event && (this.spec.op === 'decreases' || this.isStepValue(reading.value))
        ? 'pulse'
        : undefined
    }
    if (!this.seen) {
      this.seen = true
      // Time unseen counts only toward a timeout the path never breaks.
      if (reading.available || !reading.timedOut) this.timer.reset()
    }
    const matching = this.matches(reading)
    if (matching === undefined) {
      this.timer.stop(now)
      return undefined
    }
    if (!matching) {
      this.refuted = true
      this.timer.reset()
      return this.change(false)
    }
    this.timer.start(now)
    return this.evaluate(now)
  }

  tick(now: number): Transition | undefined {
    return this.timer.running ? this.evaluate(now) : undefined
  }

  override progress(now: number): Progress | undefined {
    if (this.active || this.events !== undefined) return undefined
    return timerProgress(this.timer, this.spec.duration, now)
  }

  /** Whether the reading matches, or undefined when it can say nothing. */
  private matches(reading: Reading): boolean | undefined {
    const { op, values } = this.spec
    if (op === 'timedOut') return reading.available ? false : reading.timedOut || undefined
    if (!reading.available || values.length === 0) return undefined
    const equal = this.isStepValue(reading.value)
    return op === 'equals' ? equal : !equal
  }

  private isStepValue(value: SignalValue): boolean {
    return this.spec.values.some((v) => sameValue(value, v))
  }

  private evaluate(now: number): Transition | undefined {
    if (this.active || this.timer.elapsed(now) < (this.spec.duration ?? 0)) return undefined
    return this.change(true)
  }
}
