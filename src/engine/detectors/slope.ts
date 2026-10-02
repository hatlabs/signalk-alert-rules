import type { Reading } from '../signals.js'
import {
  ConditionDetector,
  numeric,
  type DetectorOptions,
  type DetectorSpec,
  type Transition
} from './detector.js'
import { TrendWindow, type Trend } from './trend.js'

type TrendSpec = Extract<DetectorSpec, { type: 'slope' | 'projection' }>

/**
 * A detector over the trend of a window of samples. It decides nothing until
 * a full window of available time is known, and holds its state while the
 * input is unavailable.
 */
abstract class TrendDetector<S extends TrendSpec> extends ConditionDetector<S> {
  private available = false
  private readonly samples: TrendWindow

  constructor(spec: S, options: DetectorOptions) {
    super(spec, options)
    this.samples = new TrendWindow(spec.window)
  }

  override reconfigure(spec: DetectorSpec, now: number): Transition | undefined {
    if (spec.type === 'slope' || spec.type === 'projection') this.samples.resize(spec.window)
    return super.reconfigure(spec, now)
  }

  sample(reading: Reading, _replayed: boolean, now: number): Transition | undefined {
    const value = numeric(reading)
    this.available = value !== undefined
    if (value === undefined) {
      this.samples.addGap(now)
      return undefined
    }
    this.samples.add(now, value)
    return this.evaluate(now)
  }

  tick(now: number): Transition | undefined {
    return this.available ? this.evaluate(now) : undefined
  }

  protected abstract condition(trend: Trend): boolean

  /** Whether the trend shows the condition does not hold, whatever state the detector is in. */
  protected refutes(trend: Trend): boolean {
    return !this.condition(trend)
  }

  private evaluate(now: number): Transition | undefined {
    const trend = this.samples.trend(now)
    if (trend === undefined) return undefined
    if (this.refutes(trend)) this.refuted = true
    return this.change(this.condition(trend))
  }
}

/** The value changes faster than the limit, in the given direction. */
export class SlopeDetector extends TrendDetector<Extract<TrendSpec, { type: 'slope' }>> {
  protected condition({ slope }: Trend): boolean {
    return (this.spec.direction === 'rising' ? slope : -slope) > this.spec.limit
  }
}

/**
 * At the current trend, the value reaches the limit within the horizon. Setting
 * needs the trend to point toward the limit, so a flat value never sets. Once
 * set, the condition holds until the projected value is back on the safe side,
 * so a noisy value already past the limit does not toggle with the sign of
 * the fitted slope.
 */
export class ProjectionDetector extends TrendDetector<Extract<TrendSpec, { type: 'projection' }>> {
  protected condition(trend: Trend): boolean {
    const { slope } = trend
    const rising = this.spec.direction === 'rising'
    const reaches = this.reaches(trend)
    const toward = rising ? slope > 0 : slope < 0
    return reaches && (toward || this.active)
  }

  // A restarted detector has not set, so its condition would reject a flat
  // value past the limit that the condition holding before still covers:
  // only a projected value back on the safe side is evidence of a clear.
  protected override refutes(trend: Trend): boolean {
    return !this.reaches(trend)
  }

  private reaches({ slope, latest }: Trend): boolean {
    const projected = latest + slope * this.spec.horizon
    return this.spec.direction === 'rising'
      ? projected >= this.spec.limit
      : projected <= this.spec.limit
  }
}
