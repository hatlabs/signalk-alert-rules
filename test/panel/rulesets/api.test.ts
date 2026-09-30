import { describe, expect, it, vi } from 'vitest'
import { RuleRejectedError, SessionExpiredError } from '../../../src/panel/api'
import { httpRulesetsApi } from '../../../src/panel/rulesets/api'

const BASE = '/plugins/signalk-alert-rules'

interface Route {
  status?: number
  body?: unknown
}

/** A fetch that answers each `METHOD url` with a JSON body, or none, and a status. */
function fakeFetch(routes: Partial<Record<string, Route>>) {
  return vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const key = `${init?.method ?? 'GET'} ${url}`
    const route = routes[key]
    if (route === undefined) return Promise.reject(new Error(`unexpected request ${key}`))
    const status = route.status ?? 200
    return Promise.resolve(
      route.body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(route.body), {
            status,
            headers: { 'Content-Type': 'application/json' }
          })
    )
  })
}

/** A ruleset entry as src/application.ts builds it. */
const batteries = {
  slug: 'batteries',
  name: 'Battery monitoring',
  version: '1.0.0',
  description: 'House bank',
  source: 'package signalk-alert-ruleset-example',
  package: { name: 'signalk-alert-ruleset-example', version: '1.0.0' },
  enabled: false,
  parameters: [
    { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
    {
      name: 'lowVoltage',
      type: 'number',
      unit: 'V',
      description: 'Below this the bank is low',
      default: 12,
      minimum: 10,
      maximum: 14
    }
  ],
  values: { lowVoltage: 11.5 },
  rules: ['low'],
  missingPaths: ['electrical.batteries.house.voltage'],
  notices: [{ at: '2026-09-30T12:00:00.000Z', message: 'rule high is not in version 1.0.0' }]
}

const listing = {
  rulesets: [batteries],
  problems: [{ source: 'file broken.yaml', message: 'bad indentation', line: 3 }]
}

describe('httpRulesetsApi', () => {
  it('reads the rulesets and the discovery problems', async () => {
    const fetchFn = fakeFetch({ [`GET ${BASE}/rulesets`]: { body: listing } })
    const answer = await httpRulesetsApi(fetchFn).list()
    expect(answer).toEqual(listing)
    expect(fetchFn.mock.calls[0][1]?.credentials).toBe('same-origin')
  })

  it('reads a file ruleset, which has no package, description or line', async () => {
    const { package: _p, description: _d, ...fromFile } = batteries
    const body = {
      rulesets: [{ ...fromFile, source: 'file extra.yaml' }],
      problems: [{ source: 'package gone', message: 'Cannot find module' }]
    }
    const fetchFn = fakeFetch({ [`GET ${BASE}/rulesets`]: { body } })
    expect(await httpRulesetsApi(fetchFn).list()).toEqual(body)
  })

  it('rejects a ruleset without its parameters', async () => {
    const { parameters: _p, ...broken } = batteries
    const fetchFn = fakeFetch({
      [`GET ${BASE}/rulesets`]: { body: { rulesets: [broken], problems: [] } }
    })
    await expect(httpRulesetsApi(fetchFn).list()).rejects.toThrow(/unexpected response/)
  })

  it('rescans with a JSON POST and reads the listing it answers', async () => {
    const fetchFn = fakeFetch({ [`POST ${BASE}/rulesets/rescan`]: { body: listing } })
    expect(await httpRulesetsApi(fetchFn).rescan()).toEqual(listing)
    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('enables a ruleset and reads the entry it answers', async () => {
    const fetchFn = fakeFetch({
      [`PUT ${BASE}/rulesets/batteries/enabled`]: { body: { ...batteries, enabled: true } }
    })
    const entry = await httpRulesetsApi(fetchFn).setEnabled('batteries', true)
    expect(entry.enabled).toBe(true)
    expect(fetchFn.mock.calls[0][1]?.body).toBe(JSON.stringify({ enabled: true }))
  })

  it('replaces the parameter values with the whole object', async () => {
    const fetchFn = fakeFetch({
      [`PUT ${BASE}/rulesets/batteries/parameters`]: { body: { ...batteries, values: {} } }
    })
    const entry = await httpRulesetsApi(fetchFn).setParameters('batteries', { prefix: 'x' })
    expect(entry.values).toEqual({})
    expect(fetchFn.mock.calls[0][1]?.body).toBe(JSON.stringify({ prefix: 'x' }))
  })

  it('carries the field errors of refused values', async () => {
    const fetchFn = fakeFetch({
      [`PUT ${BASE}/rulesets/batteries/parameters`]: {
        status: 400,
        body: {
          error: 'invalid parameter values',
          errors: [{ path: '/lowVoltage', message: 'must be <= 14' }]
        }
      }
    })
    const refused = httpRulesetsApi(fetchFn).setParameters('batteries', { lowVoltage: 20 })
    await expect(refused).rejects.toBeInstanceOf(RuleRejectedError)
    await expect(refused).rejects.toMatchObject({
      errors: [{ path: '/lowVoltage', message: 'must be <= 14' }]
    })
  })

  it('dismisses the notices, which answers no body', async () => {
    const fetchFn = fakeFetch({
      [`DELETE ${BASE}/rulesets/batteries/notices`]: { status: 204 }
    })
    await expect(httpRulesetsApi(fetchFn).dismissNotices('batteries')).resolves.toBeUndefined()
  })

  it('escapes the slug in the path', async () => {
    const fetchFn = fakeFetch({ [`DELETE ${BASE}/rulesets/a%2Fb/notices`]: { status: 204 } })
    await httpRulesetsApi(fetchFn).dismissNotices('a/b')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('reports an expired session', async () => {
    const fetchFn = fakeFetch({ [`GET ${BASE}/rulesets`]: { status: 401, body: {} } })
    await expect(httpRulesetsApi(fetchFn).list()).rejects.toBeInstanceOf(SessionExpiredError)
  })
})
