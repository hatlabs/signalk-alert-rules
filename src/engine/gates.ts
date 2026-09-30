import type { Gate as GateModel } from '../model/rule.js'
import { createDetector, type Detector } from './detectors/index.js'
import { resolveLimit, type Zone } from './limits.js'
import { inputState, type InputState, type Reading } from './signals.js'

/** A gate frozen by a suppression of its input path. */
export interface Freeze {
  /** The state stored with the suppression for the gate, when it has one. */
  holds?: boolean
}

/**
 * Whether a rule is in use, as a sustained comparison on the gate's own
 * signal. An unavailable input keeps the last state, so an engine that
 * stopped before its controller went silent stays not running. An input never
 * seen since start does not hold; the evaluator makes the exception for an
 * adopted alert. The gate runs the comparison twice: once starting as not
 * holding, and once starting as holding, which is what an adopted alert
 * reads, so the alert is not dropped while the gate's duration runs and no
 * other alert gets that head start. A zone limit follows the zones on every
 * evaluation.
 *
 * While its input is suppressed the gate is frozen: it ignores time and holds
 * back its latest reading, which it applies when the freeze ends. The
 * evaluator reads the state stored with the suppression for an instance that
 * has one. A gate frozen before it has seen its input takes its first
 * reading, compared without waiting out the duration, since time does not
 * pass for it; a shared gate takes it even when some instances have a stored
 * state, because an instance without one reads the gate. When the freeze
 * ends, a gate that has not evaluated since it was created starts from the
 * stored state, or else from the state it was frozen at.
 */
export class Gate {
  private plain: Detector | undefined
  private adopted: Detector | undefined
  private last: Reading | undefined
  private problem: string | undefined
  /** The state a gate frozen before it was seen took from its first reading. */
  private pinned: boolean | undefined
  /** The state stored with the suppression that freezes the gate. */
  private held: boolean | undefined
  /** The latest reading while frozen, applied when the freeze ends. */
  private pending: Reading | undefined
  private wasFrozen = false

  constructor(
    private readonly model: GateModel,
    private readonly zones: () => readonly Zone[] | null | undefined,
    private readonly start: number,
    private readonly freeze: () => Freeze | undefined = () => undefined
  ) {}

  get seen(): boolean {
    return this.last !== undefined
  }

  /** Whether the gate holds, for an adopted alert or for any other. */
  holdsFor(adopted: boolean): boolean {
    if (this.pinned !== undefined) return this.pinned
    const comparison = adopted ? this.adopted : this.plain
    return this.seen && this.problem === undefined && comparison?.active === true
  }

  get input(): InputState {
    return inputState(this.pending ?? this.last)
  }

  /** Why the gate cannot hold, such as a zone level that is missing. */
  get issue(): string | undefined {
    return this.problem
  }

  sample(reading: Reading, replayed: boolean, now: number): void {
    if (this.frozen(now)) {
      if (!this.seen) this.pin(reading, now)
      else this.pending = reading
      return
    }
    this.apply(reading, replayed, now)
  }

  tick(now: number): void {
    if (this.frozen(now) || !this.seen || !this.configure(now)) return
    this.plain?.tick(now)
    this.adopted?.tick(now)
  }

  /** Whether the gate is frozen now; a freeze that has ended is thawed first. */
  private frozen(now: number): boolean {
    const freeze = this.freeze()
    if (freeze !== undefined) {
      this.wasFrozen = true
      if (freeze.holds !== undefined) this.held = freeze.holds
      return true
    }
    if (this.wasFrozen) this.thaw(now)
    return false
  }

  private thaw(now: number): void {
    this.wasFrozen = false
    const initial = this.held ?? this.pinned
    // An input sent only on change may not report again, so the latest
    // reading is the gate's evidence now; one that never evaluated takes
    // the reading it was frozen with.
    const reading = this.pending ?? (this.plain === undefined ? this.last : undefined)
    this.held = undefined
    this.pinned = undefined
    this.pending = undefined
    if (reading !== undefined) this.apply(reading, false, now, initial)
  }

  private pin(reading: Reading, now: number): void {
    this.last = reading
    const spec = this.spec()
    if (spec === undefined) return
    const once = createDetector({ ...spec, duration: 0 }, { start: now })
    once.sample(reading, false, now)
    this.pinned = once.active
  }

  private apply(reading: Reading, replayed: boolean, now: number, initial?: boolean): void {
    this.last = reading
    if (!this.configure(now, initial)) return
    this.plain?.sample(reading, replayed, now)
    this.adopted?.sample(reading, replayed, now)
  }

  private spec() {
    const { direction, limit, duration, hysteresis, clearDuration } = this.model
    const resolved = resolveLimit(limit, direction, this.zones())
    if (!resolved.ok) {
      this.problem = resolved.reason
      return undefined
    }
    this.problem = undefined
    return {
      type: 'sustained',
      direction,
      limit: resolved.value,
      duration,
      hysteresis,
      clearDuration
    } as const
  }

  /** Resolves the limit and creates or reconfigures the comparisons; false when it cannot resolve. */
  private configure(now: number, initial?: boolean): boolean {
    const spec = this.spec()
    if (spec === undefined) return false
    if (this.plain === undefined || this.adopted === undefined) {
      this.plain = createDetector(spec, { start: this.start, active: initial ?? false })
      this.adopted = createDetector(spec, { start: this.start, active: initial ?? true })
    } else {
      this.plain.reconfigure(spec, now)
      this.adopted.reconfigure(spec, now)
    }
    return true
  }
}
