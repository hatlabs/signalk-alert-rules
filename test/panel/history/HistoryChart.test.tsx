// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_TIMEOUT_MS } from '../../../src/panel/api'
import { HistoryChart, type ChartSpec } from '../../../src/panel/history/HistoryChart'
import {
  httpHistorySource,
  type HistoryPoint,
  type HistoryQuery,
  type HistorySource
} from '../../../src/panel/history/historySource'
import { displayUnit } from '../../../src/panel/units'

afterEach(cleanup)

const NOW = Date.now()
const HOUR = 3_600_000

/** Coolant in kelvin, shown in °C, so a value drawn in SI would be off by 273. */
const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})

const coolant: ChartSpec = {
  path: 'propulsion.port.coolantTemperature',
  methods: ['max'],
  measure: { kind: 'absolute', unit: celsius },
  limits: [{ value: 95 }],
  side: 'above',
  verdict: true
}

const BUCKET = 600_000

/** A day of 10 min buckets at 80 °C, peaking at 90 °C ten hours ago. */
const series: HistoryPoint[] = Array.from({ length: 144 }, (_, i) => {
  const time = NOW - 24 * HOUR + i * BUCKET
  return { time, value: time === NOW - 10 * HOUR ? 363.15 : 353.15 }
})

function fakeHistory(
  answer: (q: HistoryQuery) => Promise<HistoryPoint[][]> = () => Promise.resolve([series]),
  provider = true
) {
  return {
    hasProvider: vi.fn(() => Promise.resolve(provider)),
    values: vi.fn(answer)
  } satisfies HistorySource
}

