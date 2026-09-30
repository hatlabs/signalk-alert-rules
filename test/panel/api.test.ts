import { describe, expect, it, vi } from 'vitest'
import { httpApi, REQUEST_TIMEOUT_MS, SessionExpiredError } from '../../src/panel/api'

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

/** A rule entry as `GET /rules` answers it, as src/application.ts builds it. */
const ruleEntry = {
  origin: 'user',
  slug: 'house-battery-low',
  rule: {
    name: 'House battery low',
    slug: 'house-battery-low',
    message: 'House battery voltage is low',
    signal: { path: 'electrical.batteries.*.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'zone', level: 'warn' },
      duration: 60,
      hysteresis: 0.2,
      clearDuration: 30
    },
    gates: [
      {
        signal: { path: 'electrical.chargers.shore.state' },
        direction: 'below',
        limit: { kind: 'fixed', value: 1 }
      }
    ]
  },
  enabled: true,
  note: 'Sender replaced in spring',
  suppression: { since: '2026-09-30T12:00:00.000Z', actor: 'admin', autoEndAfter: 600 },
  status: {
    badge: 'suppressed',
    suppression: { scope: 'rule', autoEndAfter: 600 },
    subLabels: ['waitingForClear', 'gateInputUnavailable'],
    issues: ['instance x.y was not admitted'],
    errors: [],
    instances: [
      {
        instance: { name: 'house', segment: 'house' },
        active: false,
        inUse: true,
        input: 'value',
        value: 12.1,
        limit: 12.2,
        progress: { kind: 'timer', toward: 'set', elapsed: 20, target: 60 },
        gates: [{ holds: true, input: 'unavailable' }],
        adopted: false,
        clearFor: 3,
        badge: 'suppressed',
        suppression: { scope: 'rule', autoEndAfter: 600 },
        subLabels: ['waitingForClear', 'gateInputUnavailable']
      }
    ]
  }
}

