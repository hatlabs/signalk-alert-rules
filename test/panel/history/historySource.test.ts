import { describe, expect, it, vi } from 'vitest'
import {
  httpHistorySource,
  parseValues,
  resolutionFor,
  SPANS
} from '../../../src/panel/history/historySource'

const PROVIDERS = '/signalk/v2/api/history/_providers'

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** A fetch that answers the providers route and any values query from the tables given. */
function fakeFetch(answers: {
  providers?: { status?: number; body: unknown }
  values?: { status?: number; body: unknown }
}) {
  return vi.fn<typeof fetch>((input) => {
    const url = urlOf(input)
    const answer = url === PROVIDERS ? answers.providers : answers.values
    if (answer === undefined) return Promise.resolve(new Response('{}', { status: 404 }))
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  })
}

/** `GET /values` as a provider answers it: one row per bucket, the bucket's start first. */
const valuesBody = {
  context: 'vessels.urn:mrn:signalk:uuid:00000000-0000-4000-8000-000000000000',
  range: { from: '2026-09-29T12:00:00.000Z', to: '2026-09-30T12:00:00.000Z' },
  values: [{ path: 'electrical.batteries.house.voltage', method: 'min' }],
  data: [
    ['2026-09-29T12:00:00.000Z', 13.2],
    ['2026-09-29T12:10:00.000Z', null],
    ['2026-09-29T12:20:00.000Z', 13.1]
  ]
}

describe('hasProvider', () => {
  it('is true when the server lists a provider', async () => {
    const fetchFn = fakeFetch({ providers: { body: { 'some-provider': { isDefault: true } } } })
    await expect(httpHistorySource(fetchFn).hasProvider()).resolves.toBe(true)
  })

  it('is false when the server lists none', async () => {
    const fetchFn = fakeFetch({ providers: { body: {} } })
    await expect(httpHistorySource(fetchFn).hasProvider()).resolves.toBe(false)
  })

  it('is false, not an error, on a server without the history API', async () => {
    const fetchFn = fakeFetch({})
    await expect(httpHistorySource(fetchFn).hasProvider()).resolves.toBe(false)
  })

  it('is false when the request fails', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('offline')))
    await expect(httpHistorySource(fetchFn).hasProvider()).resolves.toBe(false)
  })

  it('asks the server once per source', async () => {
    const fetchFn = fakeFetch({ providers: { body: { p: { isDefault: true } } } })
    const source = httpHistorySource(fetchFn)
    await source.hasProvider()
    await source.hasProvider()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('values', () => {
  it('asks for the path, its aggregate, the span and the resolution', async () => {
    const fetchFn = fakeFetch({ values: { body: valuesBody } })
    await httpHistorySource(fetchFn).values({
      path: 'electrical.batteries.house.voltage',
      method: 'min',
      seconds: 86_400,
      resolution: 600
    })
    const url = new URL(urlOf(fetchFn.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toBe('/signalk/v2/api/history/values')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      paths: 'electrical.batteries.house.voltage:min',
      duration: 'PT86400S',
      resolution: '600'
    })
    expect(fetchFn.mock.calls[0][1]?.credentials).toBe('same-origin')
  })

  it('answers the rows as times and values, a missing value as null', async () => {
    const fetchFn = fakeFetch({ values: { body: valuesBody } })
    const points = await httpHistorySource(fetchFn).values({
      path: 'electrical.batteries.house.voltage',
      method: 'min',
      seconds: 86_400,
      resolution: 600
    })
    expect(points).toEqual([
      { time: Date.parse('2026-09-29T12:00:00.000Z'), value: 13.2 },
      { time: Date.parse('2026-09-29T12:10:00.000Z'), value: null },
      { time: Date.parse('2026-09-29T12:20:00.000Z'), value: 13.1 }
    ])
  })

  it('rejects with the server’s message when the query fails', async () => {
    const fetchFn = fakeFetch({ values: { status: 400, body: { error: 'bad duration' } } })
    await expect(
      httpHistorySource(fetchFn).values({
        path: 'a.b',
        method: 'average',
        seconds: 3600,
        resolution: 30
      })
    ).rejects.toThrow('bad duration')
  })
})

describe('parseValues', () => {
  it('rejects a body without rows', () => {
    expect(() => parseValues({ values: [] }, '/values')).toThrow('unexpected response from /values')
  })

  it('drops rows without a time and keeps a value that is not a number as a gap', () => {
    const points = parseValues(
      {
        data: [
          ['not a time', 1],
          [12, 2],
          ['2026-09-30T00:00:00.000Z', 'on'],
          ['2026-09-30T00:01:00.000Z', { latitude: 1, longitude: 2 }]
        ]
      },
      '/values'
    )
    expect(points).toEqual([
      { time: Date.parse('2026-09-30T00:00:00.000Z'), value: null },
      { time: Date.parse('2026-09-30T00:01:00.000Z'), value: null }
    ])
  })
})

describe('resolutionFor', () => {
  it('takes about one bucket for every two pixels, rounded up to a whole step', () => {
    // 24 h over 360 px wants 480 s buckets; 10 min is the next step up.
    expect(resolutionFor(86_400, 360)).toBe(600)
  })

  it('matches each span at the same width', () => {
    expect(SPANS.map((s) => resolutionFor(s.seconds, 360))).toEqual([30, 120, 600, 3600])
  })

  it('takes finer buckets for a wider chart', () => {
    expect(resolutionFor(86_400, 720)).toBe(300)
  })

  it('keeps the coarsest step for a chart too narrow to measure', () => {
    expect(resolutionFor(604_800, 0)).toBe(14_400)
  })
})
