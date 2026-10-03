import { describe, expect, it } from 'vitest'
import {
  AXIS_LABEL_Y,
  CHART_HEIGHT,
  chartGeometry,
  historySummary,
  LABEL_HEIGHT,
  type ChartFrame,
  type SummaryLimit
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
    const {
      lines: [lines]
    } = chartGeometry(
      [
        [
          { time: at(0), value: 13 },
          { time: at(30), value: 14 },
          { time: at(60), value: 13.5 }
        ]
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
    const {
      lines: [lines]
    } = chartGeometry(
      [
        [
          { time: at(0), value: 13 },
          { time: at(1), value: 13.1 },
          { time: at(2), value: null },
          { time: at(3), value: 13.2 },
          { time: at(4), value: 13.3 }
        ]
      ],
      [],
      frame
    )
    expect(lines).toHaveLength(2)
  })

  it('breaks the line where buckets are missing, as while nothing was recorded', () => {
    const {
      lines: [lines]
    } = chartGeometry(
      [
        [
          { time: at(0), value: 13 },
          { time: at(1), value: 13.1 },
          { time: at(40), value: 13.2 },
          { time: at(41), value: 13.3 }
        ]
      ],
      [],
      frame
    )
    expect(lines).toHaveLength(2)
  })

  it('draws a lone value between gaps as a dot rather than nothing', () => {
    const {
      lines: [lines]
    } = chartGeometry(
      [
        [
          { time: at(0), value: null },
          { time: at(1), value: 13.1 },
          { time: at(2), value: null }
        ]
      ],
      [],
      frame
    )
    expect(lines).toHaveLength(1)
    expect(xs(lines[0])).toHaveLength(2)
  })

  it('keeps a limit far from the values inside the chart', () => {
    const {
      lines: [lines],
      limits
    } = chartGeometry(
      [
        [
          { time: at(0), value: 13.4 },
          { time: at(60), value: 13.6 }
        ]
      ],
      [{ value: 12, label: 'limit 12 V', tone: 'limit' }],
      frame
    )
    expect(limits[0].y).toBeLessThan(CHART_HEIGHT)
    expect(limits[0].y).toBeGreaterThan(Math.max(...ys(lines[0])))
  })

  it('draws a flat series and its limit without dividing by zero', () => {
    const {
      lines: [lines],
      limits
    } = chartGeometry(
      [
        [
          { time: at(0), value: 13 },
          { time: at(60), value: 13 }
        ]
      ],
      [{ value: 13, label: 'limit 13 V', tone: 'limit' }],
      frame
    )
    for (const y of [...ys(lines[0]), limits[0].y]) expect(Number.isFinite(y)).toBe(true)
  })

  it('labels a limit above its line, and a second close below it so they do not overlap', () => {
    const { limits } = chartGeometry(
      [
        [
          { time: at(0), value: 14 },
          { time: at(60), value: 11 }
        ]
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

  it('labels a range’s low limit below its line and its high limit above, outside the band', () => {
    const { limits } = chartGeometry(
      [
        [
          { time: at(0), value: -20 },
          { time: at(60), value: 22 }
        ]
      ],
      [
        { value: -25, label: 'limit -25 °', tone: 'limit', bound: 'low' },
        { value: 25, label: 'limit 25 °', tone: 'limit', bound: 'high' }
      ],
      frame
    )
    const [high, low] = limits
    expect(high.labelY).toBeLessThan(high.y)
    expect(low.labelY).toBeGreaterThan(low.y)
    expect(low.labelY).toBeLessThanOrEqual(AXIS_LABEL_Y - LABEL_HEIGHT)
  })

  it('labels the lowest low limit below its line, and a second close above it so they do not overlap', () => {
    const { limits } = chartGeometry(
      [
        [
          { time: at(0), value: -10 },
          { time: at(60), value: 30 }
        ]
      ],
      [
        { value: 25, label: 'warning 25 °', tone: 'warning', bound: 'high' },
        { value: -25, label: 'warning -25 °', tone: 'warning', bound: 'low' },
        { value: -26, label: 'alarm -26 °', tone: 'alarm', bound: 'low' }
      ],
      frame
    )
    const [, warning, alarm] = limits
    expect(alarm.labelY).toBeGreaterThan(alarm.y)
    expect(warning.labelY).toBeLessThan(warning.y)
    expect(warning.labelY).toBeLessThanOrEqual((alarm.labelY ?? Number.NaN) - LABEL_HEIGHT)
  })

  it('leaves out a low label that fits neither side of its line between the high labels', () => {
    const { limits } = chartGeometry(
      [
        [
          { time: at(0), value: -30 },
          { time: at(60), value: 100 }
        ]
      ],
      [
        { value: 25, label: 'warning 25 °', tone: 'warning', bound: 'high' },
        { value: 35, label: 'alarm 35 °', tone: 'alarm', bound: 'high' },
        { value: -25, label: 'warning -25 °', tone: 'warning', bound: 'low' },
        { value: -35, label: 'alarm -35 °', tone: 'alarm', bound: 'low' }
      ],
      frame
    )
    const shown = limits.flatMap((l) => (l.labelY === undefined ? [] : [l.labelY]))
    const sorted = [...shown].sort((a, b) => a - b)
    sorted.slice(1).forEach((labelY, i) => {
      expect(labelY - LABEL_HEIGHT).toBeGreaterThanOrEqual(sorted[i])
    })
    expect(limits).toHaveLength(4)
  })

  it('draws nothing without values', () => {
    const geometry = chartGeometry([[{ time: at(0), value: null }]], [], frame)
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

  /** A rule on the recorded value itself, as a sustained rule is. */
  const sustained = (side: 'below' | 'above', limits: SummaryLimit[]) => ({
    side,
    limits,
    verdict: true
  })

  it('names the lowest value and when, and that a low limit was never passed', () => {
    expect(historySummary({ min: series }, sustained('below', [{ value: 12.8 }]), words)).toBe(
      'Lowest 13.02 V at 20 min. The rule would not have alerted.'
    )
  })

  it('says a single limit was passed, without claiming the duration held', () => {
    expect(historySummary({ min: series }, sustained('below', [{ value: 13.1 }]), words)).toBe(
      'Lowest 13.02 V at 20 min. It went below the limit.'
    )
  })

  it('names the furthest step passed', () => {
    const steps = [
      { value: 13.5, priority: 'warning' },
      { value: 13.1, priority: 'alarm' },
      { value: 12, priority: 'emergency' }
    ]
    expect(historySummary({ min: series }, sustained('below', steps), words)).toBe(
      'Lowest 13.02 V at 20 min. It went below the alarm limit.'
    )
  })

  it('names the highest value for a high limit', () => {
    expect(historySummary({ max: series }, sustained('above', [{ value: 15 }]), words)).toBe(
      'Highest 14.10 V at 60 min. The rule would not have alerted.'
    )
  })

  it('reads an averaged series, as a slope chart asks for', () => {
    expect(historySummary({ average: series }, sustained('above', [{ value: 15 }]), words)).toBe(
      'Highest 14.10 V at 60 min. The rule would not have alerted.'
    )
    expect(historySummary({ average: series }, sustained('below', [{ value: 13.1 }]), words)).toBe(
      'Lowest 13.02 V at 20 min. It went below the limit.'
    )
  })

  it('does not say a projection would not have alerted, as it alerts on a value ahead', () => {
    const projection = { side: 'below' as const, verdict: false }
    expect(
      historySummary({ min: series }, { ...projection, limits: [{ value: 12.8 }] }, words)
    ).toBe('Lowest 13.02 V at 20 min.')
    expect(
      historySummary({ min: series }, { ...projection, limits: [{ value: 13.1 }] }, words)
    ).toBe('Lowest 13.02 V at 20 min. It went below the limit.')
  })

  it('names only the value while there is no limit to compare with', () => {
    expect(historySummary({ min: series }, sustained('below', []), words)).toBe(
      'Lowest 13.02 V at 20 min.'
    )
  })

  it('says nothing without values', () => {
    expect(
      historySummary({ min: [{ time: at(0), value: null }] }, sustained('below', []), words)
    ).toBeUndefined()
  })
})

describe('an outside rule’s history', () => {
  const words = {
    value: (v: number) => `${String(v)} °`,
    time: (ms: number) => `${String(Math.round((ms - FROM) / MINUTE))} min`
  }
  /** Each bucket's lowest and highest heel; the line is broken at 20 min in both. */
  const range = (lowest: number, highest: number) => ({
    min: [
      { time: at(0), value: -3 },
      { time: at(10), value: lowest },
      { time: at(20), value: null },
      { time: at(30), value: -1 }
    ],
    max: [
      { time: at(0), value: 4 },
      { time: at(10), value: 5 },
      { time: at(20), value: null },
      { time: at(30), value: highest }
    ]
  })
  const steps: SummaryLimit[] = [
    { value: -25, priority: 'warning', bound: 'low' },
    { value: 25, priority: 'warning', bound: 'high' },
    { value: -35, priority: 'alarm', bound: 'low' },
    { value: 35, priority: 'alarm', bound: 'high' }
  ]
  const outside = (limits: SummaryLimit[]) => ({ side: 'outside' as const, limits, verdict: true })

  it('names the lowest and highest values and that the range was never left', () => {
    expect(historySummary(range(-20, 22), outside(steps), words)).toBe(
      'Lowest -20 ° at 10 min; highest 22 ° at 30 min. The rule would not have alerted.'
    )
  })

  it('names the low limit passed', () => {
    expect(historySummary(range(-27, 22), outside(steps.slice(0, 2)), words)).toBe(
      'Lowest -27 ° at 10 min; highest 22 ° at 30 min. It went below the warning limit.'
    )
  })

  it('names the furthest limit passed on each side', () => {
    expect(historySummary(range(-27, 36), outside(steps), words)).toBe(
      'Lowest -27 ° at 10 min; highest 36 ° at 30 min. It went below the warning limit and above the alarm limit.'
    )
  })

  it('names a step once when the value left its range on both sides', () => {
    expect(historySummary(range(-27, 26), outside(steps), words)).toBe(
      'Lowest -27 ° at 10 min; highest 26 ° at 30 min. It went below and above the warning limit.'
    )
  })

  it('names only the extremes while there is no limit to compare with', () => {
    expect(historySummary(range(-27, 36), outside([]), words)).toBe(
      'Lowest -27 ° at 10 min; highest 36 ° at 30 min.'
    )
  })

  it('breaks both lines at a gap, and draws both limits of each step', () => {
    const limits = steps.map((l) => ({ value: l.value, label: '', tone: l.priority ?? '' }))
    const { min, max } = range(-27, 36)
    const geometry = chartGeometry([min, max], limits, { ...frame, resolution: 600 })
    expect(geometry.lines.map((runs) => runs.length)).toEqual([2, 2])
    expect(geometry.limits).toHaveLength(4)
  })
})