/** An accumulator rule that is not evaluated, keeping its total. */
const disabledAccumulator = {
  origin: 'engine-pack',
  slug: 'engine-hours',
  rule: {
    name: 'Engine service due',
    slug: 'engine-hours',
    message: 'Engine service is due',
    priority: 'caution',
    signal: {
      combinator: 'max',
      inputs: [{ path: 'propulsion.port.revolutions' }, { path: 'propulsion.stbd.revolutions' }]
    },
    detector: { type: 'accumulator', measure: 'time', limit: 360000 }
  },
  enabled: false,
  status: {
    badge: 'disabled',
    reason: 'disabled',
    subLabels: [],
    issues: [],
    errors: [],
    instances: [
      {
        badge: 'disabled',
        reason: 'disabled',
        subLabels: [],
        progress: { kind: 'total', total: 7200, limit: 360000 }
      }
    ]
  }
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

  // Node's AbortSignal.timeout does not follow fake timers; the Shell tests
  // run in jsdom, whose does, and cover a request that never answers.
  it('bounds every request with the request timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const fetchFn = fakeFetch({
        [`${BASE}/state`]: { body: runningState },
        [`${BASE}/`]: { body: pluginInfo },
        [`${BASE}/rules`]: { body: [] }
      })
      const api = httpApi(fetchFn)
      await api.state()
      await api.pluginEnabled()
      await api.rules()
      expect(timeout.mock.calls).toEqual([
        [REQUEST_TIMEOUT_MS],
        [REQUEST_TIMEOUT_MS],
        [REQUEST_TIMEOUT_MS]
      ])
      const signals = fetchFn.mock.calls.map(([, init]) => init?.signal)
      expect(signals).toEqual(timeout.mock.results.map((r) => r.value as AbortSignal))
    } finally {
      timeout.mockRestore()
    }
  })

  it('fails with the status when a response that is not OK gives no message', async () => {
    const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { status: 503, body: {} } }))
    await expect(api.rules()).rejects.toThrow(/503/)
    await expect(api.rules()).rejects.not.toBeInstanceOf(SessionExpiredError)
  })

  it.each([401, 403])('reports an expired session on %i from any route', async (status) => {
    const denied = { status, body: { error: 'Unauthorized' } }
    const api = httpApi(
      fakeFetch({ [`${BASE}/state`]: denied, [`${BASE}/`]: denied, [`${BASE}/rules`]: denied })
    )
    await expect(api.state()).rejects.toBeInstanceOf(SessionExpiredError)
    await expect(api.pluginEnabled()).rejects.toBeInstanceOf(SessionExpiredError)
    await expect(api.rules()).rejects.toBeInstanceOf(SessionExpiredError)
  })

  describe('state', () => {
    it('reads the state and the evaluation switch', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: runningState } }))
      expect(await api.state()).toEqual({
        running: true,
        securityEnabled: true,
        evaluation: { enabled: true }
      })
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
    it('reads each entry with its rule, controls and status', async () => {
      const api = httpApi(
        fakeFetch({ [`${BASE}/rules`]: { body: [ruleEntry, disabledAccumulator] } })
      )
      const [battery, hours] = await api.rules()
      expect(battery).toEqual({
        origin: 'user',
        slug: 'house-battery-low',
        rule: {
          name: 'House battery low',
          detector: { type: 'sustained', direction: 'below', zoneLevel: 'warn' },
          signal: { paths: ['electrical.batteries.*.voltage'] },
          gates: [{ paths: ['electrical.chargers.shore.state'] }]
        },
        enabled: true,
        note: 'Sender replaced in spring',
        suppression: { since: '2026-09-30T12:00:00.000Z', actor: 'admin', autoEndAfter: 600 },
        status: {
          badge: 'suppressed',
          suppression: { scope: 'rule', autoEndAfter: 600 },
          subLabels: ['waitingForClear', 'gateInputUnavailable'],
          issues: ['instance x.y was not admitted'],
          errors: [],
          instances: [
            {
              instance: { name: 'house', segment: 'house' },
              badge: 'suppressed',
              suppression: { scope: 'rule', autoEndAfter: 600 },
              subLabels: ['waitingForClear', 'gateInputUnavailable'],
              active: false,
              input: 'value',
              value: 12.1,
              limit: 12.2,
              progress: { kind: 'timer', toward: 'set', elapsed: 20, target: 60 },
              gates: [{ holds: true, input: 'unavailable' }]
            }
          ]
        }
      })
      expect(hours).toEqual({
        origin: 'engine-pack',
        slug: 'engine-hours',
        rule: {
          name: 'Engine service due',
          priority: 'caution',
          detector: { type: 'accumulator', measure: 'time' },
          signal: {
            combinator: 'max',
            paths: ['propulsion.port.revolutions', 'propulsion.stbd.revolutions']
          },
          gates: []
        },
        enabled: false,
        status: {
          badge: 'disabled',
          reason: 'disabled',
          subLabels: [],
          issues: [],
          errors: [],
          instances: [
            {
              badge: 'disabled',
              reason: 'disabled',
              subLabels: [],
              progress: { kind: 'total', total: 7200, limit: 360000 },
              gates: []
            }
          ]
        }
      })
    })

    it('reads the zone level and priority of an active instance', async () => {
      const entry = {
        ...ruleEntry,
        status: {
          ...ruleEntry.status,
          instances: [
            { ...ruleEntry.status.instances[0], active: true, level: 'alarm', priority: 'alarm' }
          ]
        }
      }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      const [read] = await api.rules()
      expect(read.status.instances[0]).toMatchObject({
        active: true,
        level: 'alarm',
        priority: 'alarm'
      })
    })

    it('reads a position value', async () => {
      const position = { latitude: 60.1, longitude: 24.9 }
      const entry = {
        ...ruleEntry,
        status: {
          ...ruleEntry.status,
          instances: [{ ...ruleEntry.status.instances[0], value: position }]
        }
      }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      const [read] = await api.rules()
      expect(read.status.instances[0].value).toEqual(position)
    })

    it('rejects an entry without a slug', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [{ origin: 'user' }] } }))
      await expect(api.rules()).rejects.toThrow(/unexpected response from \/rules/)
    })

    it('rejects a badge the panel does not know', async () => {
      const entry = { ...ruleEntry, status: { ...ruleEntry.status, badge: 'ok' } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      await expect(api.rules()).rejects.toThrow(/unexpected response from \/rules/)
    })
  })

  describe('actions', () => {
    const answered = { enabled: false, actor: 'admin', at: '2026-09-30T12:00:00.000Z' }

    it('resets an accumulator with a JSON request and reads the entry it answers', async () => {
      const fetchFn = fakeFetch({
        [`${BASE}/rules/engine-pack/engine-hours/reset`]: { body: disabledAccumulator }
      })
      const entry = await httpApi(fetchFn).resetAccumulator('engine-pack', 'engine-hours')
      expect(entry.slug).toBe('engine-hours')
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(init?.credentials).toBe('same-origin')
    })

    it('escapes the origin and slug in the path', async () => {
      const fetchFn = fakeFetch({
        [`${BASE}/rules/a%2Fb/c%3F/reset`]: { body: disabledAccumulator }
      })
      await httpApi(fetchFn).resetAccumulator('a/b', 'c?')
      expect(fetchFn).toHaveBeenCalledOnce()
    })

    it('sets the evaluation switch and reads what it answers', async () => {
      const fetchFn = fakeFetch({ [`${BASE}/evaluation`]: { body: answered } })
      expect(await httpApi(fetchFn).setEvaluation(false)).toEqual({ enabled: false })
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('PUT')
      expect(init?.body).toBe(JSON.stringify({ enabled: false }))
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('fails with the error the server gives', async () => {
      const api = httpApi(
        fakeFetch({
          [`${BASE}/rules/user/x/reset`]: {
            status: 400,
            body: { error: 'only an accumulator rule can be reset' }
          }
        })
      )
      await expect(api.resetAccumulator('user', 'x')).rejects.toThrow(
        'only an accumulator rule can be reset'
      )
    })

    it('reports an expired session', async () => {
      const denied = { status: 401, body: { error: 'Unauthorized' } }
      const api = httpApi(fakeFetch({ [`${BASE}/evaluation`]: denied }))
      await expect(api.setEvaluation(true)).rejects.toBeInstanceOf(SessionExpiredError)
    })
  })

  describe('pluginEnabled', () => {
    it('reads the enabled flag', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/`]: { body: { ...pluginInfo, enabled: false } } }))
      expect(await api.pluginEnabled()).toBe(false)
    })

    it('reads a fresh install, whose answer has no enabled flag, as disabled', async () => {
      // signalk-server answers `enabledByDefault || options.enabled`, which is
      // undefined before the plugin was ever configured and so left out.
      const { enabled: _, ...freshInstall } = pluginInfo
      const api = httpApi(
        fakeFetch({ [`${BASE}/`]: { body: { ...freshInstall, enabledByDefault: false } } })
      )
      expect(await api.pluginEnabled()).toBe(false)
    })

    it('rejects an enabled flag that is not a boolean', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/`]: { body: { ...pluginInfo, enabled: 'yes' } } }))
      await expect(api.pluginEnabled()).rejects.toThrow(/unexpected response/)
    })
  })
})
