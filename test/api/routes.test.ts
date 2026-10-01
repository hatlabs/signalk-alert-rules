import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Plugin } from '@signalk/server-api'
import type { TemplateSetEntry, TemplateListing } from '../../src/application.js'
import createPlugin from '../../src/index.js'
import { MAX_PICK_LENGTH } from '../../src/model/rule.js'
import { Store } from '../../src/store/store.js'
import { instantiate } from '../../src/templates/instantiate.js'
import { FakeAlertsCore } from '../helpers/FakeAlertsCore.js'
import { MockServerAPI } from '../helpers/MockServerAPI.js'

const BASE = '/plugins/signalk-alert-rules'
const OIL = 'propulsion.main.oilPressure'
const RPM = 'propulsion.main.revolutions'
const OIL_ALERT = 'propulsion.main.oilPressureLow'

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
    expect(created.body).toMatchObject({ slug: 'coolant-high' })
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(true)

    // The oil rule's timer kept running: it raises 5 s after its value.
    at(1)
    expect(core(h).list()).toEqual([])
    at(1)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(true)

    h.mock.subscriptionmanager.publish('propulsion.port.coolantTemperature', 'src', 380)
    expect(core(h).getByPath('propulsion.port.coolantTemperatureHigh')?.condition).toBe(true)
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
      h.call('PUT', '/rules/oil-pressure-low', 'message=x', form),
      h.call('POST', '/rules/oil-pressure-low/preview', 'message=x', form),
      h.call('DELETE', '/rules/oil-pressure-low', undefined, {}),
      h.call('POST', '/rules/engine-hours/reset', undefined, {})
    ])
    expect(replies.map((r) => r.status)).toEqual([415, 415, 415, 415, 415, 415])
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(true)
  })

  it('accepts a bodiless mutating request that declares JSON', async () => {
    storeRule(oil)
    const h = await serve()
    const reply = await h.call('DELETE', '/rules/oil-pressure-low')
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

    const reply = await h.call('GET', '/rules/coolant-high')
    expect(reply.status).toBe(200)
    const entry = reply.body as {
      rule: unknown
      status: { instances: { instance: { name: string } }[] }
    }
    expect(entry).toMatchObject({
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
    expect(core(h).getByPath('propulsion.main.revolutionsAccumulated')?.condition).toBe(true)

    h.user = 'skipper'
    const reply = await h.call('POST', '/rules/engine-hours/reset')
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      status: {
        badge: 'idle',
        instances: [{ active: false, progress: { kind: 'total', total: 0 } }]
      }
    })
    expect(core(h).getByPath('propulsion.main.revolutionsAccumulated')?.condition).toBe(false)
    expect(new Store(dir).load().accumulators).toEqual({
      'engine-hours': { measure: 'time', totals: { '': 0 } }
    })
    const log = await h.call('GET', '/log')
    expect(log.body).toEqual([
      {
        at: expect.any(String) as unknown,
        actor: 'skipper',
        action: 'reset',
        rule: 'engine-hours'
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
      rule: 'engine-hours'
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
    const clearing = await h.call('POST', '/rules/oil-pressure-low/preview', retyped)
    expect(clearing.status).toBe(200)
    expect(clearing.body).toMatchObject({
      restarts: true,
      activeAlerts: 1,
      clearsActiveAlert: true
    })
    expect((clearing.body as { changes: string[] }).changes).toContain('detector.type')

    const limit = { ...oil, detector: { ...oil.detector, limit: { kind: 'fixed', value: 90000 } } }
    const inPlace = await h.call('POST', '/rules/oil-pressure-low/preview', limit)
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

    const replaced = await h.call('PUT', '/rules/oil-pressure-low', {
      ...oil,
      message: 'Check the oil'
    })
    expect(replaced.status).toBe(200)
    expect(replaced.body).toMatchObject({ rule: { message: 'Check the oil' } })

    h.user = undefined
    expect((await h.call('DELETE', '/rules/oil-pressure-low')).status).toBe(204)
    expect(core(h).getByPath(OIL_ALERT)?.condition).toBe(false)
    expect((await h.call('GET', '/log')).body).toMatchObject([
      { actor: 'unauthenticated', action: 'delete', rule: 'oil-pressure-low' }
    ])
  })

  it('answers the error paths', async () => {
    storeRule(oil)
    const h = await serve()
    const statuses = await Promise.all([
      h.call('GET', '/rules/missing'),
      h.call('GET', '/rules/user/oil-pressure-low'),
      h.call('PUT', '/rules/missing', { ...oil, slug: 'missing' }),
      h.call('POST', '/rules/missing/preview', { ...oil, slug: 'missing' }),
      h.call('DELETE', '/rules/missing'),
      h.call('POST', '/rules/missing/reset'),
      h.call('POST', '/rules', oil),
      h.call('PUT', '/rules/oil-pressure-low', { ...oil, slug: 'other' }),
      h.call('POST', '/rules/oil-pressure-low/preview', { ...oil, slug: 'other' }),
      h.call('POST', '/rules/oil-pressure-low/reset'),
      h.call('PUT', '/rules/oil-pressure-low', { ...oil, priority: 'loud' })
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
  const RULE = '/rules/oil-pressure-low'

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
      { actor: 'admin', action: 'enable', rule: 'oil-pressure-low' },
      {
        actor: 'admin',
        action: 'disable',
        rule: 'oil-pressure-low',
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
      h.call('POST', '/rules/missing/disable', {}),
      h.call('POST', '/rules/user/oil-pressure-low/enable'),
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
      h.call('PUT', '/suppressions/rules/oil-pressure-low', {})
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

describe('templates API', () => {
  const PACKAGE = 'signalk-battery-templates'
  const HOUSE = 'electrical.batteries.house.voltage'

  /** Records an installed package in the config package.json, as the server's npm install does. */
  function list(dependencies: Record<string, string>): void {
    writeFileSync(join(configDir, 'package.json'), JSON.stringify({ dependencies }))
  }

  /** A template package whose set has a voltage-low template and the extra templates named. */
  function installSet(version: string, extra: string[] = []): void {
    const pkg = join(configDir, 'node_modules', PACKAGE)
    mkdirSync(pkg, { recursive: true })
    list({ [PACKAGE]: version })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: PACKAGE,
        version,
        keywords: ['signalk-alert-templates'],
        'signalk-alert-templates': 'templates.yaml'
      })
    )
    const template = (id: string) => [
      `  - id: ${id}`,
      '    open: [instance, source]',
      '    rule:',
      `      name: ${id} \${instance}`,
      '      message: Battery voltage low',
      '      priority: warning',
      '      signal:',
      '        path: electrical.batteries.${instance}.voltage',
      '      detector: { type: sustained, direction: below, limit: { kind: fixed, value: 12 } }'
    ]
    writeFileSync(
      join(pkg, 'templates.yaml'),
      [
        'name: Batteries',
        'id: batteries',
        `version: "${version}"`,
        'templates:',
        ...['voltage-low', ...extra].flatMap(template)
      ].join('\n')
    )
  }

  function uninstallSet(): void {
    rmSync(join(configDir, 'node_modules', PACKAGE), { recursive: true })
    list({})
  }

  async function listing(h: Harness): Promise<TemplateListing> {
    const reply = await h.call('GET', '/templates')
    expect(reply.status).toBe(200)
    return reply.body as TemplateListing
  }

  async function batteries(h: Harness): Promise<TemplateSetEntry> {
    const found = (await listing(h)).sets.find((s) => s.id === 'batteries')
    if (found === undefined) throw new Error('no batteries set')
    return found
  }

  /** Makes a rule from the voltage-low template as the webapp will, and saves it through the create route. */
  async function create(h: Harness, pick: { instance?: string; source?: string }): Promise<Reply> {
    const set = await batteries(h)
    const rules = (await h.call('GET', '/rules')).body as { slug: string }[]
    const template = set.templates.find((t) => t.id === 'voltage-low')
    if (template === undefined) throw new Error('no template')
    const made = instantiate(set, template, pick, new Set(rules.map((r) => r.slug)))
    if (!made.ok) throw new Error(JSON.stringify(made.errors))
    return h.call('POST', '/rules', made.value)
  }

  it('lists the built-in set and a package set with their templates and open parts, all new', async () => {
    installSet('1.0.0')
    const h = await serve()
    const { sets, problems } = await listing(h)
    expect(problems).toEqual([])
    expect(sets.map((s) => [s.id, s.source])).toEqual([
      ['builtin', 'built-in'],
      ['batteries', `package ${PACKAGE}`]
    ])
    expect(sets[1]).toMatchObject({
      name: 'Batteries',
      version: '1.0.0',
      package: { name: PACKAGE, version: '1.0.0' },
      templates: [{ id: 'voltage-low', open: ['instance', 'source'] }],
      new: ['voltage-low']
    })
  })

  it('saves an instantiated template as a rule on the picked path, recording the template', async () => {
    installSet('1.0.0')
    const h = await serve()
    const reply = await create(h, { instance: 'house', source: 'can0.12' })
    expect(reply.status).toBe(201)
    const stored = JSON.parse(
      readFileSync(join(dir, 'rules', 'voltage-low-house.json'), 'utf8')
    ) as unknown
    expect(stored).toMatchObject({
      name: 'voltage-low house',
      slug: 'voltage-low-house',
      signal: { path: HOUSE, source: 'can0.12' },
      template: {
        set: 'batteries',
        id: 'voltage-low',
        version: '1.0.0',
        pick: { instance: 'house', source: 'can0.12' }
      }
    })
  })

  it('gives a second rule from the same template and pick its own slug', async () => {
    installSet('1.0.0')
    const h = await serve()
    const pick = { instance: 'house', source: 'can0.12' }
    expect((await create(h, pick)).status).toBe(201)
    expect((await create(h, pick)).status).toBe(201)
    const rules = (await h.call('GET', '/rules')).body as { slug: string }[]
    expect(rules.map((r) => r.slug)).toEqual(['voltage-low-house', 'voltage-low-house-2'])
  })

  it('refuses a rule whose pick makes an invalid path, or with a malformed template record', async () => {
    installSet('1.0.0')
    const h = await serve()
    const invalidPath = await create(h, {
      instance: 'h'.repeat(MAX_PICK_LENGTH),
      source: 'can0.12'
    })
    expect(invalidPath.status).toBe(400)
    expect((invalidPath.body as { errors: { path: string }[] }).errors).toContainEqual(
      expect.objectContaining({ path: '/signal/path' })
    )
    const malformed = await h.call('POST', '/rules', {
      ...oil,
      template: { set: 'batteries', id: 'voltage-low', pick: {} }
    })
    expect(malformed.status).toBe(400)
    expect(malformed.body).toMatchObject({ errors: [{ path: '/template/version' }] })
    const deeper = await h.call('POST', '/rules', {
      ...oil,
      template: { set: 'batteries', id: 'voltage-low', version: '1.0.0', pick: { instance: 'a.b' } }
    })
    expect(deeper.status).toBe(400)
    expect(deeper.body).toMatchObject({ errors: [{ path: '/template/pick/instance' }] })
    expect((await h.call('GET', '/rules')).body).toEqual([])
  })

  it('uninstalling the set leaves the rules made from it running unchanged', async () => {
    installSet('1.0.0')
    const h = await serve()
    await create(h, { instance: 'house', source: 'can0.12' })
    uninstallSet()
    await h.restart()
    expect((await listing(h)).sets.map((s) => s.id)).toEqual(['builtin'])
    const entry = (await h.call('GET', '/rules/voltage-low-house')).body
    expect(entry).toMatchObject({
      rule: { signal: { path: HOUSE }, template: { set: 'batteries' } },
      status: { badge: 'neverSeen' }
    })
    h.mock.subscriptionmanager.publish(HOUSE, 'can0.12', 11)
    expect(core(h).getByPath('electrical.batteries.house.voltageLow')?.condition).toBe(true)
  })

  it('dismissing marks the current templates seen for everyone; an update makes only its additions new', async () => {
    installSet('1.0.0')
    const h = await serve()
    const dismissed = await h.call('POST', '/templates/dismiss')
    expect(dismissed.status).toBe(200)
    expect((dismissed.body as TemplateListing).sets.map((s) => s.new)).toEqual([[], []])

    installSet('1.1.0', ['current-high'])
    h.user = 'skipper'
    await h.restart()
    expect((await batteries(h)).new).toEqual(['current-high'])
    expect((await listing(h)).sets[0]?.new).toEqual([])
  })

  it('reports a set that failed to load with its reason and each validation error', async () => {
    installSet('1.0.0')
    writeFileSync(
      join(configDir, 'node_modules', PACKAGE, 'templates.yaml'),
      'name: Batteries\nid: batteries\nversion: "1"\ntemplates:\n  - id: x\n    rule: {}\n'
    )
    const h = await serve()
    const { sets, problems } = await listing(h)
    expect(sets.map((s) => s.id)).toEqual(['builtin'])
    expect(problems).toEqual([
      {
        source: `package ${PACKAGE}`,
        message: expect.stringContaining('/templates/0/rule/name') as string,
        errors: expect.arrayContaining([
          { path: '/templates/0/rule/name', message: expect.any(String) as string }
        ]) as unknown
      }
    ])
  })

  it('takes dismissing only as a JSON request, and answers 503 while not running', async () => {
    const h = await serve()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    expect((await h.call('POST', '/templates/dismiss', 'x=1', form)).status).toBe(415)
    expect(existsSync(join(dir, 'controls.json'))).toBe(false)
    const stopped = await serve({ withAlerts: false })
    const replies = await Promise.all([
      stopped.call('GET', '/templates'),
      stopped.call('POST', '/templates/dismiss')
    ])
    expect(replies.map((r) => r.status)).toEqual([503, 503])
  })

  it('has no ruleset routes', async () => {
    const h = await serve()
    const replies = await Promise.all([
      h.call('GET', '/rulesets'),
      h.call('POST', '/rulesets/rescan'),
      h.call('POST', '/templates/batteries/voltage-low', {})
    ])
    expect(replies.map((r) => r.status)).toEqual([404, 404, 404])
  })
})
