import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Value } from '@signalk/server-api'
import { Application } from '../src/application.js'
import { serverDeps } from '../src/alerts/server.js'
import { Store } from '../src/store/store.js'
import { MockServerAPI } from './helpers/MockServerAPI.js'

const PLUGIN = 'signalk-alert-rules'
const OIL = 'propulsion.main.oilPressure'
const COOLANT = 'propulsion.main.coolantTemperature'
const RPM = 'propulsion.main.revolutions'

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
  message: 'Coolant temperature is high',
  priority: 'alarm',
  signal: { path: COOLANT },
  detector: {
    type: 'sustained',
    direction: 'above',
    limit: { kind: 'fixed', value: 368 },
    duration: 2
  }
}
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  priority: 'caution',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', limit: 1000 }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-app-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stored(rule: Record<string, unknown> & { slug: string }): void {
  fs.mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
}

function setup(store = new Store(dir)) {
  const server = new MockServerAPI(true, dir)
  let now = 0
  const deps = { ...serverDeps(server.asServerAPI(), PLUGIN), clock: () => now }
  const application = new Application(deps, store)
  application.start()
  const alerts = () => server.core.list().map((a) => [a.path, a.condition] as [string, boolean])
  return {
    server,
    application,
    alerts,
    at: (t: number, path?: string, value?: Value) => {
      now = t
      if (path === undefined) application.tick()
      else server.subscriptionmanager.publish(path, 'src', value ?? null)
    }
  }
}

describe('application', () => {
  it('creating a rule persists it and starts evaluation without restarting others', () => {
    stored(oil)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(3)

    const result = application.saveRule(coolant)
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'rules', 'coolant-high.json'), 'utf8'))).toEqual(
      coolant
    )
    expect(application.userRules().map((r) => r.slug)).toEqual(['oil-pressure-low', 'coolant-high'])

    // The oil rule's timer kept running across the save: it raises 5 s after
    // its value, not 5 s after the save.
    at(4)
    expect(alerts()).toEqual([])
    at(5)
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])

    at(5, COOLANT, 380)
    at(7)
    expect(alerts()).toContainEqual(['rules.user.coolant-high', true])
  })

  it('an edit persists and applies to the running rule', () => {
    stored(oil)
    const { application, at, server } = setup()
    at(0, OIL, 0)
    at(5)
    expect(application.saveRule({ ...oil, message: 'Check the oil' }).ok).toBe(true)
    at(25)
    expect(server.core.getByPath('rules.user.oil-pressure-low')?.message).toBe('Check the oil')
    expect(new Store(dir).load().rules[0]?.value).toMatchObject({ message: 'Check the oil' })
  })

  it('rejects an invalid rule with field-path errors and persists nothing', () => {
    const { application } = setup()
    const result = application.saveRule({ ...oil, priority: 'loud' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain('/priority')
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(false)
    expect(application.userRules()).toEqual([])
  })

  it('does not apply a rule the store failed to persist', () => {
    const failing = new Store(dir, {
      ...fs,
      writeSync: () => {
        throw new Error('EROFS: read-only file system')
      }
    })
    const { application, at, alerts } = setup(failing)
    expect(() => application.saveRule(oil)).toThrow(/EROFS/)
    expect(application.userRules()).toEqual([])
    at(0, OIL, 0)
    at(10)
    expect(alerts()).toEqual([])
  })

  it('deleting a rule removes its file and clears its alert, leaving the others', () => {
    stored(oil)
    stored(coolant)
    const { application, at, alerts } = setup()
    at(0, OIL, 0)
    at(0, COOLANT, 380)
    at(5)
    expect(alerts()).toHaveLength(2)

    expect(application.deleteRule('oil-pressure-low')).toBe(true)
    expect(existsSync(join(dir, 'rules', 'oil-pressure-low.json'))).toBe(false)
    expect(new Map(alerts())).toEqual(
      new Map([
        ['rules.user.oil-pressure-low', false],
        ['rules.user.coolant-high', true]
      ])
    )
    expect(application.deleteRule('oil-pressure-low')).toBe(false)
  })

  it('skips and reports an invalid stored rule while the others run, and can delete it', () => {
    stored(oil)
    stored({ ...coolant, priority: 'loud' })
    writeFileSync(join(dir, 'rules', 'renamed.json'), JSON.stringify(coolant))
    const { application, at, alerts } = setup()
    expect(application.issues).toHaveLength(2)
    expect(application.issues.join('\n')).toMatch(/coolant-high.*\/priority/)
    expect(application.issues.join('\n')).toMatch(/renamed.*coolant-high/)
    at(0, OIL, 0)
    at(5)
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])

    expect(application.deleteRule('coolant-high')).toBe(true)
    expect(existsSync(join(dir, 'rules', 'coolant-high.json'))).toBe(false)
  })

  it('reports a corrupt store file and runs the rules it could read', () => {
    stored(oil)
    writeFileSync(join(dir, 'accumulators.json'), '{')
    const { application } = setup()
    expect(application.issues).toEqual([expect.stringMatching(/accumulators\.json/)])
    expect(application.userRules().map((r) => r.slug)).toEqual(['oil-pressure-low'])
  })

  it("checkpoints running totals and keeps a skipped rule's until it is deleted", () => {
    stored(hours)
    stored({ ...hours, slug: 'genset-hours', priority: 'loud' })
    new Store(dir).saveCheckpoints({
      'user.engine-hours': { '': 100 },
      'user.genset-hours': { '': 50 }
    })
    const { application, at } = setup()
    at(0, RPM, 30)
    at(20)
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({
      'user.engine-hours': { '': 120 },
      'user.genset-hours': { '': 50 }
    })

    application.deleteRule('genset-hours')
    application.deleteRule('engine-hours')
    application.checkpoint()
    expect(new Store(dir).load().accumulators).toEqual({})
  })

  it('stopping checkpoints and clears no alert', () => {
    stored(oil)
    stored(hours)
    const { application, at, alerts, server } = setup()
    at(0, OIL, 0)
    at(0, RPM, 30)
    at(5)
    const sent = server.core.writes
    application.stop()
    expect(alerts()).toEqual([['rules.user.oil-pressure-low', true]])
    expect(server.core.writes).toBe(sent)
    expect(new Store(dir).load().accumulators).toEqual({ 'user.engine-hours': { '': 5 } })
  })

  it('exposes the stored evaluation switch', () => {
    new Store(dir).saveEvaluation({ enabled: false, actor: 'admin', at: '2026-09-30T12:00:00Z' })
    expect(setup().application.evaluation).toEqual({
      enabled: false,
      actor: 'admin',
      at: '2026-09-30T12:00:00Z'
    })
  })
})
