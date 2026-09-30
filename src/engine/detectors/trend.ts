/** Sets the decimation spacing, window / MAX_WINDOW_SAMPLES; MAX_POINTS caps the points kept. */
export const MAX_WINDOW_SAMPLES = 256

// Input that alternates between values and gaps slower than the decimation
// spacing keeps a point per change; this caps it, at the cost of coverage.
const MAX_POINTS = 4 * MAX_WINDOW_SAMPLES

/** A value held from `t` until the next point; undefined marks the input unavailable. */
interface Point {
  t: number
  value: number | undefined
}

export interface Trend {
  /** Least-squares slope over the window, per second. */
  slope: number
  latest: number
}

/**
 * A signal over a sliding window of available time. Each value is taken to
 * hold until the next point, and the trend is the least-squares line through
 * that held signal, weighted by time. Fitting the held signal rather than the
 * sample points bounds the slope a single step can produce by 1.5 times the
 * step over the window, however sparse the input. Unavailable time is left
 * out, so the window reaches back past a gap instead of starting over.
 */
export class TrendWindow {
  private points: Point[] = []
  private window = 0
  private spacing = 0

  constructor(window: number) {
    this.resize(window)
  }

  /** Changes the window, keeping the points; a longer one waits until they span it. */
  resize(window: number): void {
    this.window = window
    this.spacing = window / MAX_WINDOW_SAMPLES
  }

  get size(): number {
    return this.points.length
  }

  add(t: number, value: number): void {
    const gap = this.points.at(-1)
    // A gap shorter than the decimation spacing is not worth a point.
    if (gap?.value === undefined && gap !== undefined && t - gap.t < this.spacing) {
      this.points.pop()
    }
    const last = this.points.at(-1)
    const beforeLast = this.points.at(-2)
    if (
      last?.value !== undefined &&
      beforeLast?.value !== undefined &&
      t - beforeLast.t < this.spacing
    ) {
      this.points[this.points.length - 1] = { t, value }
    } else {
      this.push({ t, value })
    }
  }

  addGap(t: number): void {
    const last = this.points.at(-1)
    if (last?.value !== undefined) this.push({ t, value: undefined })
  }

  /** The trend at `now`, or undefined while less than a window of available time is known. */
  trend(now: number): Trend | undefined {
    let need = this.window
    let end = now
    let latest: number | undefined
    // x is time relative to `now`, which keeps the sums small.
    let w = 0
    let sx = 0
    let sxx = 0
    let sy = 0
    let sxy = 0
    for (let i = this.points.length - 1; i >= 0; i--) {
      const point = this.points[i]
      const b = end
      end = point.t
      if (point.value === undefined) continue
      latest ??= point.value
      const a = Math.max(point.t, b - need)
      const x0 = a - now
      const x1 = b - now
      const width = x1 - x0
      const ix = (x1 * x1 - x0 * x0) / 2
      w += width
      sx += ix
      sxx += (x1 * x1 * x1 - x0 * x0 * x0) / 3
      sy += point.value * width
      sxy += point.value * ix
      need -= width
      if (need <= 0) {
        this.points.splice(0, i)
        return { slope: (w * sxy - sx * sy) / (w * sxx - sx * sx), latest }
      }
    }
    return undefined
  }

  private push(point: Point): void {
    this.points.push(point)
    if (this.points.length > MAX_POINTS) this.points.shift()
  }
}
