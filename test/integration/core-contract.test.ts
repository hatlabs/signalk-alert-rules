// Pins the core alerts behaviour SKAR depends on against a real Signal K
// server built from the alerts branch. Opt-in: set SKAR_CONTRACT_SERVER to a
// built server checkout (`npm run build` there) or use `./run contract-test`.
// Each staleness check waits out core's fixed 60 s source timeout.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import type { AlertValue, CoreAlert } from '../../src/alerts/emitter.js'
import { alertPathOf } from '../../src/alerts/paths.js'
import { serverDeps } from '../../src/alerts/server.js'
import { RuleRunner, type RunnerDeps } from '../../src/alerts/runner.js'
import type { Priority } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'

const SERVER = process.env.SKAR_CONTRACT_SERVER
const PLUGIN_ID = 'signalk-alert-rules'
const SOURCE_TIMEOUT_MS = 60_000
const STALE_WAIT_MS = SOURCE_TIMEOUT_MS + 5_000
const SLOW_TEST_MS = 3 * SOURCE_TIMEOUT_MS
const SETTLE_MS = 3_000
const STAMP_GAP_MS = 10

// Core's own alerts API, which also backs the plugin surface; readable while the plugin is disabled.
type ServerAlert = CoreAlert & {
  id: string
  references?: string[]
  state: string
  silenced: boolean
  stateChangedAt: string
}

interface CoreAlertsApi {
  list(): ServerAlert[]
  getByPath(path: string): ServerAlert | null
  acknowledge(id: string, by: string): Promise<unknown>
  silence(id: string): Promise<unknown>
  /** Resolves once every queued `alerts.*` delta has been applied. */
  ingressSettled(): Promise<void>
}

interface SignalKServer {
  start(): Promise<unknown>
  stop(): Promise<void>
  app: ServerAPI & { alertsApi: CoreAlertsApi }
}

type ServerClass = new (props: { config: Record<string, unknown> }) => SignalKServer

const FIXTURE = `module.exports = function (app) {
  return {
    id: '${PLUGIN_ID}',
    name: 'SKAR contract fixture',
    schema: function () { return { type: 'object', properties: {} } },
    start: function () { globalThis.__skarContractApp = app },
    stop: function () { globalThis.__skarContractApp = undefined }
  }
}
`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(read: () => T | undefined | null, what: string): Promise<T> {
  const deadline = Date.now() + SETTLE_MS
  for (;;) {
    const value = read()
    if (value !== undefined && value !== null) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, () => {
      const address = probe.address()
      probe.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port)
        else reject(new Error('no port'))
      })
    })
  })
}

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skar-contract-'))
  const plugin = join(dir, 'node_modules', 'skar-contract-fixture')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(
    join(plugin, 'package.json'),
    JSON.stringify({ name: 'skar-contract-fixture', keywords: ['signalk-node-server-plugin'] })
  )
  writeFileSync(join(plugin, 'index.js'), FIXTURE)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'skar-contract-config' }))
  setPluginEnabled(dir, true)
  return dir
}

function setPluginEnabled(dir: string, enabled: boolean): void {
  mkdirSync(join(dir, 'plugin-config-data'), { recursive: true })
  writeFileSync(
    join(dir, 'plugin-config-data', `${PLUGIN_ID}.json`),
    JSON.stringify({ enabled, configuration: {} })
  )
}

async function startServer(serverDir: string, configDir: string, port: number) {
  const require = createRequire(join(serverDir, 'package.json'))
  process.env.SIGNALK_NODE_CONFIG_DIR = configDir
  process.env.SIGNALK_DISABLE_SERVER_UPDATES = 'true'
  ;(
    require(join(serverDir, 'dist', 'modules')) as { resetModuleCaches(): void }
  ).resetModuleCaches()
  const Server = require(join(serverDir, 'dist')) as ServerClass
  // Core never stops plugins, so a stale handle from a previous server would satisfy `boot`.
  ;(globalThis as { __skarContractApp?: ServerAPI }).__skarContractApp = undefined
  const server = new Server({
    config: {
      defaults: {
        vessels: { self: { uuid: 'urn:mrn:signalk:uuid:5ab4c1d0-9c2e-4d1c-8a55-0c0ffee00001' } }
      },
      // Non-default values, so the settings test can tell SKAR read these keys.
      settings: {
        port,
        interfaces: { plugins: true },
        enforceDataTimeouts: true,
        useDefaultTimeouts: false
      }
    }
  })
  await server.start()
  return server
}

const pluginApp = () => (globalThis as { __skarContractApp?: ServerAPI }).__skarContractApp

