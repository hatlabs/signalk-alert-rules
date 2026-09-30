import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Plugin } from '@signalk/server-api'
import createPlugin from '../../src/index.js'
import { Store } from '../../src/store/store.js'
import { FakeAlertsCore } from '../helpers/FakeAlertsCore.js'
import { MockServerAPI } from '../helpers/MockServerAPI.js'

const BASE = '/plugins/signalk-alert-rules'
const OIL = 'propulsion.main.oilPressure'
const RPM = 'propulsion.main.revolutions'
const OIL_ALERT = 'rules.user.oil-pressure-low'

const oil = {
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  priority: 'alarm',
  signal: { path: OIL },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'fixed', value: 100000 },
    duration: 5
  }
}
const coolant = {
  name: 'Coolant high',
  slug: 'coolant-high',
  message: 'Coolant high on {instance}',
  priority: 'alarm',
  signal: { path: 'propulsion.*.coolantTemperature' },
  detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } },
  gates: [
    {
      signal: { path: 'propulsion.*.revolutions' },
      direction: 'above',
      limit: { kind: 'fixed', value: 8 }
    }
  ]
}
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  priority: 'warning',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', limit: 10 }
}

interface Reply {
  status: number
  body: unknown
}

interface Harness {
  mock: MockServerAPI
  plugin: Plugin
  call: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ) => Promise<Reply>
  /** Stops the plugin and starts a new instance on the same data directory and core, as a server restart does. */
  restart: () => Promise<void>
  /** The authenticated user the server puts on each request; undefined for none. */
  user: string | undefined
}

let dir: string
let servers: Server[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-api-'))
  servers = []
  // Real timeouts stay, which the HTTP client needs.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
  rmSync(dir, { recursive: true, force: true })
})

function storeRule(rule: { slug: string }): void {
  mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
}

/**
 * Mounts the plugin's router the way the server does: bodies parsed by the
 * server before any plugin route (signalk-server src/index.ts, JSON and
 * urlencoded), the authenticated user on the request, and the router under
 * `/plugins/<id>`.
 */
