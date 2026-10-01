import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** The server's config directory, where it installs plugins with npm. */
let configDir: string
/** The plugin's data directory, laid out under the config directory as the server lays it out. */
let dir: string
let servers: Server[]

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'skar-api-'))
  dir = join(configDir, 'plugin-config-data', 'signalk-alert-rules')
  mkdirSync(dir, { recursive: true })
  servers = []
  // Real timeouts stay, which the HTTP client needs.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
  rmSync(configDir, { recursive: true, force: true })
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
      // Express answers a route it does not have with an HTML page.
      const json = response.headers.get('content-type')?.includes('json') === true
      return {
        status: response.status,
        body: text === '' ? undefined : json ? (JSON.parse(text) as unknown) : text
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
      h.call('POST', '/rules/user/engine-hours/reset', undefined, {})
    ])
    expect(replies.map((r) => r.status)).toEqual([415, 415, 415, 415, 415, 415])
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(true)
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
    expect(new Store(dir).load().accumulators).toEqual({
      'user.engine-hours': { measure: 'time', totals: { '': 0 } }
    })
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

  it('has no evaluation switch', async () => {
    const h = await serve()
    const replies = await Promise.all([
      h.call('GET', '/evaluation'),
      h.call('PUT', '/evaluation', { enabled: false })
    ])
    expect(replies.map((r) => r.status)).toEqual([404, 404])
  })

  it('starts on a data directory whose log has evaluation entries, and lists the others', async () => {
    const reset = {
      at: '2026-09-30T12:00:00.000Z',
      actor: 'admin',
      action: 'reset',
      rule: 'user.engine-hours'
    }
    writeFileSync(
      join(dir, 'log.json'),
      JSON.stringify([
        reset,
        { at: reset.at, actor: 'admin', action: 'evaluation', enabled: false }
      ])
    )
    const h = await serve()
    expect((await h.call('GET', '/state')).body).toMatchObject({ running: true, issues: [] })
    expect((await h.call('GET', '/log')).body).toEqual([reset])
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
      h.call('PUT', '/rules/user/oil-pressure-low', { ...oil, priority: 'loud' })
    ])
    expect(statuses.map((r) => r.status)).toEqual([
      404, 404, 404, 404, 404, 404, 409, 400, 400, 400, 400
    ])
    expect(statuses[7].body).toMatchObject({ errors: [{ path: '/slug' }] })
    expect((await h.call('GET', '/log')).body).toEqual([])
  })

  it('reports the plugin state, including whether server security is enabled', async () => {
    const h = await serve()
    expect((await h.call('GET', '/state')).body).toEqual({
      running: true,
      securityEnabled: null,
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
      h.call('GET', '/log')
    ])
    expect(replies.map((r) => r.status)).toEqual([503, 503, 503])
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

  async function alerting(): Promise<Harness> {
    storeRule(oil)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(5)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    return h
  }

  it('disables a rule with a note and enables it, answering its entry and recording the actor', async () => {
    const h = await alerting()
    const off = await h.call('POST', `${RULE}/disable`, { note: 'paddlewheel fouled' })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({
      disabled: { actor: 'admin', note: 'paddlewheel fouled' },
      status: { badge: 'disabled', instances: [{ conditionPresent: true }] }
    })
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)

    const on = await h.call('POST', `${RULE}/enable`)
    expect(on.status).toBe(200)
    expect(on.body).not.toHaveProperty('disabled')
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'admin', action: 'enable', rule: 'user.oil-pressure-low' },
      {
        actor: 'admin',
        action: 'disable',
        rule: 'user.oil-pressure-low',
        note: 'paddlewheel fouled'
      }
    ])
  })

  it('disables a rule without a body or a note, recording an unauthenticated actor', async () => {
    storeRule(oil)
    const h = await serve()
    h.user = undefined
    const reply = await h.call('POST', `${RULE}/disable`)
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ disabled: { actor: 'unauthenticated' } })
    expect((reply.body as { disabled: object }).disabled).not.toHaveProperty('note')
  })

  it('the disabled state and its note survive a plugin restart', async () => {
    const h = await alerting()
    await h.call('POST', `${RULE}/disable`, { note: 'paddlewheel fouled' })
    await h.restart()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(10)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)
    expect((await h.call('GET', RULE)).body).toMatchObject({
      disabled: { note: 'paddlewheel fouled' }
    })
  })

  it('answers the error paths', async () => {
    storeRule(oil)
    const h = await serve()
    const replies = await Promise.all([
      h.call('POST', '/rules/user/missing/disable', {}),
      h.call('POST', '/rules/some-ruleset/oil-pressure-low/enable'),
      h.call('POST', `${RULE}/disable`, { note: 5 }),
      h.call('POST', `${RULE}/disable`, { note: 'x'.repeat(501) }),
      h.call('POST', `${RULE}/disable`, { reason: 'x' }),
      h.call('POST', `${RULE}/disable`, [])
    ])
    expect(replies.map((r) => r.status)).toEqual([404, 404, 400, 400, 400, 400])
    expect(replies[0].body).toEqual({ error: 'no such rule' })
    expect(replies[2].body).toMatchObject({ errors: [{ path: '/note' }] })
    expect(replies[4].body).toMatchObject({ errors: [{ path: '/reason' }] })
    expect((await h.call('GET', '/log')).body).toEqual([])
  })

  it('takes a note of at most 500 characters', async () => {
    storeRule(oil)
    const h = await serve()
    const reply = await h.call('POST', `${RULE}/disable`, { note: 'x'.repeat(500) })
    expect(reply.status).toBe(200)
  })

  it('rejects every control change without a JSON content type', async () => {
    storeRule(oil)
    const h = await serve()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const replies = await Promise.all([
      h.call('POST', `${RULE}/disable`, 'note=x', form),
      h.call('POST', `${RULE}/enable`, undefined, {})
    ])
    expect(replies.map((r) => r.status)).toEqual([415, 415])
    expect(existsSync(join(dir, 'controls.json'))).toBe(false)
  })

  it('has no enabled-flag, note or suppression routes', async () => {
    storeRule(oil)
    const h = await serve()
    const replies = await Promise.all([
      h.call('PUT', `${RULE}/enabled`, { enabled: false }),
      h.call('PUT', `${RULE}/note`, { note: 'x' }),
      h.call('GET', '/suppressions'),
      h.call('PUT', '/suppressions/rules/user/oil-pressure-low', {})
    ])
    expect(replies.map((r) => r.status)).toEqual([404, 404, 404, 404])
  })

  it('answers 503 while the plugin is not running', async () => {
    const h = await serve({ withAlerts: false })
    const replies = await Promise.all([
      h.call('POST', `${RULE}/disable`, {}),
      h.call('POST', `${RULE}/enable`)
    ])
    expect(replies.map((r) => r.status)).toEqual([503, 503])
  })
})

