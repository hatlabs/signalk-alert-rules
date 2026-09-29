import { Stopwatch } from '../clock.js'
import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  EventWatcher,
  sameValue,
  type DetectorOptions,
  type DetectorSpec,
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
export class MatchDetector extends ConditionDetector {
  private readonly events: EventWatcher | undefined
  private readonly timer = new Stopwatch()
  private seen = false

  constructor(
    private readonly spec: MatchSpec,
    options: DetectorOptions
  ) {
    super(options)
    this.events =
      spec.op === 'changesTo' || spec.op === 'decreases'
        ? new EventWatcher({ op: spec.op, value: spec.value }, false)
        : undefined
    if (spec.op === 'timedOut') this.timer.start(options.start)
  }

  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined {
    if (this.events !== undefined) {
      const event = this.events.observe(reading, replayed)
      if (!reading.available) return undefined
      if (this.active) return this.change(false)
      return event ? 'pulse' : undefined
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
      this.timer.reset()
      return this.change(false)
    }
    this.timer.start(now)
    return this.evaluate(now)
  }

  tick(now: number): Transition | undefined {
    return this.timer.running ? this.evaluate(now) : undefined
  }

  /** Whether the reading matches, or undefined when it can say nothing. */
  private matches(reading: Reading): boolean | undefined {
    const { op, value } = this.spec
    if (op === 'timedOut') return reading.available ? false : reading.timedOut || undefined
    if (!reading.available || value === undefined) return undefined
    const equal = sameValue(reading.value, value)
    return op === 'equals' ? equal : !equal
  }

  private evaluate(now: number): Transition | undefined {
    if (this.active || this.timer.elapsed(now) < (this.spec.duration ?? 0)) return undefined
    return this.change(true)
  }
}
