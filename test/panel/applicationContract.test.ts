import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Value } from '@signalk/server-api'
import { serverDeps } from '../../src/alerts/server'
import { Application } from '../../src/application'
import { parseRuleEntry, parseState, type RuleEntry } from '../../src/panel/api'
import { Store } from '../../src/store/store'
import { MockServerAPI } from '../helpers/MockServerAPI'

/**
 * The panel's parsers against what the real Application answers, through
 * JSON as the routes send it. The parser tests use hand-written bodies; this
 * catches the two drifting apart.
 */

const PLUGIN = 'signalk-alert-rules'
const RPM = 'propulsion.main.revolutions'
const AUX_RPM = 'propulsion.aux.revolutions'
const COOLANT = 'propulsion.main.coolantTemperature'

const oil = {
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Engine oil pressure is low',
  signal: { path: 'propulsion.main.oilPressure' },
  detector: {
    type: 'sustained',
    direction: 'below',
    steps: [{ limit: 100000, priority: 'alarm' }],
    duration: 5
  }
}
const hours = {
  name: 'Engine hours',
  slug: 'engine-hours',
  message: 'Engine service due',
  signal: { path: RPM },
  detector: { type: 'accumulator', measure: 'time', steps: [{ limit: 1000, priority: 'caution' }] }
}
const batteries = {
  name: 'Battery low',
  slug: 'battery-low',
  message: '{instance} battery is low',
  signal: { path: 'electrical.batteries.*.voltage' },
  detector: { type: 'sustained', direction: 'below', steps: [{ limit: 12, priority: 'warning' }] }
}
const mismatch = {
  name: 'RPM mismatch',
  slug: 'rpm-mismatch',
  condition: 'revolutionsMismatch',
  message: 'Engine revolutions differ',
  signal: { combinator: 'absDifference', inputs: [{ path: RPM }, { path: AUX_RPM }] },
  detector: { type: 'sustained', direction: 'above', steps: [{ limit: 3, priority: 'warning' }] },
  gates: [{ signal: { path: COOLANT }, direction: 'above', limit: { kind: 'fixed', value: 300 } }]
}
/** Fails validation: an accumulator limit must be positive. */
const broken = {
  ...hours,
  slug: 'broken',
  detector: { ...hours.detector, steps: [{ limit: -5, priority: 'caution' }] }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skar-panel-contract-'))
  mkdirSync(join(dir, 'rules'))
  for (const rule of [oil, hours, batteries, mismatch, broken]) {
    writeFileSync(join(dir, 'rules', `${rule.slug}.json`), JSON.stringify(rule))
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function running() {
  const server = new MockServerAPI(true, dir)
  let now = 0
  const application = new Application(
    {
      ...serverDeps(server.asServerAPI(), PLUGIN),
      clock: () => now,
      wallClock: () => new Date('2026-09-30T12:00:00.000Z')
    },
    new Store(dir)
  )
  application.start()
  const publish = (path: string, value: Value) => {
    server.subscriptionmanager.publish(path, 'src', value)
  }
  publish(oil.signal.path, 0)
  publish(RPM, 30)
  publish(AUX_RPM, 20)
  publish(COOLANT, 350)
  publish('electrical.batteries.house.voltage', 12.6)
  publish('electrical.batteries.start.voltage', 11.5)
  now = 20
  application.tick()
  application.disableRule(hours.slug, undefined, 'admin')
  application.disableRule(mismatch.slug, 'sender loose', 'skipper')
  return application
}

/** Through JSON, as the routes send it. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

function parsedRules(application: Application): Map<string, RuleEntry> {
  const body = wire(application.rules())
  if (!Array.isArray(body)) throw new Error('rules() is not a list')
  return new Map(
    body.map((entry) => {
      const parsed = parseRuleEntry(entry, '/rules')
      return [parsed.slug, parsed]
    })
  )
}

describe('panel parsers against the Application', () => {
  it('read every rule entry the Application answers', () => {
    const rules = parsedRules(running())
    expect([...rules.keys()].sort()).toEqual([
      'battery-low',
      'engine-hours',
      'oil-pressure-low',
      'rpm-mismatch'
    ])
  })

  it('read a running rule with an active alert, and its priority', () => {
    const entry = parsedRules(running()).get(oil.slug)
    expect(entry?.disabled).toBeUndefined()
    expect(entry).toMatchObject({
      rule: { name: oil.name, priority: 'alarm', detector: { type: 'sustained' } },
      status: { condition: 'alerting', reason: 'alertActive' }
    })
    expect(entry?.status.instances).toEqual([
      expect.objectContaining({ condition: 'alerting', value: 0, priority: 'alarm' })
    ])
  })

  it('read a disabled accumulator with its running total', () => {
    const entry = parsedRules(running()).get(hours.slug)
    expect(entry).toMatchObject({
      disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' },
      rule: { detector: { type: 'accumulator', measure: 'time' } },
      status: { condition: 'normal', reason: 'withinLimits' }
    })
    expect(entry?.status.instances).toEqual([
      expect.objectContaining({ condition: 'normal', ...progress(20) })
    ])
  })

  it('read the instances of a wildcard rule', () => {
    const entry = parsedRules(running()).get(batteries.slug)
    const instances = entry?.status.instances.map((i) => [i.instance?.segment, i.condition])
    expect(instances?.sort()).toEqual([
      ['house', 'normal'],
      ['start', 'alerting']
    ])
    expect(entry?.rule.alertPath).toBe('electrical.batteries.*.voltageLow')
  })

  it('read a disabled combinator with its note and gates', () => {
    const entry = parsedRules(running()).get(mismatch.slug)
    expect(entry).toMatchObject({
      rule: {
        // The condition name under the parent its inputs share.
        alertPath: 'propulsion.revolutionsMismatch',
        signal: { combinator: 'absDifference', paths: [RPM, AUX_RPM] },
        gates: [{ paths: [COOLANT] }]
      },
      disabled: { actor: 'skipper', note: 'sender loose' },
      status: { condition: 'present', reason: 'conditionPresent' }
    })
    expect(entry?.status.instances[0]?.gates).toEqual([{ holds: true, input: 'value' }])
  })

  it('read one rule as GET /rules/:slug answers it', () => {
    const entry = parseRuleEntry(wire(running().rule(oil.slug)), '/rules/oil')
    expect(entry.slug).toBe(oil.slug)
  })

  it('read the load issues in the state', () => {
    const application = running()
    // Built as src/api/routes.ts builds GET /state from the Application.
    const state = parseState(
      wire({
        running: true,
        securityEnabled: true,
        issues: application.issues
      })
    )
    expect(state.issues).toEqual([expect.stringMatching(/stored rule broken is not valid/)])
  })
})

function progress(total: number) {
  return { progress: { kind: 'total', total, limit: hours.detector.steps[0].limit } }
}
