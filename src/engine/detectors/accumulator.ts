import type { Reading, SignalValue } from '../signals.js'
import {
  ConditionDetector,
  EventWatcher,
  sameValue,
  type DetectorOptions,
  type DetectorSpec,
  type Transition
} from './detector.js'

type AccumulatorSpec = Extract<DetectorSpec, { type: 'accumulator' }>
type StateCondition = NonNullable<AccumulatorSpec['while']>

/**
 * How long past its last sample a `while` rule keeps accumulating: the
 * server's fixed source timeout. A device that goes silent without a
 * timed-out marker, such as an engine controller losing power at idle, then
 * stops adding engine hours within a minute.
 */
export const ACCUMULATOR_HOLD_S = 60

function holds(condition: StateCondition, value: SignalValue): boolean {
  switch (condition.op) {
    case 'above':
      return typeof value === 'number' && typeof condition.value === 'number'
        ? value > condition.value
        : false
    case 'below':
      return typeof value === 'number' && typeof condition.value === 'number'
        ? value < condition.value
        : false
    case 'equals':
      return sameValue(value, condition.value)
    case 'notEquals':
      return !sameValue(value, condition.value)
  }
}

/**
 * Accumulates time, or the value integrated over time, while the input is
 * available and the `while` condition holds; a value is taken to hold until
 * the next sample. The condition is active from the limit until a reset. The
 * total is monotonic time, so time with the server off does not count. A
 * `resetOn` event needs a baseline, so a restored total survives a restart.
 */
export class AccumulatorDetector extends ConditionDetector<AccumulatorSpec> {
  private total: number
  private running = false
  private rate = 0
  private last: number
  private lastSample = -Infinity
  private readonly resetEvents: EventWatcher | undefined

  constructor(spec: AccumulatorSpec, options: DetectorOptions) {
    super(spec, options)
    this.total = options.accumulated ?? 0
    this.last = options.start
    this.resetEvents =
      spec.resetOn === undefined ? undefined : new EventWatcher(spec.resetOn, false)
  }

  /**
   * The total in seconds, or in the signal's unit times seconds for an
   * integral, as of the last sample or tick.
   */
  get accumulated(): number {
    return this.total
  }

  sample(reading: Reading, replayed: boolean, now: number): Transition | undefined {
    this.advance(now)
    this.lastSample = now
    const reset = this.resetEvents?.observe(reading, replayed) === true
    this.running = false
    if (
      reading.available &&
      (this.spec.while === undefined || holds(this.spec.while, reading.value))
    ) {
      if (this.spec.measure === 'time') {
        this.running = true
        this.rate = 1
      } else if (typeof reading.value === 'number') {
        this.running = true
        this.rate = reading.value
      }
    }
    return reset ? this.reset(now) : this.evaluate()
  }

  tick(now: number): Transition | undefined {
    this.advance(now)
    return this.evaluate()
  }

  reset(now: number): Transition | undefined {
    this.advance(now)
    this.total = 0
    return this.change(false)
  }

  private advance(now: number): void {
    const end =
      this.spec.while === undefined ? now : Math.min(now, this.lastSample + ACCUMULATOR_HOLD_S)
    if (this.running && end > this.last) this.total += this.rate * (end - this.last)
    this.last = now
  }

  private evaluate(): Transition | undefined {
    return this.active || this.total < this.spec.limit ? undefined : this.change(true)
  }
}
