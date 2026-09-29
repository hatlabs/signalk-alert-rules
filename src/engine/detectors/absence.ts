import { Stopwatch } from '../clock.js'
import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  EventWatcher,
  type DetectorOptions,
  type DetectorSpec,
  type Transition
} from './detector.js'

type AbsenceSpec = Extract<DetectorSpec, { type: 'absence' }>

/**
 * Sets when no event has arrived within the window and clears on the next
 * event. The window runs from start while the input has not been seen,
 * because silence is what this detector looks for, and pauses while the input
 * is unavailable. A value seen live for the first time counts as an event, so
 * the first acknowledgement after a restart is not lost.
 */
export class AbsenceDetector extends ConditionDetector {
  private readonly events: EventWatcher
  private readonly timer = new Stopwatch()

  constructor(
    private readonly spec: AbsenceSpec,
    options: DetectorOptions
  ) {
    super(options)
    this.events = new EventWatcher(spec.event, true)
    this.timer.start(options.start)
  }

  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined {
    const event = this.events.observe(reading, replayed)
    if (!reading.available) {
      this.timer.stop(now)
      return undefined
    }
    if (event) {
      this.timer.reset()
      this.timer.start(now)
      return this.change(false)
    }
    this.timer.start(now)
    return this.evaluate(now)
  }

  tick(now: number): Transition | undefined {
    return this.timer.running ? this.evaluate(now) : undefined
  }

  private evaluate(now: number): Transition | undefined {
    if (this.active || this.timer.elapsed(now) < this.spec.within) return undefined
    return this.change(true)
  }
}
