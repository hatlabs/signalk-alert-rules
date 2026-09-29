/**
 * Seconds on a clock that never jumps. The evaluator reads it and passes the
 * time to detectors as `now`.
 */
export type Clock = () => number

export const monotonic: Clock = () => performance.now() / 1000

/** Accumulates time across separate running intervals, so a timer can pause. */
export class Stopwatch {
  private total = 0
  private since: number | undefined

  get running(): boolean {
    return this.since !== undefined
  }

  start(now: number): void {
    this.since ??= now
  }

  stop(now: number): void {
    if (this.since === undefined) return
    this.total += now - this.since
    this.since = undefined
  }

  reset(): void {
    this.total = 0
    this.since = undefined
  }

  elapsed(now: number): number {
    return this.total + (this.since === undefined ? 0 : now - this.since)
  }
}
