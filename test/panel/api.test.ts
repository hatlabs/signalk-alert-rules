import { describe, expect, it, vi } from 'vitest'
import type { Rule } from '../../src/model/rule'
import {
  httpApi,
  isInvalid,
  REQUEST_TIMEOUT_MS,
  RuleRejectedError,
  SessionExpiredError
} from '../../src/panel/api'

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
  permissions: 'readwrite',
  issues: ['stored rule broken is not valid and does not run: /signal: required']
}

/** A rule entry as `GET /rules` answers it, as src/application.ts builds it. */
const ruleEntry = {
  slug: 'house-battery-low',
  alertPath: 'electrical.batteries.*.voltageLow',
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
  disabled: {
    since: '2026-09-30T12:00:00.000Z',
    actor: 'admin',
    note: 'Sender replaced in spring'
  },
  state: {
    ruleState: 'disabled',
    condition: 'present',
    reason: 'conditionPresent',
    instance: { name: 'house', segment: 'house' },
    value: 12.1,
    limit: 12.2,
    gates: [{ path: 'electrical.chargers.shore.state', holds: true, input: 'unavailable' }],
    changedAt: '2026-09-30T12:00:00.000Z',
    issues: ['instance x.y was not admitted'],
    errors: [],
    instances: [
      {
        instance: { name: 'house', segment: 'house' },
        condition: 'present',
        reason: 'conditionPresent',
        value: 12.1,
        limit: 12.2,
        gates: [{ path: 'electrical.chargers.shore.state', holds: true, input: 'unavailable' }]
      }
    ]
  }
}

/** An accumulator rule before the runner starts, which is not evaluated and keeps its total. */
const notStartedAccumulator = {
  slug: 'engine-hours',
  alertPath: 'propulsion.revolutionsAccumulated',
  rule: {
    name: 'Engine service due',
    slug: 'engine-hours',
    message: 'Engine service is due',
    signal: {
      combinator: 'max',
      inputs: [{ path: 'propulsion.port.revolutions' }, { path: 'propulsion.stbd.revolutions' }]
    },
    detector: {
      type: 'accumulator',
      measure: 'time',
      steps: [{ limit: 360000, priority: 'caution' }]
    }
  },
  state: {
    ruleState: 'enabled',
    condition: 'noData',
    reason: 'notEvaluated',
    changedAt: '2026-09-30T12:00:00.000Z',
    issues: [],
    errors: [],
    instances: [
      {
        condition: 'noData',
        reason: 'notEvaluated',
        progress: { kind: 'total', total: 7200, limit: 360000 },
        gates: []
      }
    ]
  }
}

