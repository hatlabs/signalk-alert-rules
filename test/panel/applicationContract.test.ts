import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Value } from '@signalk/server-api'
import { serverDeps } from '../../src/alerts/server'
import { Application } from '../../src/application'
import {
  parseInputPreview,
  parseRuleEntry,
  parseState,
  parseSuppressions,
  type RuleEntry
} from '../../src/panel/api'
import { httpRulesetsApi } from '../../src/panel/rulesets/api'
import { validateRuleset } from '../../src/model/validate'
import type { LoadedRuleset } from '../../src/rulesets/discovery'
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
  priority: 'alarm',
  signal: { path: 'propulsion.main.oilPressure' },
  detector: {
    type: 'sustained',
    direction: 'below',
    limit: { kind: 'fixed', value: 100000 },
    duration: 5
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
const batteries = {
  name: 'Battery low',
  slug: 'battery-low',
  message: '{instance} battery is low',
  priority: 'warning',
  signal: { path: 'electrical.batteries.*.voltage' },
  detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 12 } }
}
const mismatch = {
  name: 'RPM mismatch',
  slug: 'rpm-mismatch',
  message: 'Engine revolutions differ',
  priority: 'warning',
  signal: { combinator: 'absDifference', inputs: [{ path: RPM }, { path: AUX_RPM }] },
  detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 3 } },
  gates: [{ signal: { path: COOLANT }, direction: 'above', limit: { kind: 'fixed', value: 300 } }]
}
/** Fails validation: an accumulator limit must be positive. */
const broken = { ...hours, slug: 'broken', detector: { ...hours.detector, limit: -5 } }

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
  application.setEnabled('user', hours.slug, false, 'admin')
  application.suppressRule('user', mismatch.slug, { note: 'sender loose' }, 'skipper')
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
    expect(entry).toMatchObject({
      origin: 'user',
      enabled: true,
      rule: { name: oil.name, priority: 'alarm', detector: { type: 'sustained' } },
      status: { badge: 'alertActive' }
    })
    expect(entry?.status.instances).toEqual([
      expect.objectContaining({ active: true, input: 'value', value: 0, priority: 'alarm' })
    ])
  })

  it('read a disabled accumulator with its retained total', () => {
    const entry = parsedRules(running()).get(hours.slug)
    expect(entry).toMatchObject({
      enabled: false,
      rule: { detector: { type: 'accumulator', measure: 'time' } },
      status: { badge: 'disabled', reason: 'disabled' }
    })
    expect(entry?.status.instances).toEqual([
      { badge: 'disabled', reason: 'disabled', subLabels: [], gates: [], ...progress(20) }
    ])
  })

  it('read the instances of a wildcard rule', () => {
    const entry = parsedRules(running()).get(batteries.slug)
    const instances = entry?.status.instances.map((i) => [i.instance?.segment, i.badge])
    expect(instances?.sort()).toEqual([
      ['house', 'idle'],
      ['start', 'alertActive']
    ])
  })

  it('read a suppressed combinator with its gates', () => {
    const entry = parsedRules(running()).get(mismatch.slug)
    expect(entry).toMatchObject({
      rule: {
        signal: { combinator: 'absDifference', paths: [RPM, AUX_RPM] },
        gates: [{ paths: [COOLANT] }]
      },
      suppression: { actor: 'skipper', note: 'sender loose' },
      status: { badge: 'suppressed', suppression: { scope: 'rule' } }
    })
    expect(entry?.status.instances[0]?.gates).toEqual([{ holds: true, input: 'value' }])
  })

  it('read one rule as GET /rules/:origin/:slug answers it', () => {
    const entry = parseRuleEntry(wire(running().rule('user', oil.slug)), '/rules/user/oil')
    expect(entry.slug).toBe(oil.slug)
  })

  it('read the suppressions in force, of a rule and of an input', () => {
    const application = running()
    application.suppressInput(AUX_RPM, { autoEndAfter: 600 }, 'admin')
    const suppressions = parseSuppressions(wire(application.suppressions()), '/suppressions')
    // Both start at the same fixed wall time, so their order is not what this checks.
    expect(suppressions).toHaveLength(2)
    expect(suppressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'input',
          path: AUX_RPM,
          actor: 'admin',
          autoEndAfter: 600
        }),
        expect.objectContaining({
          scope: 'rule',
          rule: `user.${mismatch.slug}`,
          origin: 'user',
          slug: mismatch.slug,
          actor: 'skipper',
          note: 'sender loose'
        })
      ])
    )
  })

  it('read an input suppression preview with what it suppresses and freezes', () => {
    const application = running()
    const preview = parseInputPreview(
      wire(application.previewInputSuppression(COOLANT)),
      '/preview'
    )
    expect(preview.path).toBe(COOLANT)
    expect(preview.suppresses).toEqual([])
    expect(preview.freezes).toEqual([
      expect.objectContaining({ slug: mismatch.slug, gate: 0, states: [{ holds: true }] })
    ])
    const read = parseInputPreview(
      wire(application.previewInputSuppression('electrical.batteries.start.voltage')),
      '/preview'
    )
    expect(read.suppresses).toEqual([
      { rule: `user.${batteries.slug}`, origin: 'user', slug: batteries.slug, instance: 'start' }
    ])
  })

  it('read the load issues in the state', () => {
    const application = running()
    // Built as src/api/routes.ts builds GET /state from the Application.
    const state = parseState(
      wire({
        running: true,
        securityEnabled: true,
        evaluation: application.evaluation,
        issues: application.issues
      })
    )
    expect(state.evaluation).toEqual({ enabled: true })
    expect(state.issues).toEqual([expect.stringMatching(/stored rule broken is not valid/)])
  })
})

