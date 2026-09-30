import type { Gate as GateModel } from '../model/rule.js'
import { createDetector, type Detector } from './detectors/index.js'
import { resolveLimit, type Zone } from './limits.js'
import { inputState, type InputState, type Reading } from './signals.js'

/**
 * Whether a rule is in use, as a sustained comparison on the gate's own
 * signal. An unavailable input keeps the last state, so an engine that
 * stopped before its controller went silent stays not running. An input never
 * seen since start does not hold; the evaluator makes the exception for an
 * adopted alert. The gate runs the comparison twice: once starting as not
 * holding, and once starting as holding, which is what an adopted alert
 * reads, so the alert is not dropped while the gate's duration runs and no
 * other alert gets that head start. A zone limit follows the zones on every
 * evaluation. While its input is suppressed the gate is frozen: it ignores
 * samples and time, so it keeps the state it last evaluated.
 */
export class Gate {
  private plain: Detector | undefined
  private adopted: Detector | undefined
  private last: Reading | undefined
  private problem: string | undefined

  constructor(
    private readonly model: GateModel,
    private readonly zones: () => readonly Zone[] | null | undefined,
    private readonly start: number,
    private readonly frozen: () => boolean = () => false
  ) {}

  get seen(): boolean {
    return this.last !== undefined
  }

  /** Whether the gate holds, for an adopted alert or for any other. */
  holdsFor(adopted: boolean): boolean {
    const comparison = adopted ? this.adopted : this.plain
    return this.seen && this.problem === undefined && comparison?.active === true
  }

  get input(): InputState {
    return inputState(this.last)
  }

  /** Why the gate cannot hold, such as a zone level that is missing. */
  get issue(): string | undefined {
    return this.problem
  }

  sample(reading: Reading, replayed: boolean, now: number): void {
    if (this.frozen()) return
    this.last = reading
    if (!this.configure(now)) return
    this.plain?.sample(reading, replayed, now)
    this.adopted?.sample(reading, replayed, now)
  }

  tick(now: number): void {
    if (!this.seen || this.frozen() || !this.configure(now)) return
    this.plain?.tick(now)
    this.adopted?.tick(now)
  }

  private configure(now: number): boolean {
    const { direction, limit, duration, hysteresis, clearDuration } = this.model
    const resolved = resolveLimit(limit, direction, this.zones())
    if (!resolved.ok) {
      this.problem = resolved.reason
      return false
    }
    this.problem = undefined
    const spec = {
      type: 'sustained',
      direction,
      limit: resolved.value,
      duration,
      hysteresis,
      clearDuration
    } as const
    if (this.plain === undefined || this.adopted === undefined) {
      this.plain = createDetector(spec, { start: this.start })
      this.adopted = createDetector(spec, { start: this.start, active: true })
    } else {
      this.plain.reconfigure(spec, now)
      this.adopted.reconfigure(spec, now)
    }
    return true
  }
}
