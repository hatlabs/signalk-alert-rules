import { describe, it, expect } from 'vitest'
import { MAX_WINDOW_SAMPLES, TrendWindow } from '../../../src/engine/detectors/trend.js'

describe('trend window', () => {
  it('has no trend until its samples span the window', () => {
    const w = new TrendWindow(100)
    w.add(0, 1)
    w.add(50, 2)
    expect(w.trend(99)).toBeUndefined()
    expect(w.trend(100)).toBeDefined()
  })

  it('fits a ramp sampled as steps to within the step error', () => {
    const w = new TrendWindow(100)
    for (let t = 0; t <= 200; t += 5) w.add(t, 3 + 0.25 * t)
    expect(w.trend(200)?.slope).toBeCloseTo(0.25, 2)
    expect(w.trend(200)?.latest).toBe(53)
  })

  it('bounds the slope of a single step by 1.5 times its size over the window', () => {
    const w = new TrendWindow(300)
    w.add(0, 353.15)
    w.add(1000, 353.65)
    let steepest = 0
    for (let t = 1000; t <= 1300; t += 0.1) steepest = Math.max(steepest, w.trend(t)?.slope ?? 0)
    expect(steepest).toBeLessThanOrEqual((1.5 * 0.5) / 300 + 1e-12)
  })

  it('stays bounded under dense samples', () => {
    const w = new TrendWindow(300)
    for (let i = 0; i <= 300_000; i++) w.add(i / 1000, i / 1000)
    expect(w.size).toBeLessThanOrEqual(MAX_WINDOW_SAMPLES + 2)
    expect(w.trend(300)?.slope).toBeCloseTo(1, 3)
  })

  it('leaves unavailable time out of the window', () => {
    const w = new TrendWindow(100)
    w.add(0, 1)
    w.addGap(50)
    w.add(150, 1)
    expect(w.trend(199)).toBeUndefined()
    expect(w.trend(200)?.slope).toBe(0)
  })

  it('stays bounded when the input flaps between values and gaps', () => {
    const w = new TrendWindow(300)
    for (let i = 0; i < 100_000; i++) {
      if (i % 2 === 0) w.add(i / 10, i)
      else w.addGap(i / 10)
    }
    expect(w.size).toBeLessThanOrEqual(4 * MAX_WINDOW_SAMPLES)
  })
})