describe('httpApi', () => {
  it('asks the routes with the session cookie', async () => {
    const fetchFn = fakeFetch({
      [`${BASE}/state`]: { body: runningState },
      [`${BASE}/rules`]: { body: [] }
    })
    const api = httpApi(fetchFn)
    await api.state()
    await api.rules()
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([`${BASE}/state`, `${BASE}/rules`])
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
        [`${BASE}/rules`]: { body: [] }
      })
      const api = httpApi(fetchFn)
      await api.state()
      await api.rules()
      expect(timeout.mock.calls).toEqual([[REQUEST_TIMEOUT_MS], [REQUEST_TIMEOUT_MS]])
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

  // Signal K answers both a caller who is not logged in and one below the route's level so.
  it('reports a 401 from any route as refused', async () => {
    const denied = { status: 401, body: { error: 'Permission Denied' } }
    const api = httpApi(fakeFetch({ [`${BASE}/state`]: denied, [`${BASE}/rules`]: denied }))
    await expect(api.state()).rejects.toBeInstanceOf(SessionExpiredError)
    await expect(api.rules()).rejects.toBeInstanceOf(SessionExpiredError)
  })

  describe('state', () => {
    it('reads the state and the load issues', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: runningState } }))
      expect(await api.state()).toEqual({
        running: true,
        securityEnabled: true,
        permissions: 'readwrite',
        issues: ['stored rule broken is not valid and does not run: /signal: required']
      })
    })

    it.each(['root', undefined])('reads permissions %s as read-only', async (permissions) => {
      const body = { ...runningState, permissions }
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body } }))
      expect((await api.state()).permissions).toBe('readonly')
    })

    it('rejects issues that are not a list of strings', async () => {
      const body = { ...runningState, issues: [42] }
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body } }))
      await expect(api.state()).rejects.toThrow(/unexpected response from \/state/)
    })

    it('keeps the start error of a plugin that is not running', async () => {
      const body = {
        running: false,
        error: 'the server has no alerts API',
        securityEnabled: false,
        permissions: 'admin'
      }
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body } }))
      expect(await api.state()).toEqual(body)
    })

    it('reads a missing securityEnabled as unknown', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: { running: true } } }))
      expect(await api.state()).toEqual({
        running: true,
        securityEnabled: null,
        permissions: 'readonly'
      })
    })

    it('rejects a body without running', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/state`]: { body: { securityEnabled: true } } }))
      await expect(api.state()).rejects.toThrow(/unexpected response from \/state/)
    })
  })

  describe('rules', () => {
    it('reads each entry with its rule, controls and status', async () => {
      const api = httpApi(
        fakeFetch({ [`${BASE}/rules`]: { body: [ruleEntry, notStartedAccumulator] } })
      )
      const [battery, hours] = await api.rules()
      expect(battery).toEqual({
        slug: 'house-battery-low',
        rule: {
          name: 'House battery low',
          alertPath: 'electrical.batteries.*.voltageLow',
          message: 'House battery voltage is low',
          steps: [],
          duration: 60,
          detector: { type: 'sustained', direction: 'below', zoneLevel: 'warn' },
          signal: { paths: ['electrical.batteries.*.voltage'] },
          gates: [{ paths: ['electrical.chargers.shore.state'] }]
        },
        disabled: {
          since: '2026-09-30T12:00:00.000Z',
          actor: 'admin',
          note: 'Sender replaced in spring'
        },
        status: {
          ruleState: 'disabled',
          condition: 'present',
          reason: 'conditionPresent',
          changedAt: '2026-09-30T12:00:00.000Z',
          instance: { name: 'house', segment: 'house' },
          value: 12.1,
          limit: 12.2,
          issues: ['instance x.y was not admitted'],
          errors: [],
          instances: [
            {
              instance: { name: 'house', segment: 'house' },
              condition: 'present',
              reason: 'conditionPresent',
              value: 12.1,
              limit: 12.2,
              gates: [{ holds: true, input: 'unavailable' }]
            }
          ]
        }
      })
      expect(hours).toEqual({
        slug: 'engine-hours',
        rule: {
          name: 'Engine service due',
          alertPath: 'propulsion.revolutionsAccumulated',
          priority: 'caution',
          message: 'Engine service is due',
          steps: [{ limit: 360000, priority: 'caution' }],
          detector: { type: 'accumulator', measure: 'time' },
          signal: {
            combinator: 'max',
            paths: ['propulsion.port.revolutions', 'propulsion.stbd.revolutions']
          },
          gates: []
        },
        status: {
          ruleState: 'enabled',
          condition: 'noData',
          reason: 'notEvaluated',
          changedAt: '2026-09-30T12:00:00.000Z',
          issues: [],
          errors: [],
          instances: [
            {
              condition: 'noData',
              reason: 'notEvaluated',
              progress: { kind: 'total', total: 7200, limit: 360000 },
              gates: []
            }
          ]
        }
      })
    })

    it("reads the rule's steps, source and template, and the step an alert reached", async () => {
      const stepped = {
        ...ruleEntry,
        rule: {
          ...ruleEntry.rule,
          signal: { path: 'electrical.batteries.house.voltage', source: 'shunt.1' },
          detector: {
            type: 'sustained',
            direction: 'below',
            steps: [
              { limit: 12.2, priority: 'warning' },
              { limit: 11.8, priority: 'alarm' }
            ],
            duration: 30
          },
          template: {
            set: 'builtin',
            id: 'lifepo4-voltage-low',
            version: '1',
            pick: { instance: 'house' }
          }
        },
        state: {
          ...ruleEntry.state,
          ruleState: 'enabled',
          condition: 'alerting',
          reason: 'alertActive',
          priority: 'alarm',
          step: 1,
          awaitingInput: false
        }
      }
      const match = {
        ...notStartedAccumulator,
        rule: {
          ...notStartedAccumulator.rule,
          detector: {
            type: 'match',
            op: 'equals',
            steps: [
              { value: 'fault', priority: 'warning' },
              { value: 'critical', priority: 'alarm' }
            ]
          }
        }
      }
      const absence = {
        ...notStartedAccumulator,
        rule: {
          ...notStartedAccumulator.rule,
          detector: {
            type: 'absence',
            event: { op: 'changes' },
            steps: [{ within: 600, priority: 'warning' }]
          }
        }
      }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [stepped, match, absence] } }))
      const [read, matched, absent] = await api.rules()
      if (isInvalid(read) || isInvalid(matched) || isInvalid(absent)) throw new Error('invalid')
      expect(read.rule).toMatchObject({
        priority: 'warning',
        steps: [
          { limit: 12.2, priority: 'warning' },
          { limit: 11.8, priority: 'alarm' }
        ],
        duration: 30,
        source: 'shunt.1',
        template: { set: 'builtin', id: 'lifepo4-voltage-low', pick: { instance: 'house' } }
      })
      expect(read.status).toMatchObject({ priority: 'alarm', step: 1 })
      expect(matched.rule.detector.op).toBe('equals')
      expect(matched.rule.steps).toEqual([
        { value: 'fault', priority: 'warning' },
        { value: 'critical', priority: 'alarm' }
      ])
      expect(absent.rule.steps).toEqual([{ within: 600, priority: 'warning' }])
    })

    it('reads the zone level and priority of an active instance', async () => {
      const alerting = {
        ...ruleEntry.state.instances[0],
        condition: 'alerting',
        reason: 'alertActive',
        step: 1,
        level: 'alarm',
        priority: 'alarm',
        awaitingInput: false
      }
      const entry = { ...ruleEntry, state: { ...ruleEntry.state, instances: [alerting] } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      const [read] = await api.rules()
      expect(read.status.instances[0]).toMatchObject({
        condition: 'alerting',
        level: 'alarm',
        priority: 'alarm'
      })
    })

    it('reads the facts of an alert: its priority and message', async () => {
      const alerting = {
        ...ruleEntry.state.instances[0],
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        step: 1,
        awaitingInput: true,
        message: 'House battery at 11.6 V'
      }
      const { instance: _, ...facts } = alerting
      const entry = {
        ...ruleEntry,
        state: { ...ruleEntry.state, ruleState: 'enabled', ...facts, instances: [alerting] }
      }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      const [read] = await api.rules()
      const expected = {
        condition: 'alerting',
        priority: 'alarm',
        awaitingInput: true,
        message: 'House battery at 11.6 V'
      }
      expect(read.status).toMatchObject(expected)
      expect(read.status.instances[0]).toMatchObject(expected)
    })

    describe('an outside rule', () => {
      const outside = (facts: Record<string, unknown>) => {
        const alerting = {
          ...ruleEntry.state.instances[0],
          condition: 'alerting',
          reason: 'alertActive',
          priority: 'warning',
          step: 0,
          value: 27,
          limit: 25,
          awaitingInput: false,
          ...facts
        }
        const { instance: _, ...status } = alerting
        return {
          ...ruleEntry,
          rule: {
            ...ruleEntry.rule,
            signal: { path: 'navigation.heel' },
            detector: {
              type: 'outside',
              steps: [
                { low: -25, high: 25, priority: 'warning' },
                { low: -35, high: 35, priority: 'alarm' }
              ],
              duration: 10
            }
          },
          state: { ...ruleEntry.state, ruleState: 'enabled', ...status, instances: [alerting] }
        }
      }
      const read = async (facts: Record<string, unknown>) => {
        const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [outside(facts)] } }))
        const [entry] = await api.rules()
        if (isInvalid(entry)) throw new Error('invalid')
        return entry
      }

      it('reads each step’s low and high limit', async () => {
        const entry = await read({ passed: 'high' })
        expect(entry.rule.detector.type).toBe('outside')
        expect(entry.rule.steps).toEqual([
          { low: -25, high: 25, priority: 'warning' },
          { low: -35, high: 35, priority: 'alarm' }
        ])
      })

      it.each(['low', 'high'])('reads the side an alert passed: %s', async (side) => {
        const entry = await read({ passed: side })
        expect(entry.status.passed).toBe(side)
        expect(entry.status.instances[0].passed).toBe(side)
      })

      it('reads an alert without a side', async () => {
        const entry = await read({})
        expect(entry.status).not.toHaveProperty('passed')
        expect(entry.status.limit).toBe(25)
      })

      it.each(['sideways', 1, null])('drops a side that is not low or high: %o', async (side) => {
        const entry = await read({ passed: side })
        expect(entry.status).not.toHaveProperty('passed')
        expect(entry.status.instances[0]).not.toHaveProperty('passed')
      })
    })

    it.each([
      [{ condition: 'normal', reason: 'withinLimits', clearedAt: '2026-09-30T11:00:00.000Z' }],
      [{ condition: 'normal', reason: 'withinLimits', clearSince: '2026-09-30T11:00:00.000Z' }],
      [{ condition: 'noData', reason: 'inputUnavailable', lastSeen: '2026-09-30T11:00:00.000Z' }],
      [{ condition: 'problem', reason: 'missingZone', level: 'alarm', side: 'low', gate: 0 }],
      [
        {
          condition: 'problem',
          reason: 'timeoutNotPossible',
          cause: 'updateContract',
          contract: 'x'
        }
      ],
      [{ condition: 'problem', reason: 'unitsNotRadians', path: 'a.b', units: 'deg' }]
    ])('reads the facts of %o', async (facts) => {
      const entry = { ...ruleEntry, state: { ...ruleEntry.state, ...facts } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      const [read] = await api.rules()
      expect(read.status).toMatchObject(facts)
    })

    it('lists a stored rule that does not run as a problem, named from its body', async () => {
      const invalid = {
        slug: 'coolant-high',
        invalid: {
          errors: [{ path: '/detector/steps/0/priority', message: 'must be a priority' }],
          body: { name: 'Coolant high', slug: 'coolant-high' }
        },
        state: {
          ruleState: 'enabled',
          condition: 'problem',
          reason: 'invalidRule',
          changedAt: '2026-09-30T12:00:00.000Z',
          issues: [],
          errors: [],
          instances: []
        }
      }
      const unnamed = { ...invalid, slug: 'garbled', invalid: { errors: [], body: 'x' } }
      const api = httpApi(
        fakeFetch({ [`${BASE}/rules`]: { body: [notStartedAccumulator, invalid, unnamed] } })
      )
      const [, read, bare] = await api.rules()
      expect(read).toEqual({
        slug: 'coolant-high',
        name: 'Coolant high',
        invalid: invalid.invalid,
        status: { ...invalid.state }
      })
      expect(bare).toMatchObject({ slug: 'garbled', name: 'garbled' })
    })

    it('reads a position value', async () => {
      const position = { latitude: 60.1, longitude: 24.9 }
      const entry = {
        ...ruleEntry,
        state: {
          ...ruleEntry.state,
          instances: [{ ...ruleEntry.state.instances[0], value: position }]
        }
      }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      const [read] = await api.rules()
      expect(read.status.instances[0].value).toEqual(position)
    })

    it('rejects an entry without a slug', async () => {
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [{}] } }))
      await expect(api.rules()).rejects.toThrow(/unexpected response from \/rules/)
    })

    it('rejects a condition the panel does not know', async () => {
      const entry = { ...ruleEntry, state: { ...ruleEntry.state, condition: 'ok' } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules`]: { body: [entry] } }))
      await expect(api.rules()).rejects.toThrow(/unexpected response from \/rules/)
    })
  })

  describe('actions', () => {
    it('resets an accumulator with a JSON request and reads the entry it answers', async () => {
      const fetchFn = fakeFetch({
        [`${BASE}/rules/engine-hours/reset`]: { body: notStartedAccumulator }
      })
      const entry = await httpApi(fetchFn).resetAccumulator('engine-hours')
      expect(entry.slug).toBe('engine-hours')
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(init?.credentials).toBe('same-origin')
    })

    it('escapes the slug in the path', async () => {
      const fetchFn = fakeFetch({
        [`${BASE}/rules/a%2Fb%3F/reset`]: { body: notStartedAccumulator }
      })
      await httpApi(fetchFn).resetAccumulator('a/b?')
      expect(fetchFn).toHaveBeenCalledOnce()
    })

    it('fails with the error the server gives', async () => {
      const api = httpApi(
        fakeFetch({
          [`${BASE}/rules/x/reset`]: {
            status: 400,
            body: { error: 'only an accumulator rule can be reset' }
          }
        })
      )
      await expect(api.resetAccumulator('x')).rejects.toThrow(
        'only an accumulator rule can be reset'
      )
    })

    it('reports an expired session', async () => {
      const denied = { status: 401, body: { error: 'Permission Denied' } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules/x/reset`]: denied }))
      await expect(api.resetAccumulator('x')).rejects.toBeInstanceOf(SessionExpiredError)
    })
  })

  describe('rule authoring', () => {
    const rule = ruleEntry.rule as unknown as Rule

    it('reads the full stored rule of an entry', async () => {
      const fetchFn = fakeFetch({ [`${BASE}/rules/house-battery-low`]: { body: ruleEntry } })
      expect(await httpApi(fetchFn).ruleDefinition('house-battery-low')).toEqual(rule)
    })

    it('rejects an entry whose rule has no signal or detector', async () => {
      const broken = { ...ruleEntry, rule: { name: 'x', slug: 'x' } }
      const api = httpApi(fakeFetch({ [`${BASE}/rules/x`]: { body: broken } }))
      await expect(api.ruleDefinition('x')).rejects.toThrow(/unexpected response/)
    })

    it('creates a rule with a JSON POST and reads the entry it answers', async () => {
      const fetchFn = fakeFetch({ [`${BASE}/rules`]: { status: 201, body: ruleEntry } })
      const entry = await httpApi(fetchFn).createRule(rule)
      expect(entry.slug).toBe('house-battery-low')
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify(rule))
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('replaces a rule with a PUT on its slug', async () => {
      const fetchFn = fakeFetch({ [`${BASE}/rules/house-battery-low`]: { body: ruleEntry } })
      await httpApi(fetchFn).updateRule('house-battery-low', rule)
      expect(fetchFn.mock.calls[0][1]?.method).toBe('PUT')
    })

    it('previews an edit', async () => {
      const preview = {
        restarts: true,
        changes: ['signal'],
        activeAlerts: 1,
        clearsActiveAlert: true,
        discardsTotal: false
      }
      const fetchFn = fakeFetch({
        [`${BASE}/rules/house-battery-low/preview`]: { body: preview }
      })
      expect(await httpApi(fetchFn).previewRule('house-battery-low', rule)).toEqual(preview)
      expect(fetchFn.mock.calls[0][1]?.method).toBe('POST')
    })

    it('carries the field errors of a refused rule', async () => {
      const errors = [{ path: '/detector/steps/0/limit', message: 'must be a number' }]
      const api = httpApi(
        fakeFetch({
          [`${BASE}/rules`]: { status: 400, body: { error: 'invalid request body', errors } }
        })
      )
      const refused = await api.createRule(rule).catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(RuleRejectedError)
      expect((refused as RuleRejectedError).errors).toEqual(errors)
    })

    it('attaches a slug conflict to the slug, naming a timed-out create that saved', async () => {
      const api = httpApi(
        fakeFetch({
          [`${BASE}/rules`]: { status: 409, body: { error: 'a rule with this slug exists' } }
        })
      )
      const refused = await api.createRule(rule).catch((err: unknown) => err)
      const errors = (refused as RuleRejectedError).errors
      expect(errors.map((e) => e.path)).toEqual(['/slug'])
      expect(errors[0]?.message).toMatch(/is taken/)
      expect(errors[0]?.message).toMatch(/earlier attempt.*timed out.*may have saved this rule/)
    })
  })

  describe('controls', () => {
    it('disables a rule with its note and reads the entry it answers', async () => {
      const fetchFn = fakeFetch({
        [`${BASE}/rules/house-battery-low/disable`]: { body: ruleEntry }
      })
      const entry = await httpApi(fetchFn).disableRule('house-battery-low', 'new sender')
      expect(entry.disabled?.note).toBe('Sender replaced in spring')
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ note: 'new sender' }))
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('enables a rule with a bodiless JSON request and reads the entry it answers', async () => {
      const { disabled: _disabled, ...enabled } = ruleEntry
      const fetchFn = fakeFetch({
        [`${BASE}/rules/house-battery-low/enable`]: { body: enabled }
      })
      const entry = await httpApi(fetchFn).enableRule('house-battery-low')
      expect(entry.disabled).toBeUndefined()
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('deletes a rule with a bodiless JSON DELETE on its slug', async () => {
      const fetchFn = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status: 204 }))
      )
      await httpApi(fetchFn).deleteRule('house battery')
      const [url, init] = fetchFn.mock.calls[0]
      expect(url).toBe(`${BASE}/rules/house%20battery`)
      expect(init?.method).toBe('DELETE')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it("fails a delete with the server's message", async () => {
      const fetchFn = fakeFetch({
        [`${BASE}/rules/gone`]: { status: 404, body: { error: 'no such rule' } }
      })
      await expect(httpApi(fetchFn).deleteRule('gone')).rejects.toThrow('no such rule')
    })
  })
  describe('templates', () => {
    const lifepo4 = {
      id: 'battery-voltage-low-lifepo4',
      description: 'A LiFePO4 bank stays low.',
      open: ['instance'],
      condition: 'voltageLow',
      rule: { name: 'Battery ${instance} voltage low', signal: { path: 'a.${instance}.b' } }
    }
    const listing = {
      sets: [
        {
          id: 'builtin',
          name: 'Alert Rules',
          version: '1.0.0',
          source: 'built-in',
          templates: [lifepo4],
          new: ['battery-voltage-low-lifepo4']
        }
      ],
      problems: [{ source: 'file broken.yaml', message: '/id: is required' }]
    }

    it('reads the sets with their templates and the new ones, and the sets that failed', async () => {
      const read = await httpApi(
        fakeFetch({ [`${BASE}/templates`]: { body: listing } })
      ).templates()
      expect(read).toEqual(listing)
    })

    it('rejects a set without its templates', async () => {
      const { templates: _templates, ...bare } = listing.sets[0] ?? {}
      const api = httpApi(fakeFetch({ [`${BASE}/templates`]: { body: { sets: [bare] } } }))
      await expect(api.templates()).rejects.toThrow('unexpected response from')
    })

    it('dismisses the templates shown with a JSON POST and reads the listing it answers', async () => {
      const fetchFn = fakeFetch({ [`${BASE}/templates/dismiss`]: { body: listing } })
      const read = await httpApi(fetchFn).dismissTemplates({ builtin: ['a', 'b'] })
      expect(read.sets).toHaveLength(1)
      const [, init] = fetchFn.mock.calls[0]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ templates: { builtin: ['a', 'b'] } }))
    })
  })
})
