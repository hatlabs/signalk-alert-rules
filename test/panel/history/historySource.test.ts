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
  values: [{ path: 'electrical.batteries.house.voltage', methods: ['min'] }],
  data: [
    ['2026-09-29T12:00:00.000Z', 13.2],
    ['2026-09-29T12:10:00.000Z', null],
    ['2026-09-29T12:20:00.000Z', 13.1]
  ]
}

/** A provider's answer to a min and max query, listing its columns highest first. */
const rangeBody = {
  ...valuesBody,
  values: [
    { path: 'navigation.heel', method: 'max' },
    { path: 'navigation.heel', method: 'min' }
  ],
  data: [
    ['2026-09-29T12:00:00.000Z', 4, -3],
    ['2026-09-29T12:00:30.000Z', null, null]
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

  it('asks again after a failed check, as while the server restarts with a new plugin', async () => {
    const answers = fakeFetch({ providers: { body: { p: { isDefault: true } } } })
    const fetchFn = vi
      .fn<typeof fetch>(answers)
      .mockImplementationOnce(() => Promise.reject(new TypeError('offline')))
    const source = httpHistorySource(fetchFn)
    await expect(source.hasProvider()).resolves.toBe(false)
    await expect(source.hasProvider()).resolves.toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
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
      methods: ['min'],
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

  it('asks for the pinned source’s values only', async () => {
    const fetchFn = fakeFetch({ values: { body: valuesBody } })
    await httpHistorySource(fetchFn).values({
      path: 'electrical.batteries.house.voltage',
      methods: ['min'],
      source: 'can0.35',
      seconds: 86_400,
      resolution: 600
    })
    const url = new URL(urlOf(fetchFn.mock.calls[0][0]), 'http://localhost')
    expect(url.searchParams.get('paths')).toBe('electrical.batteries.house.voltage:min|can0.35')
  })

  it('answers the rows as times and values, a missing value as null', async () => {
    const fetchFn = fakeFetch({ values: { body: valuesBody } })
    const points = await httpHistorySource(fetchFn).values({
      path: 'electrical.batteries.house.voltage',
      methods: ['min'],
      seconds: 86_400,
      resolution: 600
    })
    expect(points).toEqual([
      [
        { time: Date.parse('2026-09-29T12:00:00.000Z'), value: 13.2 },
        { time: Date.parse('2026-09-29T12:10:00.000Z'), value: null },
        { time: Date.parse('2026-09-29T12:20:00.000Z'), value: 13.1 }
      ]
    ])
  })

  it('asks for the lowest and highest of each bucket in one query, the source on each', async () => {
    const fetchFn = fakeFetch({ values: { body: rangeBody } })
    await httpHistorySource(fetchFn).values({
      path: 'navigation.heel',
      methods: ['min', 'max'],
      source: 'imu.1',
      seconds: 3600,
      resolution: 30
    })
    const url = new URL(urlOf(fetchFn.mock.calls[0][0]), 'http://localhost')
    expect(url.searchParams.get('paths')).toBe(
      'navigation.heel:min|imu.1,navigation.heel:max|imu.1'
    )
  })

  it('answers one series per aggregate, in the order asked, whatever the column order', async () => {
    const fetchFn = fakeFetch({ values: { body: rangeBody } })
    const [lows, highs] = await httpHistorySource(fetchFn).values({
      path: 'navigation.heel',
      methods: ['min', 'max'],
      seconds: 3600,
      resolution: 30
    })
    expect(lows.map((p) => p.value)).toEqual([-3, null])
    expect(highs.map((p) => p.value)).toEqual([4, null])
  })

  it('rejects with the server’s message when the query fails', async () => {
    const fetchFn = fakeFetch({ values: { status: 400, body: { error: 'bad duration' } } })
    await expect(
      httpHistorySource(fetchFn).values({
        path: 'a.b',
        methods: ['average'],
        seconds: 3600,
        resolution: 30
      })
    ).rejects.toThrow('bad duration')
  })
})

describe('parseValues', () => {
  it('rejects a body without rows', () => {
    expect(() => parseValues({ values: [] }, '/values', ['min'])).toThrow(
      'unexpected response from /values'
    )
  })

  it('takes the columns in the order asked when the body does not list them', () => {
    const [lows, highs] = parseValues({ data: [['2026-09-30T00:00:00.000Z', 1, 2]] }, '/values', [
      'min',
      'max'
    ])
    expect(lows[0].value).toBe(1)
    expect(highs[0].value).toBe(2)
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
      '/values',
      ['average']
    )
    expect(points).toEqual([
      [
        { time: Date.parse('2026-09-30T00:00:00.000Z'), value: null },
        { time: Date.parse('2026-09-30T00:01:00.000Z'), value: null }
      ]
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
