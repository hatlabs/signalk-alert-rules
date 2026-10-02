import { describe, expect, it } from 'vitest'
import {
  CHART_HEIGHT,
  chartGeometry,
  historySummary,
  type ChartFrame
} from '../../../src/panel/history/chart'

const FROM = Date.parse('2026-09-30T00:00:00.000Z')
const MINUTE = 60_000
const at = (minutes: number) => FROM + minutes * MINUTE
const frame: ChartFrame = { from: FROM, to: at(60), width: 360, resolution: 60 }

/** The y of each vertex of a polyline's points attribute. */
const ys = (line: string) => line.split(' ').map((p) => Number(p.split(',')[1]))
const xs = (line: string) => line.split(' ').map((p) => Number(p.split(',')[0]))

describe('chartGeometry', () => {
  it('spans the width with the time and puts higher values higher', () => {
    const { lines } = chartGeometry(
      [
        { time: at(0), value: 13 },
        { time: at(30), value: 14 },
        { time: at(60), value: 13.5 }
      ],
      [],
      { ...frame, resolution: 1800 }
    )
    expect(lines).toHaveLength(1)
    expect(xs(lines[0])).toEqual([0, 180, 360])
    const [first, high, last] = ys(lines[0])
    expect(high).toBeLessThan(last)
    expect(last).toBeLessThan(first)
    for (const y of ys(lines[0])) {
      expect(y).toBeGreaterThan(0)
      expect(y).toBeLessThan(CHART_HEIGHT)
    }
  })

  it('breaks the line at a bucket without a value', () => {
    const { lines } = chartGeometry(
      [
        { time: at(0), value: 13 },
        { time: at(1), value: 13.1 },
        { time: at(2), value: null },
        { time: at(3), value: 13.2 },
        { time: at(4), value: 13.3 }
      ],
      [],
      frame
    )
    expect(lines).toHaveLength(2)
  })

  it('breaks the line where buckets are missing, as while nothing was recorded', () => {
    const { lines } = chartGeometry(
      [
        { time: at(0), value: 13 },
        { time: at(1), value: 13.1 },
        { time: at(40), value: 13.2 },
        { time: at(41), value: 13.3 }
      ],
      [],
      frame
    )
    expect(lines).toHaveLength(2)
  })

  it('draws a lone value between gaps as a dot rather than nothing', () => {
    const { lines } = chartGeometry(
      [
        { time: at(0), value: null },
        { time: at(1), value: 13.1 },
        { time: at(2), value: null }
      ],
      [],
      frame
    )
    expect(lines).toHaveLength(1)
    expect(xs(lines[0])).toHaveLength(2)
  })

  it('keeps a limit far from the values inside the chart', () => {
    const { lines, limits } = chartGeometry(
      [
        { time: at(0), value: 13.4 },
        { time: at(60), value: 13.6 }
      ],
      [{ value: 12, label: 'limit 12 V', tone: 'limit' }],
      frame
    )
    expect(limits[0].y).toBeLessThan(CHART_HEIGHT)
    expect(limits[0].y).toBeGreaterThan(Math.max(...ys(lines[0])))
  })

  it('draws a flat series and its limit without dividing by zero', () => {
    const { lines, limits } = chartGeometry(
      [
        { time: at(0), value: 13 },
        { time: at(60), value: 13 }
      ],
      [{ value: 13, label: 'limit 13 V', tone: 'limit' }],
      frame
    )
    for (const y of [...ys(lines[0]), limits[0].y]) expect(Number.isFinite(y)).toBe(true)
  })

  it('labels a limit above its line, and a second close below it so they do not overlap', () => {
    const { limits } = chartGeometry(
      [
        { time: at(0), value: 14 },
        { time: at(60), value: 11 }
      ],
      [
        { value: 12.2, label: 'warning 12.2 V', tone: 'warning' },
        { value: 11.8, label: 'alarm 11.8 V', tone: 'alarm' }
      ],
      frame
    )
    const [warning, alarm] = limits
    expect(warning.labelY).toBeLessThan(warning.y)
    expect(alarm.labelY).toBeGreaterThan(alarm.y)
  })

  it('draws nothing without values', () => {
    const geometry = chartGeometry([{ time: at(0), value: null }], [], frame)
    expect(geometry.lines).toEqual([])
    expect(geometry.limits).toEqual([])
  })
})

describe('historySummary', () => {
  const words = {
    value: (v: number) => `${v.toFixed(2)} V`,
    time: (ms: number) => `${String(Math.round((ms - FROM) / MINUTE))} min`
  }
  const series = [
    { time: at(0), value: 13.4 },
    { time: at(20), value: 13.02 },
    { time: at(40), value: null },
    { time: at(50), value: 13.02 },
    { time: at(60), value: 14.1 }
  ]

  it('names the lowest value and when, and that a low limit was never passed', () => {
    expect(historySummary(series, 'below', [{ value: 12.8 }], words)).toBe(
      'Lowest 13.02 V at 20 min. The rule would not have alerted.'
    )
  })

  it('says a single limit was passed, without claiming the duration held', () => {
    expect(historySummary(series, 'below', [{ value: 13.1 }], words)).toBe(
      'Lowest 13.02 V at 20 min. It went below the limit.'
    )
  })

  it('names the furthest step passed', () => {
    const steps = [
      { value: 13.5, priority: 'warning' },
      { value: 13.1, priority: 'alarm' },
      { value: 12, priority: 'emergency' }
    ]
    expect(historySummary(series, 'below', steps, words)).toBe(
      'Lowest 13.02 V at 20 min. It went below the alarm limit.'
    )
  })

  it('names the highest value for a high limit', () => {
    expect(historySummary(series, 'above', [{ value: 15 }], words)).toBe(
      'Highest 14.10 V at 60 min. The rule would not have alerted.'
    )
  })

  it('names only the value while there is no limit to compare with', () => {
    expect(historySummary(series, 'below', [], words)).toBe('Lowest 13.02 V at 20 min.')
  })

  it('says nothing without values', () => {
    expect(historySummary([{ time: at(0), value: null }], 'below', [], words)).toBeUndefined()
  })
})
