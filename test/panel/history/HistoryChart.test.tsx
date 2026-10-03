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
  method: 'max',
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
  answer: (q: HistoryQuery) => Promise<HistoryPoint[]> = () => Promise.resolve(series),
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
      method: 'max',
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
    expect(screen.getByRole('status').textContent).toBe('Loading history…')
  })

  it('says quietly that history is unavailable when the query fails', async () => {
    render(
      <HistoryChart
        history={fakeHistory(() => Promise.reject(new Error('timed out')))}
        spec={coolant}
      />
    )
    await settle()
    expect(screen.getByText('History unavailable.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says when nothing was recorded in the span', async () => {
    render(<HistoryChart history={fakeHistory(() => Promise.resolve([]))} spec={coolant} />)
    await settle()
    expect(screen.getByText('Nothing recorded in the last 24 hours.')).toBeTruthy()
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
      method: 'max',
      seconds: 3600,
      resolution: 30
    })
  })

  it('shows the answer to the span chosen last, not to one asked before', async () => {
    let answerDay: (points: HistoryPoint[]) => void = () => undefined
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
    answerDay(series)
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
        .mockImplementationOnce(() => Promise.resolve(series))
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
        q.resolution === 600 ? Promise.resolve(series) : new Promise(() => undefined)
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
