import { getMetadata } from '@signalk/path-metadata'
import { describe, expect, it } from 'vitest'
import { alertPathOf, alertPathsOverlap } from '../../src/alerts/paths.js'
import type { TemplatePick } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'
import { BUILTIN_TEMPLATES, discoverTemplateSets } from '../../src/templates/discovery.js'
import { instantiate } from '../../src/templates/instantiate.js'
import { isRecord } from '../../src/util.js'
import { templateScenarios } from '../fixtures/template-scenarios.js'
import { at, every, type Scenario } from '../helpers/scenario.js'
import { runScenario } from '../helpers/runScenario.js'
import { singleSlotRule } from '../helpers/singleSlotRule.js'

const discovered = discoverTemplateSets({ builtin: BUILTIN_TEMPLATES })
const builtin = discovered.sets.find((s) => s.set.id === 'builtin')?.set
if (builtin === undefined) throw new Error('the built-in set did not load')

// The specification has no bilge pump path; pumps are reported as switches,
// as digital switching does, so the bilge pump templates watch one.
const SWITCH_STATE = /^electrical\.switches\.[^.]+\.state$/

// Engine vocabulary the webapp never shows (R7).
const ENGINE_WORDS =
  /\b(detector|sustained|accumulat\w*|zones?|gates?|hysteresis|combinator|threshold|timed ?out)\b/i

/** Every path a rule reads: its signal's, its gates', its zone limits'. */
function pathsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(pathsOf)
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'path' && typeof child === 'string' ? [child] : pathsOf(child)
  )
}

function made(id: string, pick: TemplatePick = templateScenarios[id].pick) {
  const template = builtin?.templates.find((t) => t.id === id)
  if (builtin === undefined || template === undefined) throw new Error(`no template ${id}`)
  const result = instantiate(builtin, template, pick)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

describe('built-in template set', () => {
  it('loads without problems, with 15 to 20 templates', () => {
    expect(discovered.problems).toEqual([])
    expect(builtin.templates.length).toBeGreaterThanOrEqual(15)
    expect(builtin.templates.length).toBeLessThanOrEqual(20)
  })

  it('has a scenario for every template', () => {
    expect(Object.keys(templateScenarios).sort()).toEqual(builtin.templates.map((t) => t.id).sort())
  })

  it('leaves no anchor drag template', () => {
    const anchor = builtin.templates.filter((t) => pathsOf(t.rule).some((p) => /anchor/i.test(p)))
    expect(anchor).toEqual([])
  })

  for (const template of builtin.templates) {
    describe(template.id, () => {
      it('makes a valid rule from a pick', () => {
        expect(validateRule(made(template.id))).toMatchObject({ ok: true })
      })

      if (template.slots === undefined)
        it('makes the rule it made before templates had slots', () => {
          const { pick } = templateScenarios[template.id]
          expect(made(template.id)).toEqual(singleSlotRule(builtin, template, pick))
        })

      it('reads only Signal K specification paths', () => {
        const unknown = pathsOf(made(template.id)).filter(
          (path) => !SWITCH_STATE.test(path) && getMetadata(`vessels.self.${path}`) === undefined
        )
        expect(unknown).toEqual([])
      })

      it('has a plain name, description and message', () => {
        const { name, message } = template.rule
        expect(template.description).toBeTruthy()
        for (const text of [name, message, template.description])
          expect(String(text)).not.toMatch(ENGINE_WORDS)
      })

      it('raises and clears as its scenario expects', () => {
        const { scenario } = templateScenarios[template.id]
        expect(runScenario(made(template.id), scenario)).toEqual({
          steps: scenario.expected,
          problems: []
        })
      })
    })
  }
})

describe('alternator-not-charging', () => {
  const ALTERNATOR = 'alternator-not-charging'

  it('watches a battery while an engine runs, naming the alert after the engine', () => {
    const rule = made(ALTERNATOR, { battery: 'house', engine: 'port' })
    expect(rule).toMatchObject({
      name: 'Engine port alternator not charging',
      signal: { path: 'electrical.batteries.house.voltage' },
      gates: [{ signal: { path: 'propulsion.port.revolutions' } }]
    })
    expect(alertPathOf(rule)).toBe('electrical.batteries.house.portAlternatorNotCharging')
  })

  it('gives two engines charging one battery their own rules and alerts', () => {
    const main = made(ALTERNATOR, { battery: 'start', engine: 'main' })
    const port = made(ALTERNATOR, { battery: 'start', engine: 'port' })
    expect(validateRule(main)).toMatchObject({ ok: true })
    expect(validateRule(port)).toMatchObject({ ok: true })
    expect(main.slug).not.toBe(port.slug)
    const paths = [alertPathOf(main), alertPathOf(port)]
    expect(paths).toEqual([
      'electrical.batteries.start.mainAlternatorNotCharging',
      'electrical.batteries.start.portAlternatorNotCharging'
    ])
    expect(alertPathsOverlap(String(paths[0]), String(paths[1]))).toBe(false)
  })

  it('refuses a pick that leaves the engine open', () => {
    const template = builtin.templates.find((t) => t.id === ALTERNATOR)
    if (template === undefined) throw new Error(`no template ${ALTERNATOR}`)
    expect(instantiate(builtin, template, { battery: 'start' })).toEqual({
      ok: false,
      errors: [{ path: '/engine', message: 'is required: the template leaves it open' }]
    })
  })

  // A rule stored from the template before it had slots: its own paths and
  // pick, and the set version it was made from.
  const OLD_PATH = 'propulsion.main.alternatorVoltage'
  const old = {
    name: 'Engine main alternator not charging',
    slug: 'alternator-not-charging-main',
    condition: 'alternatorNotCharging',
    message: 'Engine main alternator not charging: {value}',
    signal: { path: OLD_PATH },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [{ limit: 13.0, priority: 'warning' }],
      duration: 120
    },
    gates: [
      {
        signal: { path: 'propulsion.main.revolutions' },
        direction: 'above',
        limit: { kind: 'fixed', value: 8 },
        duration: 30
      }
    ],
    template: { set: 'builtin', id: ALTERNATOR, version: '1.0.0', pick: { instance: 'main' } }
  }

  it('still validates a rule made from the template before it had slots', () => {
    expect(validateRule(old)).toEqual({ ok: true, value: old })
  })

  it('still runs a rule made from the template before it had slots', () => {
    const RPM = 'propulsion.main.revolutions'
    const result = validateRule(old)
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const scenario: Scenario = {
      tick: 1,
      until: 700,
      deltas: [
        at(0, RPM, 0),
        ...every(10, 10, 700, (t) => at(t, RPM, 15)),
        at(0, OLD_PATH, 14.2),
        at(300, OLD_PATH, 12.7),
        at(600, OLD_PATH, 14.0)
      ],
      expected: [
        [420, 'raise', 'propulsion.main.alternatorNotCharging', 'warning'],
        [600, 'clear', 'propulsion.main.alternatorNotCharging']
      ]
    }
    expect(runScenario(result.value, scenario)).toEqual({
      steps: scenario.expected,
      problems: []
    })
  })
})