async function serve(options: { withAlerts?: boolean; start?: boolean } = {}): Promise<Harness> {
  const core = new FakeAlertsCore()
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  let current: { plugin: Plugin; mock: MockServerAPI } | undefined
  const harness: Harness = {
    user: 'admin',
    get mock() {
      if (current === undefined) throw new Error('no plugin')
      return current.mock
    },
    get plugin() {
      if (current === undefined) throw new Error('no plugin')
      return current.plugin
    },
    call: async (method, path, body, headers = { 'content-type': 'application/json' }) => {
      const port = (server.address() as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${String(port)}${BASE}${path}`, {
        method,
        headers,
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      })
      const text = await response.text()
      return {
        status: response.status,
        body: text === '' ? undefined : (JSON.parse(text) as unknown)
      }
    },
    restart: async () => {
      await current?.plugin.stop()
      mount()
    }
  }
  app.use((req, _res, next) => {
    if (harness.user !== undefined) {
      Object.assign(req, { skPrincipal: { identifier: harness.user, permissions: 'admin' } })
    }
    next()
  })
  // The server builds a new router per plugin registration; a restart reuses it.
  let routed: express.Router | undefined
  app.use(BASE, (req, res, next) => {
    if (routed === undefined) next()
    else routed(req, res, next)
  })
  const mount = () => {
    const mock = new MockServerAPI(options.withAlerts ?? true, dir, core)
    const plugin = createPlugin(mock.asServerAPI())
    const router = express.Router()
    plugin.registerWithRouter?.(
      Object.assign(router, {
        access: () => {
          throw new Error('every SKAR route stays admin-only')
        }
      })
    )
    routed = router
    current = { plugin, mock }
    if (options.start ?? true) plugin.start({}, () => undefined)
  }
  mount()
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s)
    })
  })
  servers.push(server)
  return harness
}

const at = (seconds: number) => {
  vi.advanceTimersByTime(seconds * 1000)
}

function core(h: Harness) {
  return h.mock.core
}

describe('REST API', () => {
  it('creating a rule persists it and starts evaluation without restarting others', async () => {
    storeRule(oil)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(3)

    const created = await h.call('POST', '/rules', { ...coolant, gates: undefined })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ origin: 'user', slug: 'coolant-high' })
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(true)

    // The oil rule's timer kept running: it raises 5 s after its value.
    at(1)
    expect(core(h).list()).toEqual([])
    at(1)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)

    h.mock.subscriptionmanager.publish('propulsion.port.coolantTemperature', 'src', 380)
    expect(core(h).getByPath('rules.user.coolant-high.port')?.condition).toBe(true)
    const list = await h.call('GET', '/rules')
    expect((list.body as { slug: string }[]).map((r) => r.slug)).toEqual([
      'oil-pressure-low',
      'coolant-high'
    ])
  })

  it('rejects an invalid rule with field-path errors and persists nothing', async () => {
    const h = await serve()
    const reply = await h.call('POST', '/rules', { ...oil, priority: 'loud' })
    expect(reply.status).toBe(400)
    const errors = (reply.body as { errors: { path: string }[] }).errors
    expect(errors.map((e) => e.path)).toContain('/priority')
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(false)
  })

  it('rejects a mutating request without a JSON content type', async () => {
    storeRule(oil)
    storeRule(hours)
    const h = await serve()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const text = { 'content-type': 'text/plain' }
    const replies = await Promise.all([
      h.call('POST', '/rules', 'name=x&slug=x', form),
      h.call('POST', '/rules', JSON.stringify(coolant), text),
      h.call('PUT', '/rules/user/oil-pressure-low', 'message=x', form),
      h.call('POST', '/rules/user/oil-pressure-low/preview', 'message=x', form),
      h.call('DELETE', '/rules/user/oil-pressure-low', undefined, {}),
      h.call('POST', '/rules/user/engine-hours/reset', undefined, {}),
      h.call('PUT', '/evaluation', 'enabled=false', form)
    ])
    expect(replies.map((r) => r.status)).toEqual([415, 415, 415, 415, 415, 415, 415])
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(true)
    expect(new Store(dir).load().evaluation).toEqual({ enabled: true })
  })

  it('accepts a bodiless mutating request that declares JSON', async () => {
    storeRule(oil)
    const h = await serve()
    const reply = await h.call('DELETE', '/rules/user/oil-pressure-low')
    expect(reply.status).toBe(204)
  })

  it('reports a wildcard rule with one instance active and one gated off', async () => {
    storeRule(coolant)
    const h = await serve()
    const sm = h.mock.subscriptionmanager
    sm.publish('propulsion.port.revolutions', 'src', 30)
    sm.publish('propulsion.starboard.revolutions', 'src', 0)
    sm.publish('propulsion.port.coolantTemperature', 'src', 370)
    sm.publish('propulsion.starboard.coolantTemperature', 'src', 371)

    const reply = await h.call('GET', '/rules/user/coolant-high')
    expect(reply.status).toBe(200)
    const entry = reply.body as {
      rule: unknown
      status: { instances: { instance: { name: string } }[] }
    }
    expect(entry).toMatchObject({
      origin: 'user',
      slug: 'coolant-high',
      rule: coolant,
      status: { badge: 'alertActive', subLabels: [], errors: [], issues: [] }
    })
    const byName = new Map(entry.status.instances.map((i) => [i.instance.name, i]))
    expect(byName.get('port')).toMatchObject({
      badge: 'alertActive',
      subLabels: [],
      active: true,
      value: 370,
      limit: 368,
      gates: [{ holds: true, input: 'value' }]
    })
    expect(byName.get('starboard')).toMatchObject({
      badge: 'gatedOff',
      active: false,
      value: 371,
      gates: [{ holds: false, input: 'value' }]
    })
  })

  it("an accumulator reset clears the rule's active alert, zeroes the value and records the actor", async () => {
    storeRule(hours)
    const h = await serve()
    h.mock.subscriptionmanager.publish(RPM, 'src', 30)
    at(10)
    expect(core(h).getByPath('rules.user.engine-hours')?.condition).toBe(true)

    h.user = 'skipper'
    const reply = await h.call('POST', '/rules/user/engine-hours/reset')
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      status: {
        badge: 'idle',
        instances: [{ active: false, progress: { kind: 'total', total: 0 } }]
      }
    })
    expect(core(h).getByPath('rules.user.engine-hours')?.condition).toBe(false)
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 0 } })
    const log = await h.call('GET', '/log')
    expect(log.body).toEqual([
      {
        at: expect.any(String) as unknown,
        actor: 'skipper',
        action: 'reset',
        rule: 'user.engine-hours'
      }
    ])
  })

  it('clear all turns evaluation off, clears every owned alert and records the actor', async () => {
    storeRule(oil)
    storeRule(hours)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    h.mock.subscriptionmanager.publish(RPM, 'src', 30)
    at(10)
    expect(
      core(h)
        .list()
        .filter((a) => a.condition)
    ).toHaveLength(2)

    const reply = await h.call('PUT', '/evaluation', { enabled: false })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ enabled: false, actor: 'admin' })
    expect(
      core(h)
        .list()
        .filter((a) => a.condition)
    ).toEqual([])
    expect((await h.call('GET', '/evaluation')).body).toEqual(reply.body)
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'admin', action: 'evaluation', enabled: false }
    ])
    const rules = await h.call('GET', '/rules')
    expect((rules.body as { status: unknown }[]).map((r) => r.status)).toMatchObject([
      { badge: 'disabled', reason: 'evaluation is off' },
      { badge: 'disabled', reason: 'evaluation is off' }
    ])

    const on = await h.call('PUT', '/evaluation', { enabled: true })
    expect(on.body).toMatchObject({ enabled: true, actor: 'admin' })
    at(5)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
  })

  it('evaluation off survives a plugin restart', async () => {
    storeRule(oil)
    const h = await serve()
    await h.call('PUT', '/evaluation', { enabled: false })
    await h.restart()

    expect((await h.call('GET', '/evaluation')).body).toMatchObject({ enabled: false })
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(60)
    expect(core(h).list()).toEqual([])
  })

  it('previews a clearing edit and a non-clearing one', async () => {
    storeRule(oil)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(5)

    const retyped = { ...oil, detector: { type: 'match', op: 'equals', value: 0 } }
    const clearing = await h.call('POST', '/rules/user/oil-pressure-low/preview', retyped)
    expect(clearing.status).toBe(200)
    expect(clearing.body).toMatchObject({
      restarts: true,
      activeAlerts: 1,
      clearsActiveAlert: true
    })
    expect((clearing.body as { changes: string[] }).changes).toContain('detector.type')

    const limit = { ...oil, detector: { ...oil.detector, limit: { kind: 'fixed', value: 90000 } } }
    const inPlace = await h.call('POST', '/rules/user/oil-pressure-low/preview', limit)
    expect(inPlace.body).toEqual({
      restarts: false,
      changes: [],
      activeAlerts: 1,
      clearsActiveAlert: false,
      discardsTotal: false
    })
    // Neither preview applied anything.
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    expect(new Store(dir).load().rules[0]?.value).toEqual(oil)
  })

  it('replaces a rule, and deletes it with its alert and the actor', async () => {
    storeRule(oil)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(5)

    const replaced = await h.call('PUT', '/rules/user/oil-pressure-low', {
      ...oil,
      message: 'Check the oil'
    })
    expect(replaced.status).toBe(200)
    expect(replaced.body).toMatchObject({ rule: { message: 'Check the oil' } })

    h.user = undefined
    expect((await h.call('DELETE', '/rules/user/oil-pressure-low')).status).toBe(204)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'unauthenticated', action: 'delete', rule: 'user.oil-pressure-low' }
    ])
  })

  it('answers the error paths', async () => {
    storeRule(oil)
    const h = await serve()
    const statuses = await Promise.all([
      h.call('GET', '/rules/user/missing'),
      h.call('GET', '/rules/some-ruleset/oil-pressure-low'),
      h.call('PUT', '/rules/user/missing', { ...oil, slug: 'missing' }),
      h.call('POST', '/rules/user/missing/preview', { ...oil, slug: 'missing' }),
      h.call('DELETE', '/rules/user/missing'),
      h.call('POST', '/rules/user/missing/reset'),
      h.call('POST', '/rules', oil),
      h.call('PUT', '/rules/user/oil-pressure-low', { ...oil, slug: 'other' }),
      h.call('POST', '/rules/user/oil-pressure-low/preview', { ...oil, slug: 'other' }),
      h.call('POST', '/rules/user/oil-pressure-low/reset'),
      h.call('PUT', '/evaluation', { enabled: 'no' }),
      h.call('PUT', '/rules/user/oil-pressure-low', { ...oil, priority: 'loud' })
    ])
    expect(statuses.map((r) => r.status)).toEqual([
      404, 404, 404, 404, 404, 404, 409, 400, 400, 400, 400, 400
    ])
    expect(statuses[7].body).toMatchObject({ errors: [{ path: '/slug' }] })
    expect(statuses[10].body).toMatchObject({ errors: [{ path: '/enabled' }] })
    expect((await h.call('GET', '/log')).body).toEqual([])
  })

  it('reports the plugin state, including whether server security is enabled', async () => {
    const h = await serve()
    expect((await h.call('GET', '/state')).body).toEqual({
      running: true,
      securityEnabled: null,
      evaluation: { enabled: true },
      issues: []
    })
    Object.assign(h.mock, { securityStrategy: { isDummy: () => true } })
    expect((await h.call('GET', '/state')).body).toMatchObject({ securityEnabled: false })
    Object.assign(h.mock, { securityStrategy: { isDummy: () => false } })
    expect((await h.call('GET', '/state')).body).toMatchObject({ securityEnabled: true })
  })

  it('answers 503 on every route but the state while the plugin is not running', async () => {
    const h = await serve({ withAlerts: false })
    expect((await h.call('GET', '/state')).body).toEqual({
      running: false,
      error: 'This server has no alerts API; rules cannot be evaluated',
      securityEnabled: null
    })
    const replies = await Promise.all([
      h.call('GET', '/rules'),
      h.call('POST', '/rules', oil),
      h.call('GET', '/evaluation'),
      h.call('GET', '/log')
    ])
    expect(replies.map((r) => r.status)).toEqual([503, 503, 503, 503])
    await h.plugin.stop()
    expect((await h.call('GET', '/rules')).status).toBe(503)
  })

  it('answers 500 with the reason when the store cannot write, and applies nothing', async () => {
    const h = await serve()
    // A directory where the rule file belongs makes the rename fail.
    mkdirSync(join(dir, 'rules', 'oil-pressure-low.json', 'blocker'), { recursive: true })
    const reply = await h.call('POST', '/rules', oil)
    expect(reply.status).toBe(500)
    expect(reply.body).toMatchObject({ error: expect.any(String) as unknown })
    expect((await h.call('GET', '/rules')).body).toEqual([])
  })
})

describe('rule controls API', () => {
  const RULE = '/rules/user/oil-pressure-low'
  const RULE_SUPPRESSION = '/suppressions/rules/user/oil-pressure-low'
  const INPUT_SUPPRESSION = `/suppressions/inputs/${OIL}`

  async function alerting(): Promise<Harness> {
    storeRule(oil)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(5)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    return h
  }

  it('disables and enables a rule, answering its entry and recording the actor', async () => {
    const h = await alerting()
    const off = await h.call('PUT', `${RULE}/enabled`, { enabled: false })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({
      enabled: false,
      status: { badge: 'disabled', reason: 'disabled' }
    })
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)

    const on = await h.call('PUT', `${RULE}/enabled`, { enabled: true })
    expect(on.body).toMatchObject({ enabled: true })
    at(5)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'admin', action: 'enable', rule: 'user.oil-pressure-low' },
      { actor: 'admin', action: 'disable', rule: 'user.oil-pressure-low' }
    ])
  })

  it('sets a rule note', async () => {
    storeRule(oil)
    const h = await serve()
    const reply = await h.call('PUT', `${RULE}/note`, { note: 'sender replaced in spring' })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ note: 'sender replaced in spring' })
    expect((await h.call('GET', RULE)).body).toMatchObject({ note: 'sender replaced in spring' })
  })

  it('suppresses a rule, lists the suppression and ends it', async () => {
    const h = await alerting()
    const reply = await h.call('PUT', RULE_SUPPRESSION, {
      note: 'faulty sender',
      autoEndAfter: 600
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      suppression: { actor: 'admin', note: 'faulty sender', autoEndAfter: 600 },
      status: { badge: 'suppressed', subLabels: ['waitingForClear'] }
    })
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)
    expect((await h.call('GET', '/suppressions')).body).toEqual([
      {
        scope: 'rule',
        rule: 'user.oil-pressure-low',
        since: expect.any(String) as unknown,
        actor: 'admin',
        note: 'faulty sender',
        autoEndAfter: 600
      }
    ])

    expect((await h.call('DELETE', RULE_SUPPRESSION)).status).toBe(204)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    expect((await h.call('GET', '/suppressions')).body).toEqual([])
  })

  it('suppresses an input path, previews it and ends it', async () => {
    const h = await alerting()
    const preview = await h.call('GET', `${INPUT_SUPPRESSION}/preview`)
    expect(preview.body).toEqual({
      path: OIL,
      suppresses: [{ rule: 'user.oil-pressure-low' }],
      freezes: []
    })
    h.user = undefined
    const reply = await h.call('PUT', INPUT_SUPPRESSION, {})
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      scope: 'input',
      path: OIL,
      since: expect.any(String) as unknown,
      actor: 'unauthenticated'
    })
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)
    expect((await h.call('DELETE', INPUT_SUPPRESSION)).status).toBe(204)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
  })

  it('suppressions survive a plugin restart', async () => {
    const h = await alerting()
    await h.call('PUT', RULE_SUPPRESSION, {})
    await h.call('PUT', INPUT_SUPPRESSION, {})
    await h.restart()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(10)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)
    expect((await h.call('GET', '/suppressions')).body).toMatchObject([
      { scope: 'rule', rule: 'user.oil-pressure-low' },
      { scope: 'input', path: OIL }
    ])
  })

  it('answers the error paths', async () => {
    storeRule(oil)
    const h = await serve()
    const replies = await Promise.all([
      h.call('PUT', '/rules/user/missing/enabled', { enabled: false }),
      h.call('PUT', '/rules/some-ruleset/oil-pressure-low/note', { note: 'x' }),
      h.call('PUT', '/suppressions/rules/user/missing', {}),
      h.call('DELETE', '/suppressions/rules/user/missing'),
      h.call('PUT', `${RULE}/enabled`, { enabled: 'no' }),
      h.call('PUT', `${RULE}/note`, { note: 5 }),
      h.call('PUT', `${RULE}/note`, { note: 'x'.repeat(501) }),
      h.call('PUT', RULE_SUPPRESSION, { autoEndAfter: -1 }),
      h.call('PUT', RULE_SUPPRESSION, { autoEnd: 60 }),
      h.call('PUT', RULE_SUPPRESSION, []),
      h.call('PUT', '/suppressions/inputs/propulsion.*.oilPressure', {}),
      h.call('PUT', '/suppressions/inputs/propulsion..oilPressure', {}),
      h.call('GET', '/suppressions/inputs/propulsion.*.oilPressure/preview')
    ])
    expect(replies.map((r) => r.status)).toEqual([
      404, 404, 404, 404, 400, 400, 400, 400, 400, 400, 400, 400, 400
    ])
    expect(replies[3].body).toEqual({ error: 'no such rule' })
    expect(replies[4].body).toMatchObject({ errors: [{ path: '/enabled' }] })
    expect(replies[5].body).toMatchObject({ errors: [{ path: '/note' }] })
    expect(replies[7].body).toMatchObject({ errors: [{ path: '/autoEndAfter' }] })
    expect(replies[8].body).toMatchObject({ errors: [{ path: '/autoEnd' }] })
    expect(replies[10].body).toMatchObject({ errors: [{ path: '/path' }] })
    expect((await h.call('GET', '/log')).body).toEqual([])
  })

  it('ending a suppression that is not in force answers 204 and records nothing', async () => {
    storeRule(oil)
    const h = await serve()
    expect((await h.call('DELETE', RULE_SUPPRESSION)).status).toBe(204)
    expect((await h.call('DELETE', INPUT_SUPPRESSION)).status).toBe(204)
    expect((await h.call('GET', '/log')).body).toEqual([])
  })

  it('rejects every control change without a JSON content type', async () => {
    storeRule(oil)
    const h = await serve()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const replies = await Promise.all([
      h.call('PUT', `${RULE}/enabled`, 'enabled=false', form),
      h.call('PUT', `${RULE}/note`, 'note=x', form),
      h.call('PUT', RULE_SUPPRESSION, 'note=x', form),
      h.call('DELETE', RULE_SUPPRESSION, undefined, {}),
      h.call('PUT', INPUT_SUPPRESSION, 'note=x', form),
      h.call('DELETE', INPUT_SUPPRESSION, undefined, {})
    ])
    expect(replies.map((r) => r.status)).toEqual([415, 415, 415, 415, 415, 415])
    expect(existsSync(join(dir, 'controls.json'))).toBe(false)
  })

  it('answers 503 while the plugin is not running', async () => {
    const h = await serve({ withAlerts: false })
    const replies = await Promise.all([
      h.call('GET', '/suppressions'),
      h.call('PUT', `${RULE}/enabled`, { enabled: false }),
      h.call('PUT', INPUT_SUPPRESSION, {}),
      h.call('GET', `${INPUT_SUPPRESSION}/preview`)
    ])
    expect(replies.map((r) => r.status)).toEqual([503, 503, 503, 503])
  })
})