describe('ruleset parsers against the Application', () => {
  const VOLTAGE = 'electrical.batteries.house.voltage'
  const low = {
    name: 'Battery low',
    slug: 'low',
    message: 'Battery voltage low',
    priority: 'warning',
    signal: { path: '${prefix}.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'fixed', value: { param: 'lowVoltage' } }
    }
  }
  const hot = { ...low, name: 'Battery hot', slug: 'hot', signal: { path: COOLANT } }

  function batteries(version: string, rules: unknown[]): LoadedRuleset {
    const result = validateRuleset({
      name: 'Battery monitoring',
      slug: 'batteries',
      version,
      description: 'House bank',
      parameters: [
        { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
        { name: 'lowVoltage', type: 'number', unit: 'V', default: 12, minimum: 10, maximum: 14 }
      ],
      rules
    })
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    return {
      slug: 'batteries',
      source: 'package signalk-alert-ruleset-batteries',
      package: { name: 'signalk-alert-ruleset-batteries', version },
      ruleset: result.value
    }
  }

  /**
   * An enabled ruleset with a stored value, upgraded to drop a rule, whose
   * remaining rule reads a path the server has not had.
   */
  function upgraded() {
    const installed = { rulesets: [batteries('1.0.0', [low, hot])] }
    const server = new MockServerAPI(true, dir)
    let now = 0
    const application = new Application(
      {
        ...serverDeps(server.asServerAPI(), PLUGIN),
        clock: () => now,
        wallClock: () => new Date('2026-09-30T12:00:00.000Z')
      },
      new Store(dir),
      () => ({ rulesets: installed.rulesets, problems: [] })
    )
    application.start()
    application.setRulesetEnabled('batteries', true, 'admin')
    application.setRulesetParameters('batteries', { lowVoltage: 11.5 }, 'admin')
    installed.rulesets = [batteries('2.0.0', [low])]
    application.rescan('admin')
    now = 30
    application.tick()
    return application
  }

  /** The panel's strict reader, answered with what the route would send. */
  const rulesetsApi = (body: unknown) =>
    httpRulesetsApi(() => Promise.resolve(new Response(JSON.stringify(body))))

  it('read the ruleset listing', async () => {
    const listing = await rulesetsApi(wire(upgraded().rulesets())).list()
    expect(listing.problems).toEqual([])
    expect(listing.rulesets).toEqual([
      expect.objectContaining({
        slug: 'batteries',
        version: '2.0.0',
        description: 'House bank',
        package: { name: 'signalk-alert-ruleset-batteries', version: '2.0.0' },
        enabled: true,
        parameters: [
          { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
          { name: 'lowVoltage', type: 'number', unit: 'V', default: 12, minimum: 10, maximum: 14 }
        ],
        values: { lowVoltage: 11.5 },
        rules: ['low'],
        missingPaths: [VOLTAGE],
        notices: [
          {
            at: '2026-09-30T12:00:00.000Z',
            message: expect.stringContaining('rule hot') as string
          }
        ]
      })
    ])
  })

  it('read one ruleset as a ruleset action answers it', async () => {
    const entry = wire(upgraded().ruleset('batteries'))
    const read = await rulesetsApi(entry).setEnabled('batteries', true)
    expect(read.slug).toBe('batteries')
  })

  it('read a ruleset rule with its source and the path it is missing', () => {
    const entry = parseRuleEntry(wire(upgraded().rule('batteries', 'low')), '/rules/batteries/low')
    expect(entry).toMatchObject({
      origin: 'batteries',
      ruleset: {
        name: 'Battery monitoring',
        version: '2.0.0',
        package: { name: 'signalk-alert-ruleset-batteries', version: '2.0.0' }
      },
      status: {
        badge: 'inactive',
        reason: 'ruleset path missing',
        issues: [`path ${VOLTAGE} has not been seen`]
      }
    })
  })
})

function progress(total: number) {
  return { progress: { kind: 'total', total, limit: hours.detector.limit } }
}
