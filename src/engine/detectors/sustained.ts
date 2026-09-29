import { Stopwatch } from '../clock.js'
import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  numeric,
  type DetectorOptions,
  type DetectorSpec,
  type Transition
} from './detector.js'

type SustainedSpec = Extract<DetectorSpec, { type: 'sustained' }>

/**
 * Sets once the value has been beyond the limit for the duration, and clears
 * once it has been back past the limit by the hysteresis margin for the clear
 * duration. The timer runs toward whichever transition is next and pauses
 * while the input is unavailable.
 */
export class SustainedDetector extends ConditionDetector {
  private readonly timer = new Stopwatch()

  constructor(
    private readonly spec: SustainedSpec,
    options: DetectorOptions
  ) {
    super(options)
  }

  sample(reading: Reading, _replayed: boolean, now: number): Transition | undefined {
    const value = numeric(reading)
    if (value === undefined) {
      this.timer.stop(now)
      return undefined
    }
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
