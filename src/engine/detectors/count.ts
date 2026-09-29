import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  EventWatcher,
  type DetectorOptions,
  type DetectorSpec,
  type Transition
} from './detector.js'

type CountSpec = Extract<DetectorSpec, { type: 'count' }>

/**
 * Active while more than `limit` events fall within the sliding window. Only
 * the newest `limit + 1` event times are needed to decide that. A value seen
 * live for the first time counts, so the first pump start after a restart is
 * not lost. An adopted condition is not cleared before one full window has
 * passed since start, because the events before start are unknown. While the
 * input is unavailable the state holds; events keep ageing out of the window
 * and are accounted for on the first sample after the input returns.
 */
export class CountDetector extends ConditionDetector<CountSpec> {
  private available = false
  private times: number[] = []
  private readonly events: EventWatcher
  private readonly holdUntil: number

  constructor(spec: CountSpec, options: DetectorOptions) {
    super(spec, options)
    this.events = new EventWatcher(spec.event, true)
    this.holdUntil = this.active ? options.start + spec.window : -Infinity
  }

  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined {
    const event = this.events.observe(reading, replayed)
    this.available = reading.available
    if (!this.available) return undefined
    if (event) {
      this.times.push(now)
      if (this.times.length > this.spec.limit + 1) this.times.shift()
    }
    return this.evaluate(now)
  }

  tick(now: number): Transition | undefined {
    return this.available ? this.evaluate(now) : undefined
  }

  private evaluate(now: number): Transition | undefined {
    this.times = this.times.filter((t) => t > now - this.spec.window)
    const over = this.times.length > this.spec.limit
    if (!over && now < this.holdUntil) return undefined
    return this.change(over)
  }
}