const raise = (message: string): AlertValue => ({ priority: 'alarm', message, latching: false })

describe.skipIf(SERVER === undefined)('core alerts contract', () => {
  let configDir = ''
  let port = 0
  let server: SignalKServer | undefined
  let deps: RunnerDeps
  const running = () => {
    if (server === undefined) throw new Error('no server running')
    return server
  }
  const alerts = () => running().app.alertsApi

  async function boot() {
    setPluginEnabled(configDir, true)
    server = await startServer(SERVER ?? '', configDir, port)
    deps = serverDeps(await until(pluginApp, 'the fixture plugin to start'), PLUGIN_ID)
  }

  beforeAll(async () => {
    configDir = makeConfigDir()
    port = await freePort()
    await boot()
  }, SLOW_TEST_MS)

  afterAll(async () => {
    await server?.stop()
    rmSync(configDir, { recursive: true, force: true })
  })

  it("reports the plugin's id as the alert's source, with condition, priority, message and data", async () => {
    deps.send('contract.source', { ...raise('source'), data: { rule: 'contract-source' } })
    const alert = await until(() => alerts().getByPath('contract.source'), 'the raise')
    expect(alert).toMatchObject({
      $source: PLUGIN_ID,
      condition: true,
      priority: 'alarm',
      message: 'source',
      data: { rule: 'contract-source' }
    })
  })

  it('stores references with the raise and keeps them through a repeat that omits them', async () => {
    const path = 'contract.references.voltageLow'
    const references = ['electrical.batteries.house.voltage', 'electrical.chargers.shore.state']
    deps.send(path, { ...raise('references'), references })
    await until(() => alerts().getByPath(path), 'the raise')
    deps.send(path, raise('references'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({ references })
  })

  it('drops every reference when one is not a usable path, which is why SKAR leaves such paths out', async () => {
    const path = 'contract.references.dropped'
    deps.send(path, {
      ...raise('dropped'),
      references: ['electrical.batteries.house.voltage', 'electrical.batteries.house bank.voltage']
    })
    const alert = await until(() => alerts().getByPath(path), 'the raise')
    expect(alert.references).toBeUndefined()
  })

  it('refuses a raise with more than 50 references', async () => {
    const path = 'contract.references.tooMany'
    const references = Array.from({ length: 51 }, (_, i) => `a.p${String(i)}`)
    deps.send(path, { ...raise('too many'), references })
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toBeNull()
    deps.send(path, { ...raise('enough'), references: references.slice(0, 50) })
    await until(() => alerts().getByPath(path), 'the raise')
  })

  it("reports the last emitter's id as the source, which the restart reconciliation reads", async () => {
    const path = 'contract.taken-over'
    deps.send(path, raise('taken'))
    await until(() => alerts().getByPath(path), 'the raise')
    running().app.handleMessage('another-plugin', {
      updates: [
        {
          values: [
            { path: `alerts.${path}` as never, value: { priority: 'emergency', message: 'theirs' } }
          ]
        }
      ]
    })
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)?.$source).toBe('another-plugin')
  })

  it('keeps an acknowledged alert acknowledged across unchanged heartbeats', async () => {
    const path = 'contract.ack'
    deps.send(path, raise('ack'))
    const alert = await until(() => alerts().getByPath(path), 'the raise')
    await alerts().acknowledge(alert.id, 'contract-test')
    deps.send(path, raise('ack'))
    deps.send(path, raise('ack'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)?.state).toBe('acknowledged')
  })

  it('updates the message of an acknowledged alert without re-alerting it', async () => {
    const path = 'contract.edited'
    deps.send(path, raise('before'))
    const alert = await until(() => alerts().getByPath(path), 'the raise')
    await alerts().acknowledge(alert.id, 'contract-test')
    deps.send(path, raise('after'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({ state: 'acknowledged', message: 'after' })
  })

  it('escalates an acknowledged alert on a repeat at a higher priority, and keeps its priority on a lower one', async () => {
    const path = 'contract.escalated'
    deps.send(path, { ...raise('escalated'), priority: 'warning' })
    const alert = await until(() => alerts().getByPath(path), 'the raise')
    await alerts().acknowledge(alert.id, 'contract-test')
    deps.send(path, raise('escalated'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({ priority: 'alarm', state: 'unacknowledged' })
    await alerts().acknowledge(alert.id, 'contract-test')
    deps.send(path, { ...raise('escalated'), priority: 'warning' })
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({
      priority: 'alarm',
      state: 'acknowledged',
      condition: true
    })
  })

  it('keeps stored data when a heartbeat omits it', async () => {
    const path = 'contract.no-data'
    deps.send(path, { ...raise('data'), data: { rule: 'contract.no-data' } })
    await until(() => alerts().getByPath(path), 'the raise')
    deps.send(path, raise('data'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)?.data).toEqual({ rule: 'contract.no-data' })
  })

  it('holds a cleared unacknowledged alarm, and reactivates it on a new raise', async () => {
    const path = 'contract.held'
    deps.send(path, raise('held'))
    await until(() => alerts().getByPath(path), 'the raise')
    deps.send(path, null)
    await until(
      () => (alerts().getByPath(path)?.condition === false ? true : undefined),
      'the clear'
    )
    expect(alerts().getByPath(path)?.state).toBe('rtn-unacknowledged')
    deps.send(path, raise('held'))
    await until(
      () => (alerts().getByPath(path)?.condition === true ? true : undefined),
      'the re-raise'
    )
    expect(alerts().getByPath(path)?.state).toBe('unacknowledged')
  })

  it('holds a latching raise as ended, and re-announces the held alert on the next latching raise', async () => {
    const path = 'contract.latching'
    const event: AlertValue = { ...raise('latching'), latching: true }
    deps.send(path, event)
    const first = await until(() => alerts().getByPath(path), 'the raise')
    expect(first).toMatchObject({ latching: true, condition: false, state: 'unacknowledged' })
    await alerts().silence(first.id)
    // Core stamps state changes in milliseconds; a later occurrence must be told apart.
    await sleep(STAMP_GAP_MS)
    deps.send(path, event)
    await alerts().ingressSettled()
    const second = alerts().getByPath(path)
    expect(second).toMatchObject({ condition: false, state: 'unacknowledged', silenced: false })
    expect(Date.parse(second?.stateChangedAt ?? '')).toBeGreaterThan(
      Date.parse(first.stateChangedAt)
    )
  })

  it(
    'marks an active alert stale 60 s after its last emission, never one whose condition ended, and a raise revives it',
    async () => {
      const silent = 'contract.silent'
      const cleared = 'contract.cleared'
      for (const path of [silent, cleared]) deps.send(path, raise(path))
      deps.send(cleared, null)
      await until(
        () => (alerts().getByPath(cleared)?.condition === false ? true : undefined),
        'the clear'
      )
      await sleep(STALE_WAIT_MS)
      expect(alerts().getByPath(silent)?.stale).toBe(true)
      // SKAR sends nothing after its clear, so an alert core keeps for acknowledgement must not go stale.
      expect(alerts().getByPath(cleared)).toMatchObject({ condition: false, stale: false })
      deps.send(silent, raise(silent))
      await alerts().ingressSettled()
      expect(alerts().getByPath(silent)?.stale).toBe(false)
    },
    SLOW_TEST_MS
  )

  it('exposes the data-timeout settings to the plugin', () => {
    expect(deps.timeoutSettings()).toEqual({ enforce: true, useDefaults: false })
  })

  it(
    'restores active alerts on restart and times them from load, so they go stale while SKAR is disabled',
    async () => {
      const restoredPath = 'contract.restart-restored'
      deps.send(restoredPath, raise('restored'))
      await alerts().ingressSettled()
      await running().stop()
      setPluginEnabled(configDir, false)
      server = await startServer(SERVER ?? '', configDir, port)
      try {
        expect(alerts().getByPath(restoredPath)).toMatchObject({ condition: true, stale: false })
        await sleep(STALE_WAIT_MS)
        expect(alerts().getByPath(restoredPath)?.stale).toBe(true)
      } finally {
        await running().stop()
        await boot()
      }
    },
    SLOW_TEST_MS
  )

  it('a restarted runner adopts an acknowledged alarm without re-alerting it', async () => {
    const OIL = 'propulsion.main.oilPressure'
    const validated = validateRule({
      name: 'Oil pressure low',
      slug: 'oil-pressure-low',
      message: 'Engine oil pressure is low',
      signal: { path: OIL },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 100000, priority: 'alarm' }]
      }
    })
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
    const rules = [validated.value]
    const path = 'propulsion.main.oilPressureLow'
    running().app.handleMessage('contract-sensor', {
      updates: [{ values: [{ path: OIL as never, value: 0 }] }]
    })
    const first = new RuleRunner(deps, rules)
    first.start()
    first.tick()
    const raised = await until(() => alerts().getByPath(path), 'the rule to raise')
    await alerts().acknowledge(raised.id, 'contract-test')
    first.stop()

    const second = new RuleRunner(deps, rules)
    second.start()
    second.tick()
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({
      state: 'acknowledged',
      condition: true,
      data: raised.data,
      references: [OIL]
    })
    second.stop()
  })

  it('a rule with steps escalates its one alert on the same path, resetting acknowledgment, and never lowers it', async () => {
    const VOLTAGE = 'electrical.batteries.contract.voltage'
    const validated = validateRule({
      name: 'Contract voltage low',
      slug: 'contract-voltage-low',
      message: 'Contract voltage is low',
      signal: { path: VOLTAGE },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [
          { limit: 12.2, priority: 'warning' },
          { limit: 11.8, priority: 'alarm' }
        ]
      }
    })
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
    const rule = validated.value
    const path = 'electrical.batteries.contract.voltageLow'
    const sent: (AlertValue | null)[] = []
    const recording: RunnerDeps = {
      ...deps,
      send: (to, value) => {
        if (to === path) sent.push(value)
        deps.send(to, value)
      }
    }
    const measure = async (value: number) => {
      running().app.handleMessage('contract-sensor', {
        updates: [{ values: [{ path: VOLTAGE as never, value }] }]
      })
      await until(
        () => (runner.status(rule.slug)?.instances[0]?.value === value ? true : undefined),
        `the rule to read ${String(value)}`
      )
      runner.tick()
      await alerts().ingressSettled()
    }
    const runner = new RuleRunner(recording, [rule])
    runner.start()

    await measure(12)
    const raised = await until(() => alerts().getByPath(path), 'the raise at the first step')
    expect(raised).toMatchObject({
      priority: 'warning',
      condition: true,
      data: { rule: rule.slug, limit: 12.2 }
    })
    await alerts().acknowledge(raised.id, 'contract-test')

    await measure(11.7)
    expect(alerts().getByPath(path)).toMatchObject({
      id: raised.id,
      priority: 'alarm',
      state: 'unacknowledged',
      condition: true,
      data: { rule: rule.slug, limit: 11.8, raisedAt: raised.data?.raisedAt }
    })
    await alerts().acknowledge(raised.id, 'contract-test')

    await measure(12)
    expect(alerts().getByPath(path)).toMatchObject({
      id: raised.id,
      priority: 'alarm',
      state: 'acknowledged',
      condition: true
    })
    expect(sent.map((value) => value?.priority)).toEqual(['warning', 'alarm'])
    expect(runner.status(rule.slug)?.instances[0]).toMatchObject({ step: 1, priority: 'alarm' })
    runner.stop()
  })

  it('a latching raise at a higher priority escalates the held occurrence, and raises anew once it was acknowledged', async () => {
    const path = 'contract.latching.stepped'
    const occurrence = (priority: Priority): AlertValue => ({
      priority,
      message: 'pump cycling',
      latching: true
    })
    deps.send(path, occurrence('warning'))
    const first = await until(() => alerts().getByPath(path), 'the first occurrence')
    await sleep(STAMP_GAP_MS)
    deps.send(path, occurrence('alarm'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({
      id: first.id,
      priority: 'alarm',
      state: 'unacknowledged'
    })
    await alerts().acknowledge(first.id, 'contract-test')
    deps.send(path, occurrence('emergency'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({
      priority: 'emergency',
      state: 'unacknowledged'
    })
  })

  it("a starting runner clears its own orphan and leaves another source's alert at a rule's path", async () => {
    const validated = validateRule({
      name: 'Fresh water low',
      slug: 'fresh-water-low',
      message: 'Fresh water is low',
      signal: { path: 'tanks.freshWater.contract.currentLevel' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 0.1, priority: 'warning' }]
      }
    })
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
    const foreign = 'tanks.freshWater.contract.currentLevelLow'
    expect(alertPathOf(validated.value)).toBe(foreign)
    const orphan = 'tanks.freshWater.removed.currentLevelLow'
    running().app.handleMessage('tank-monitor', {
      updates: [
        {
          values: [
            {
              path: `alerts.${foreign}` as never,
              value: { priority: 'warning', message: 'theirs' }
            }
          ]
        }
      ]
    })
    deps.send(orphan, raise('orphan'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(orphan)?.$source).toBe(PLUGIN_ID)

    const runner = new RuleRunner(deps, [validated.value])
    runner.start()
    await alerts().ingressSettled()
    expect(alerts().getByPath(foreign)).toMatchObject({ $source: 'tank-monitor', condition: true })
    expect(alerts().getByPath(orphan)?.condition).toBe(false)
    runner.stop()
  })
})
