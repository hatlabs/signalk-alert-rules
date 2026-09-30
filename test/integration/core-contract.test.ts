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
import { serverDeps } from '../../src/alerts/server.js'
import { RuleRunner, type RunnerDeps } from '../../src/alerts/runner.js'
import { validateRule } from '../../src/model/validate.js'

const SERVER = process.env.SKAR_CONTRACT_SERVER
const PLUGIN_ID = 'signalk-alert-rules'
const SOURCE_TIMEOUT_MS = 60_000
const STALE_WAIT_MS = SOURCE_TIMEOUT_MS + 5_000
const SLOW_TEST_MS = 3 * SOURCE_TIMEOUT_MS
const SETTLE_MS = 3_000

// Core's own alerts API, which also backs the plugin surface; readable while the plugin is disabled.
interface CoreAlertsApi {
  list(): (CoreAlert & { id: string; state: string })[]
  getByPath(path: string): (CoreAlert & { id: string; state: string }) | null
  acknowledge(id: string, by: string): Promise<unknown>
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
    deps.send('rules.contract.source', { ...raise('source'), data: { rule: 'contract.source' } })
    const alert = await until(() => alerts().getByPath('rules.contract.source'), 'the raise')
    expect(alert).toMatchObject({
      $source: PLUGIN_ID,
      condition: true,
      priority: 'alarm',
      message: 'source',
      data: { rule: 'contract.source' }
    })
  })

  it("reports the last emitter's id as the source, which the restart reconciliation reads", async () => {
    const path = 'rules.contract.taken-over'
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
    const path = 'rules.contract.ack'
    deps.send(path, raise('ack'))
    const alert = await until(() => alerts().getByPath(path), 'the raise')
    await alerts().acknowledge(alert.id, 'contract-test')
    deps.send(path, raise('ack'))
    deps.send(path, raise('ack'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)?.state).toBe('acknowledged')
  })

  it('re-alerts an acknowledged alert when a heartbeat carries a changed message', async () => {
    const path = 'rules.contract.edited'
    deps.send(path, raise('before'))
    const alert = await until(() => alerts().getByPath(path), 'the raise')
    await alerts().acknowledge(alert.id, 'contract-test')
    deps.send(path, raise('after'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)).toMatchObject({ state: 'unacknowledged', message: 'after' })
  })

  it('escalates an acknowledged alert on a repeat at a higher priority, and keeps its priority on a lower one', async () => {
    const path = 'rules.contract.escalated'
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
    const path = 'rules.contract.no-data'
    deps.send(path, { ...raise('data'), data: { rule: 'contract.no-data' } })
    await until(() => alerts().getByPath(path), 'the raise')
    deps.send(path, raise('data'))
    await alerts().ingressSettled()
    expect(alerts().getByPath(path)?.data).toEqual({ rule: 'contract.no-data' })
  })

  it('holds a cleared unacknowledged alarm, and reactivates it on a new raise', async () => {
    const path = 'rules.contract.held'
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

  it(
    'marks an active alert stale 60 s after its last emission, never one whose condition ended, and a raise revives it',
    async () => {
      const silent = 'rules.contract.silent'
      const cleared = 'rules.contract.cleared'
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
      const restoredPath = 'rules.contract.restart-restored'
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
      priority: 'alarm',
      signal: { path: OIL },
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 100000 } }
    })
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
    const rules = [{ origin: 'contract', rule: validated.value }]
    const path = 'rules.contract.oil-pressure-low'
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
      data: raised.data
    })
    second.stop()
  })
})
