import { describe, expect, it, vi } from 'vitest'
import { httpApi } from '../../src/panel/api'

const BASE = '/plugins/signalk-alert-rules'

/** A fetch that answers each URL with a JSON body and a status. */
function fakeFetch(routes: Partial<Record<string, { status?: number; body: unknown }>>) {
  return vi.fn<typeof fetch>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = routes[url]
    if (route === undefined) return Promise.reject(new Error(`unexpected request to ${url}`))
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  })
}

/** `GET /state` from a running plugin, as src/application.ts answers it. */
const runningState = {
  running: true,
  securityEnabled: true,
  evaluation: { enabled: true, actor: 'admin', at: '2026-09-30T12:00:00.000Z' },
  issues: ['stored rule broken is not valid and does not run: /signal: required']
}

/** A rule entry as `GET /rules` answers it. */
const ruleEntry = {
  origin: 'user',
  slug: 'house-battery-low',
  rule: {
    name: 'House battery low',
    slug: 'house-battery-low',
    message: 'House battery voltage is low',
    signal: { path: 'electrical.batteries.house.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'zone', level: 'warn' },
      duration: 60,
      hysteresis: 0.2,
      clearDuration: 30
    }
  },
  status: null
}

/** The plugin route root as signalk-server answers it once the plugin was configured. */
const pluginInfo = {
  enabled: true,
  enabledByDefault: false,
  id: 'signalk-alert-rules',
  name: 'Alert rules',
  version: '0.1.0'
}

describe('httpApi', () => {
  it('asks the three routes with the session cookie', async () => {
    const fetchFn = fakeFetch({
      [`${BASE}/state`]: { body: runningState },
      [`${BASE}/`]: { body: pluginInfo },
      [`${BASE}/rules`]: { body: [] }
    })
    const api = httpApi(fetchFn)
    await api.state()
    await api.pluginEnabled()
    await api.rules()
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/state`,
      `${BASE}/`,
      `${BASE}/rules`
    ])
    for (const [, init] of fetchFn.mock.calls) {
      expect(init?.credentials).toBe('same-origin')
    }
  })

  it('fails on a status that is not OK', async () => {
    const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { status: 503, body: { error: 'x' } } }))
    await expect(api.rules()).rejects.toThrow(/503/)
  })

  describe('state', () => {
    it('reads the state and ignores the fields the panel does not use yet', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: runningState } }))
      expect(await api.state()).toEqual({ running: true, securityEnabled: true })
    })

    it('keeps the start error of a plugin that is not running', async () => {
      const body = { running: false, error: 'the server has no alerts API', securityEnabled: false }
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body } }))
      expect(await api.state()).toEqual(body)
    })

    it('reads a missing securityEnabled as unknown', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: { running: true } } }))
      expect(await api.state()).toEqual({ running: true, securityEnabled: null })
    })

    it('rejects a body without running', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: { securityEnabled: true } } }))
      await expect(api.state()).rejects.toThrow(/unexpected response from \/state/)
    })
  })

  describe('rules', () => {
    it('reads origin and slug from each entry', async () => {
      const second = { ...ruleEntry, slug: 'engine-hours', status: { badge: 'ok' } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [ruleEntry, second] } }))
      expect(await api.rules()).toEqual([
        { origin: 'user', slug: 'house-battery-low' },
        { origin: 'user', slug: 'engine-hours' }
      ])
    })

    it('rejects an entry without a slug', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [{ origin: 'user' }] } }))
      await expect(api.rules()).rejects.toThrow(/unexpected response from \/rules/)
    })
  })

  describe('pluginEnabled', () => {
    it('reads the enabled flag', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/`]: { body: { ...pluginInfo, enabled: false } } }))
      expect(await api.pluginEnabled()).toBe(false)
    })

    it('rejects an enabled flag that is not a boolean', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/`]: { body: { ...pluginInfo, enabled: 'yes' } } }))
      await expect(api.pluginEnabled()).rejects.toThrow(/unexpected response/)
    })
  })
})
