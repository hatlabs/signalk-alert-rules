import { Stopwatch } from '../clock.js'
import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  numeric,
  timerProgress,
  type DetectorSpec,
  type Progress,
  type Transition
} from './detector.js'

type SustainedSpec = Extract<DetectorSpec, { type: 'sustained' | 'outside' }>

/** The limit a value went past: an outside step's low or high one. */
export type Side = 'low' | 'high'

/**
 * Sets once the value has been beyond the limit for the duration, and clears
 * once it has been back past the limit by the hysteresis margin for the clear
 * duration. An outside detector has two limits: the value is beyond either,
 * and back only inside both by the margin. The timer runs toward whichever
 * transition is next and pauses while the input is unavailable.
 */
export class SustainedDetector extends ConditionDetector<SustainedSpec> {
  private readonly timer = new Stopwatch()
  private last: number | undefined
  private side: Side | undefined

  /** The side the value was last found beyond, kept while it is back inside. */
  get passed(): Side | undefined {
    return this.side
  }

  sample(reading: Reading, _replayed: boolean, now: number): Transition | undefined {
    const value = numeric(reading)
    this.last = value
    if (value === undefined) {
      this.timer.stop(now)
      return undefined
    }
    return this.follow(value, now)
  }

  override reconfigure(spec: DetectorSpec, now: number): Transition | undefined {
    this.replaceSpec(spec)
    // The value is checked against the new limit before any timer counts, so
    // a timer the old limit started cannot fire on a value the new one rejects.
    return this.last === undefined ? this.tick(now) : this.follow(this.last, now)
  }

  private follow(value: number, now: number): Transition | undefined {
    const beyond = this.beyond(value)
    if (beyond !== undefined) this.side = beyond
    // A value inside the recovery margin is no evidence either way.
    if (this.cleared(value)) this.refuted = true
    // A jump from one side to the other is still beyond, so the timer runs on.
    const toward = this.active ? this.cleared(value) : beyond !== undefined
    if (!toward) {
      this.timer.reset()
      return undefined
    }
    this.timer.start(now)
    return this.evaluate(now)
  }

  tick(now: number): Transition | undefined {
    return this.timer.running ? this.evaluate(now) : undefined
  }

  override progress(now: number): Progress | undefined {
    return this.active
      ? timerProgress(this.timer, 'clear', this.spec.clearDuration, now)
      : timerProgress(this.timer, 'set', this.spec.duration, now)
  }

  private beyond(value: number): Side | undefined {
    const spec = this.spec
    switch (spec.type) {
      case 'outside':
        return value < spec.low ? 'low' : value > spec.high ? 'high' : undefined
      case 'sustained':
        if (spec.direction === 'above') return value > spec.limit ? 'high' : undefined
        return value < spec.limit ? 'low' : undefined
    }
  }

  private cleared(value: number): boolean {
    const spec = this.spec
    const margin = spec.hysteresis ?? 0
    switch (spec.type) {
      case 'outside':
        return value >= spec.low + margin && value <= spec.high - margin
      case 'sustained':
        return spec.direction === 'above'
          ? value <= spec.limit - margin
          : value >= spec.limit + margin
    }
  }

  private evaluate(now: number): Transition | undefined {
    const needed = (this.active ? this.spec.clearDuration : this.spec.duration) ?? 0
    if (this.timer.elapsed(now) < needed) return undefined
    this.timer.reset()
    return this.change(!this.active)
  }
}
