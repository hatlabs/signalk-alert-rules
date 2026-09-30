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

type SustainedSpec = Extract<DetectorSpec, { type: 'sustained' }>

/**
 * Sets once the value has been beyond the limit for the duration, and clears
 * once it has been back past the limit by the hysteresis margin for the clear
 * duration. The timer runs toward whichever transition is next and pauses
 * while the input is unavailable.
 */
export class SustainedDetector extends ConditionDetector<SustainedSpec> {
  private readonly timer = new Stopwatch()
  private last: number | undefined

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
    const toward = this.active ? this.cleared(value) : this.beyond(value)
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

  private beyond(value: number): boolean {
    return this.spec.direction === 'above' ? value > this.spec.limit : value < this.spec.limit
  }

  private cleared(value: number): boolean {
    const margin = this.spec.hysteresis ?? 0
    return this.spec.direction === 'above'
      ? value <= this.spec.limit - margin
      : value >= this.spec.limit + margin
  }

  private evaluate(now: number): Transition | undefined {
    const needed = (this.active ? this.spec.clearDuration : this.spec.duration) ?? 0
    if (this.timer.elapsed(now) < needed) return undefined
    this.timer.reset()
    return this.change(!this.active)
  }
}
