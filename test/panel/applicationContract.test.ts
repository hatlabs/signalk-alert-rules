import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Value } from '@signalk/server-api'
import { serverDeps } from '../../src/alerts/server'
import { UNAUTHENTICATED } from '../../src/api/routes'
import { Application } from '../../src/application'
import {
  isInvalid,
  parseRuleEntry,
  parseRules,
  parseState,
  parseTemplates,
  UNAUTHENTICATED_ACTOR,
  type RuleEntry
} from '../../src/panel/api'
import { byAttention, chipOf, summary } from '../../src/panel/list/attention'
import { currentFact } from '../../src/panel/list/fact'
import { NO_UNITS } from '../../src/panel/signalUnits'
import { Store } from '../../src/store/store'
import { BUILTIN_TEMPLATES, discoverTemplateSets } from '../../src/templates/discovery'
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
  return new Map(
    parseRules(wire(application.rules())).flatMap((entry) =>
      isInvalid(entry) ? [] : [[entry.slug, entry] as const]
    )
  )
}

describe('panel parsers against the Application', () => {
  it('know the actor the routes record for a request without a login', () => {
    expect(UNAUTHENTICATED_ACTOR).toBe(UNAUTHENTICATED)
  })

  it('read every rule entry the Application answers, the invalid stored rule last', () => {
    const slugs = parseRules(wire(running().rules())).map((entry) => entry.slug)
    expect(slugs.at(-1)).toBe('broken')
    expect(slugs.slice(0, -1).sort()).toEqual([
      'battery-low',
      'engine-hours',
      'oil-pressure-low',
      'rpm-mismatch'
    ])
  })

  it('read the invalid stored rule as a problem, named and with its errors', () => {
    const invalid = parseRules(wire(running().rules())).find((entry) => entry.slug === 'broken')
    expect(invalid).toMatchObject({
      name: broken.name,
      status: { ruleState: 'enabled', condition: 'problem', reason: 'invalidRule' }
    })
    const errors = invalid !== undefined && isInvalid(invalid) ? invalid.invalid.errors : []
    expect(errors.map((e) => e.path)).toEqual(['/detector/steps/0/limit'])
  })

  it('read a running rule with an active alert, its priority, message and change time', () => {
    const entry = parsedRules(running()).get(oil.slug)
    expect(entry?.disabled).toBeUndefined()
    expect(entry).toMatchObject({
      rule: {
        name: oil.name,
        priority: 'alarm',
        steps: oil.detector.steps,
        duration: oil.detector.duration,
        message: oil.message,
        detector: { type: 'sustained' }
      },
      status: {
        ruleState: 'enabled',
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        step: 0,
        message: oil.message
      }
    })
    expect(Number.isNaN(Date.parse(entry?.status.changedAt ?? ''))).toBe(false)
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
    writeFileSync(join(dir, 'rules', 'garbled.json'), '{')
    const application = running()
    // Built as src/api/routes.ts builds GET /state from the Application.
    const state = parseState(
      wire({
        running: true,
        securityEnabled: true,
        permissions: 'readwrite',
        issues: application.issues
      })
    )
    expect(state.issues).toEqual([expect.stringMatching(/garbled\.json could not be read/)])
  })
})

describe('the template listing over what the Application answers', () => {
  function withBuiltin() {
    const server = new MockServerAPI(true, dir)
    const application = new Application(
      serverDeps(server.asServerAPI(), PLUGIN),
      new Store(dir),
      () => discoverTemplateSets({ builtin: BUILTIN_TEMPLATES })
    )
    application.start()
    return application
  }

  it('reads the built-in set with every template new, and none once dismissed', () => {
    const application = withBuiltin()
    const [builtin] = parseTemplates(wire(application.templates()), '/templates').sets
    expect(builtin.source).toBe('built-in')
    expect(builtin.new).toEqual(builtin.templates.map((t) => t.id))
    const shown = { builtin: builtin.new }
    const dismissed = parseTemplates(wire(application.dismissTemplates(shown)), '/templates')
    expect(dismissed.sets.map((s) => s.new)).toEqual([[]])
  })
})

describe('the rule list over what the Application answers', () => {
  const NOW = Date.parse('2026-09-30T12:00:00.000Z')

  it('orders, counts and words every rule', () => {
    const rules = byAttention(parseRules(wire(running().rules())))
    expect(
      rules.map((entry) => [entry.slug, chipOf(entry), currentFact(entry, NO_UNITS, NOW)])
    ).toEqual([
      // Raised at the same time, so in the order the server lists them.
      ['battery-low', 'alerting', 'start at 11.5: below 12'],
      ['oil-pressure-low', 'alerting', '0: below 100000'],
      ['broken', 'problem', 'The stored rule is not valid'],
      ['engine-hours', 'disabled', 'Condition clear for at least 20 s'],
      ['rpm-mismatch', 'disabled', '“sender loose”. Condition still present: 10']
    ])
    expect(summary(rules)).toBe('2 alerting · 1 problem · 2 disabled')
  })
})

function progress(total: number) {
  return { progress: { kind: 'total', total, limit: hours.detector.steps[0].limit } }
}