/** Lets the provider check and the query answer. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('HistoryChart', () => {
  it('draws the history and the limit in display units', async () => {
    const history = fakeHistory()
    render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Last 24 hours' })).toBeTruthy()
    const chart = screen.getByRole('img', { name: 'Last 24 hours with the limit' })
    expect(chart.querySelectorAll('polyline')).toHaveLength(1)
    expect(chart.textContent).toContain('limit 95 °C')
    expect(
      screen.getByText(/^Highest 90 °C at .+\. The rule would not have alerted\.$/)
    ).toBeTruthy()
    expect(history.values).toHaveBeenCalledWith({
      path: 'propulsion.port.coolantTemperature',
      methods: ['max'],
      seconds: 86_400,
      resolution: 600
    })
  })

  it('does not judge a projection rule whose recorded high stays below the limit', async () => {
    render(<HistoryChart history={fakeHistory()} spec={{ ...coolant, verdict: false }} />)
    await settle()
    expect(screen.getByText(/^Highest 90 °C at .+\.$/)).toBeTruthy()
    expect(screen.queryByText(/would not have alerted/)).toBeNull()
  })

  it('labels each step’s limit with its priority', async () => {
    render(
      <HistoryChart
        history={fakeHistory()}
        spec={{
          ...coolant,
          limits: [
            { value: 95, priority: 'warning' },
            { value: 105, priority: 'alarm' }
          ]
        }}
      />
    )
    await settle()
    const chart = screen.getByRole('img', { name: 'Last 24 hours with the limits' })
    expect(chart.textContent).toContain('warning 95 °C')
    expect(chart.textContent).toContain('alarm 105 °C')
  })

  it('labels a step typed before its priority by its value, and draws steps of one limit each', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      render(
        <HistoryChart
          history={fakeHistory()}
          spec={{ ...coolant, limits: [{ value: 85 }, { value: 85 }] }}
        />
      )
      await settle()
      const chart = screen.getByRole('img', { name: 'Last 24 hours with the limits' })
      expect(chart.querySelectorAll('line')).toHaveLength(2)
      expect([...chart.querySelectorAll('text')].map((t) => t.textContent)).toEqual([
        'step 85 °C',
        'step 85 °C',
        '24 h ago',
        'now'
      ])
      expect(screen.getByRole('status').textContent).toMatch(
        /^Highest 90 °C at .+\. It went above the limit\.$/
      )
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  describe('of an outside rule', () => {
    /** Coolant kept between 70 and 95 °C at warning, 65 and 100 °C at alarm. */
    const band: ChartSpec = {
      ...coolant,
      methods: ['min', 'max'],
      side: 'outside',
      limits: [
        { value: 70, priority: 'warning', bound: 'low' },
        { value: 95, priority: 'warning', bound: 'high' },
        { value: 65, priority: 'alarm', bound: 'low' },
        { value: 100, priority: 'alarm', bound: 'high' }
      ]
    }
    /** Each bucket's lowest 5 °C under its highest, with a stretch of gaps at the middle. */
    const lows = series.map((p, i) => ({
      time: p.time,
      value: i >= 70 && i < 75 ? null : (p.value ?? 0) - 5
    }))
    const highs = lows.map((p) => ({ time: p.time, value: p.value === null ? null : p.value + 5 }))

    it('asks for each bucket’s lowest and highest in one query', async () => {
      const history = fakeHistory(() => Promise.resolve([lows, highs]))
      render(<HistoryChart history={history} spec={band} />)
      await settle()
      expect(history.values).toHaveBeenCalledTimes(1)
      expect(history.values).toHaveBeenCalledWith(
        expect.objectContaining({ methods: ['min', 'max'] })
      )
    })

    it('draws both limits of each step labelled with its priority, and both lines broken at the gap', async () => {
      render(
        <HistoryChart history={fakeHistory(() => Promise.resolve([lows, highs]))} spec={band} />
      )
      await settle()
      const chart = screen.getByRole('img', { name: 'Last 24 hours with the limits' })
      expect(chart.querySelectorAll('line')).toHaveLength(4)
      for (const label of ['warning 70 °C', 'warning 95 °C', 'alarm 65 °C', 'alarm 100 °C']) {
        expect(chart.textContent).toContain(label)
      }
      expect(chart.querySelectorAll('polyline')).toHaveLength(4)
    })

    it('names both extremes, and the furthest limit passed on each side', async () => {
      const history = fakeHistory(() => Promise.resolve([lows, highs]))
      const { rerender } = render(<HistoryChart history={history} spec={band} />)
      await settle()
      expect(screen.getByRole('status').textContent).toMatch(
        /^Lowest 75 °C at .+; highest 90 °C at .+\. The rule would not have alerted\.$/
      )
      const narrow: ChartSpec = {
        ...band,
        limits: [
          { value: 76, priority: 'warning', bound: 'low' },
          { value: 85, priority: 'warning', bound: 'high' },
          { value: 70, priority: 'alarm', bound: 'low' },
          { value: 88, priority: 'alarm', bound: 'high' }
        ]
      }
      rerender(<HistoryChart history={history} spec={narrow} />)
      expect(screen.getByRole('status').textContent).toMatch(
        /^Lowest 75 °C at .+; highest 90 °C at .+\. It went below the warning limit and above the alarm limit\.$/
      )
    })

    it('asks again when a one-sided spec becomes an outside one', async () => {
      const history = fakeHistory(() => Promise.resolve([lows, highs]))
      const { rerender } = render(<HistoryChart history={history} spec={coolant} />)
      await settle()
      rerender(<HistoryChart history={history} spec={band} />)
      await settle()
      expect(history.values).toHaveBeenCalledTimes(2)
      rerender(<HistoryChart history={history} spec={{ ...band, methods: ['min', 'max'] }} />)
      await settle()
      expect(history.values).toHaveBeenCalledTimes(2)
    })
  })

  it('takes the title it is given, as the detail names the path', async () => {
    render(<HistoryChart history={fakeHistory()} spec={coolant} title="Port coolant" />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Port coolant' })).toBeTruthy()
  })

  it('shows nothing, and asks for no values, without a provider', async () => {
    const history = fakeHistory(undefined, false)
    const { container } = render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    expect(container.innerHTML).toBe('')
    expect(history.values).not.toHaveBeenCalled()
  })

  it('says it is loading while the query has not answered', async () => {
    render(
      <HistoryChart history={fakeHistory(() => new Promise(() => undefined))} spec={coolant} />
    )
    await settle()
    expect(screen.getByText('Loading history…')).toBeTruthy()
    // Only what the answer says is announced, not each wait for one.
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('says quietly that history is unavailable when the query fails', async () => {
    render(
      <HistoryChart
        history={fakeHistory(() => Promise.reject(new Error('timed out')))}
        spec={coolant}
      />
    )
    await settle()
    expect(screen.getByRole('status').textContent).toBe('History unavailable.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says when nothing was recorded in the span', async () => {
    render(<HistoryChart history={fakeHistory(() => Promise.resolve([]))} spec={coolant} />)
    await settle()
    expect(screen.getByRole('status').textContent).toBe('Nothing recorded in the last 24 hours.')
  })

  it('announces the summary of each span chosen in one status region that stays put', async () => {
    const history = fakeHistory((q) => Promise.resolve(q.seconds === 86_400 ? [series] : []))
    render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).not.toBe('assertive')
    expect(status.textContent).toMatch(/^Highest 90 °C at .+\. The rule would not have alerted\.$/)
    fireEvent.click(screen.getByRole('button', { name: '1 h' }))
    await settle()
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('Nothing recorded in the last hour.')
  })

  it('asks again with a matching resolution when the span changes', async () => {
    const history = fakeHistory()
    render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    const hour = screen.getByRole('button', { name: '1 h' })
    expect(hour.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(hour)
    await settle()
    expect(hour.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Last hour' })).toBeTruthy()
    expect(history.values).toHaveBeenLastCalledWith({
      path: 'propulsion.port.coolantTemperature',
      methods: ['max'],
      seconds: 3600,
      resolution: 30
    })
  })

  it('shows the answer to the span chosen last, not to one asked before', async () => {
    let answerDay: (points: HistoryPoint[][]) => void = () => undefined
    const history = fakeHistory((q) =>
      q.seconds === 86_400
        ? new Promise((resolve) => {
            answerDay = resolve
          })
        : Promise.resolve([])
    )
    render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '1 h' }))
    await settle()
    answerDay([series])
    await settle()
    expect(screen.getByText('Nothing recorded in the last hour.')).toBeTruthy()
  })

  it('asks for the pinned source, and again when the source changes', async () => {
    const history = fakeHistory()
    const { rerender } = render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    expect(history.values).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ source: expect.anything() as unknown })
    )
    rerender(<HistoryChart history={history} spec={{ ...coolant, source: 'can0.35' }} />)
    await settle()
    expect(history.values).toHaveBeenCalledTimes(2)
    expect(history.values).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'can0.35' }))
  })

  it('does not ask again when only the limits change', async () => {
    const history = fakeHistory()
    const { rerender } = render(<HistoryChart history={history} spec={coolant} />)
    await settle()
    rerender(<HistoryChart history={history} spec={{ ...coolant, limits: [{ value: 80 }] }} />)
    await settle()
    expect(history.values).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('img').textContent).toContain('limit 80 °C')
  })

  describe('as time passes', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('says history is unavailable when the server never answers the query', async () => {
      const fetchFn = vi.fn<typeof fetch>((input, init) =>
        input === '/signalk/v2/api/history/_providers'
          ? Promise.resolve(Response.json({ provider: { isDefault: true } }))
          : new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(init.signal?.reason as Error)
              })
            })
      )
      render(<HistoryChart history={httpHistorySource(fetchFn)} spec={coolant} />)
      await settle()
      expect(screen.getByText('Loading history…')).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
      })
      expect(screen.getByText('History unavailable.')).toBeTruthy()
    })

    it('draws in the frame of the answer, so the line stays put while the page re-renders', async () => {
      const history = fakeHistory()
      const { rerender } = render(<HistoryChart history={history} spec={coolant} />)
      await settle()
      const before = screen.getByRole('img').querySelector('polyline')?.getAttribute('points')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000)
      })
      rerender(<HistoryChart history={history} spec={{ ...coolant }} />)
      expect(screen.getByRole('img').querySelector('polyline')?.getAttribute('points')).toBe(before)
    })

    it('asks again once a bucket has passed, keeping the line while it asks', async () => {
      const history = fakeHistory()
      history.values
        .mockImplementationOnce(() => Promise.resolve([series]))
        .mockImplementation(() => new Promise(() => undefined))
      render(<HistoryChart history={history} spec={coolant} />)
      await settle()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BUCKET - 1000)
      })
      expect(history.values).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(history.values).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('img').querySelectorAll('polyline')).toHaveLength(1)
      expect(screen.queryByText('Loading history…')).toBeNull()
    })

    it('keeps the line drawn when asking again fails', async () => {
      const history = fakeHistory()
      history.values
        .mockImplementationOnce(() => Promise.resolve([series]))
        .mockImplementation(() => Promise.reject(new Error('provider restarting')))
      render(<HistoryChart history={history} spec={coolant} />)
      await settle()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BUCKET)
      })
      expect(history.values).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('img').querySelectorAll('polyline')).toHaveLength(1)
      expect(screen.queryByText('History unavailable.')).toBeNull()
    })
  })

  it('observes its width once, not again on each render, as each keystroke in the editor', async () => {
    let observers = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observers += 1
        }
        observe() {
          return undefined
        }
        disconnect() {
          return undefined
        }
      }
    )
    try {
      const history = fakeHistory()
      const { rerender } = render(<HistoryChart history={history} spec={coolant} />)
      await settle()
      rerender(<HistoryChart history={history} spec={{ ...coolant, limits: [{ value: 80 }] }} />)
      rerender(<HistoryChart history={history} spec={{ ...coolant, limits: [{ value: 81 }] }} />)
      expect(observers).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the line drawn while it asks again for a new width, as when a tablet turns', async () => {
    let resized: () => void = () => undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback
        }
        observe() {
          return undefined
        }
        disconnect() {
          return undefined
        }
      }
    )
    let width = 360
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => width)
    try {
      const history = fakeHistory((q) =>
        q.resolution === 600 ? Promise.resolve([series]) : new Promise(() => undefined)
      )
      render(<HistoryChart history={history} spec={coolant} />)
      await settle()
      width = 1440
      act(() => {
        resized()
      })
      await settle()
      expect(history.values).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: 120 }))
      expect(screen.queryByText('Loading history…')).toBeNull()
      // The kept 10 min buckets are one line still, not dots 2 min buckets apart.
      expect(screen.getByRole('img').querySelectorAll('polyline')).toHaveLength(1)
    } finally {
      clientWidth.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
