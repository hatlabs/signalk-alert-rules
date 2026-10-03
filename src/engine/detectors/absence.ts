import { Stopwatch } from '../clock.js'
import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  EventWatcher,
  timerProgress,
  type DetectorOptions,
  type DetectorSpec,
  type Progress,
  type Transition
} from './detector.js'

type AbsenceSpec = Extract<DetectorSpec, { type: 'absence' }>

/**
 * Sets when no event has arrived within the window and clears on the next
 * event. The window runs from start while the input has not been seen,
 * because silence is what this detector looks for, and pauses while the input
 * is unavailable. A value seen live for the first time counts as an event, so
 * the first acknowledgement after a restart is not lost, except for an adopted
 * condition: the delta cache is empty after a server restart, so a source
 * re-sending its unchanged value would otherwise end the alert.
 */
export class AbsenceDetector extends ConditionDetector<AbsenceSpec> {
  private readonly events: EventWatcher
  private readonly timer = new Stopwatch()

  constructor(spec: AbsenceSpec, options: DetectorOptions) {
    super(spec, options)
    this.events = new EventWatcher(spec.event, !this.active)
    this.timer.start(options.start)
  }

  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined {
    const event = this.events.observe(reading, replayed)
    if (!reading.available) {
      this.timer.stop(now)
      return undefined
    }
    if (event) {
      this.refuted = true
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

  override progress(now: number): Progress | undefined {
    return this.active ? undefined : timerProgress(this.timer, 'set', this.spec.within, now)
  }

  private evaluate(now: number): Transition | undefined {
    if (this.active || this.timer.elapsed(now) < this.spec.within) return undefined
    return this.change(true)
  }
}