describe('rulesets API', () => {
  const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '../../examples/ruleset-example')
  const HOUSE_VOLTAGE = 'electrical.batteries.house.voltage'
  const LOW_ALERT = 'rules.batteries.low'

  /** Records an installed package in the config package.json, as the server's npm install does. */
  function list(name: string): void {
    const file = join(configDir, 'package.json')
    const pkg = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as { dependencies: Record<string, string> })
      : { dependencies: {} }
    pkg.dependencies[name] = '*'
    writeFileSync(file, JSON.stringify(pkg))
  }

  function installExample(): void {
    cpSync(EXAMPLE, join(configDir, 'node_modules', 'signalk-alert-ruleset-example'), {
      recursive: true
    })
    list('signalk-alert-ruleset-example')
  }

  /** A provider package whose ruleset has the given rules, each a sustained rule on its own path. */
  function installProvider(version: string, slugs: string[]): void {
    const pkg = join(configDir, 'node_modules', 'provider')
    mkdirSync(pkg, { recursive: true })
    list('provider')
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'provider',
        version,
        keywords: ['signalk-alert-ruleset'],
        'signalk-alert-ruleset': 'ruleset.yaml'
      })
    )
    const rules = slugs.flatMap((slug) => [
      `  - name: ${slug}`,
      `    slug: ${slug}`,
      `    message: ${slug}`,
      '    priority: warning',
      `    signal: { path: test.${slug} }`,
      '    detector: { type: sustained, direction: above, limit: { kind: fixed, value: 1 } }'
    ])
    writeFileSync(
      join(pkg, 'ruleset.yaml'),
      ['name: Provided', 'slug: provided', `version: "${version}"`, 'rules:', ...rules].join('\n')
    )
  }

  it('lists a package ruleset disabled, then enables and tunes it, recording the actor', async () => {
    installExample()
    const h = await serve()
    h.mock.subscriptionmanager.publish(HOUSE_VOLTAGE, 'src', 11)

    const listed = await h.call('GET', '/rulesets')
    expect(listed).toMatchObject({
      status: 200,
      body: {
        rulesets: [
          {
            slug: 'batteries',
            source: 'package signalk-alert-ruleset-example',
            package: { name: 'signalk-alert-ruleset-example', version: '1.0.0' },
            enabled: false,
            values: {},
            rules: ['low'],
            missingPaths: [],
            notices: []
          }
        ],
        problems: []
      }
    })

    const tuned = await h.call('PUT', '/rulesets/batteries/parameters', { delay: 5 })
    expect(tuned).toMatchObject({ status: 200, body: { values: { delay: 5 } } })
    const enabled = await h.call('PUT', '/rulesets/batteries/enabled', { enabled: true })
    expect(enabled).toMatchObject({ status: 200, body: { enabled: true } })

    at(4)
    expect(core(h).list()).toEqual([])
    at(1)
    expect(core(h).getByPath(LOW_ALERT)?.condition).toBe(true)

    const rule = await h.call('GET', '/rules/batteries/low')
    expect(rule.body).toMatchObject({
      origin: 'batteries',
      ruleset: {
        name: 'Battery monitoring',
        version: '1.0.0',
        package: { name: 'signalk-alert-ruleset-example', version: '1.0.0' }
      },
      status: { badge: 'alertActive' }
    })
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'admin', action: 'enable', ruleset: 'batteries' },
      { actor: 'admin', action: 'parameters', ruleset: 'batteries' }
    ])
  })

  it('a ruleset installed after start appears after a rescan without restarting other rules', async () => {
    storeRule(oil)
    const h = await serve()
    h.mock.subscriptionmanager.publish(OIL, 'src', 0)
    at(3)

    installExample()
    mkdirSync(join(dir, 'rulesets'))
    writeFileSync(join(dir, 'rulesets', 'broken.yaml'), 'name: Broken\nrules: [\n')
    const rescanned = await h.call('POST', '/rulesets/rescan')

    expect(rescanned).toMatchObject({
      status: 200,
      body: {
        rulesets: [{ slug: 'batteries', enabled: false }],
        problems: [{ source: 'file broken.yaml', line: expect.any(Number) as number }]
      }
    })
    at(1)
    expect(core(h).list()).toEqual([])
    at(1)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)
    expect((await h.call('GET', '/log')).body).toMatchObject([{ actor: 'admin', action: 'rescan' }])
  })

  it('an upgrade clears a removed rule; its notice survives a restart until dismissed', async () => {
    installProvider('1', ['kept', 'removed'])
    const h = await serve()
    h.mock.subscriptionmanager.publish('test.kept', 'src', 2)
    h.mock.subscriptionmanager.publish('test.removed', 'src', 2)
    await h.call('PUT', '/rulesets/provided/enabled', { enabled: true })
    at(1)
    expect(core(h).getByPath('rules.provided.removed')?.condition).toBe(true)

    installProvider('2', ['kept'])
    await h.call('POST', '/rulesets/rescan')
    expect(core(h).getByPath('rules.provided.removed')?.condition).toBe(false)
    expect(core(h).getByPath('rules.provided.kept')?.condition).toBe(true)

    await h.restart()
    expect((await h.call('GET', '/rulesets')).body).toMatchObject({
      rulesets: [
        {
          version: '2',
          enabled: true,
          notices: [{ message: expect.stringContaining('rule removed') as string }]
        }
      ]
    })

    expect((await h.call('DELETE', '/rulesets/provided/notices')).status).toBe(204)
    expect((await h.call('GET', '/rulesets')).body).toMatchObject({
      rulesets: [{ notices: [] }]
    })
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'admin', action: 'dismiss', ruleset: 'provided' },
      { actor: 'admin', action: 'rescan' },
      { actor: 'admin', action: 'enable', ruleset: 'provided' }
    ])
  })

  it('answers the error paths', async () => {
    installExample()
    const h = await serve()
    const replies = await Promise.all([
      h.call('PUT', '/rulesets/nope/enabled', { enabled: true }),
      h.call('PUT', '/rulesets/nope/parameters', {}),
      h.call('DELETE', '/rulesets/nope/notices'),
      h.call('PUT', '/rulesets/batteries/enabled', { enabled: 'yes' }),
      h.call('PUT', '/rulesets/batteries/parameters', { lowVoltage: 20 })
    ])
    expect(replies.map((r) => r.status)).toEqual([404, 404, 404, 400, 400])
    expect(replies[4].body).toMatchObject({ errors: [{ path: '/lowVoltage' }] })
  })

  it('rejects every ruleset change without a JSON content type', async () => {
    installExample()
    const h = await serve()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const replies = await Promise.all([
      h.call('POST', '/rulesets/rescan', undefined, {}),
      h.call('PUT', '/rulesets/batteries/enabled', 'enabled=true', form),
      h.call('PUT', '/rulesets/batteries/parameters', 'delay=5', form),
      h.call('DELETE', '/rulesets/batteries/notices', undefined, {})
    ])
    expect(replies.map((r) => r.status)).toEqual([415, 415, 415, 415])
    expect((await h.call('GET', '/log')).body).toEqual([])
  })

  it('answers 503 while the plugin is not running', async () => {
    const h = await serve({ withAlerts: false })
    const replies = await Promise.all([
      h.call('GET', '/rulesets'),
      h.call('POST', '/rulesets/rescan'),
      h.call('PUT', '/rulesets/batteries/enabled', { enabled: true })
    ])
    expect(replies.map((r) => r.status)).toEqual([503, 503, 503])
  })
})
