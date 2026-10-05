import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import type { TemplatePick } from '../src/model/rule.js'
import type { Template } from '../src/model/template.js'
import { validateRule } from '../src/model/validate.js'
import { discoverTemplateSets, type DiscoveryResult } from '../src/templates/discovery.js'
import { instantiate } from '../src/templates/instantiate.js'
import { exampleScenarios } from './fixtures/example-scenarios.js'
import { workedExamples } from './fixtures/worked-examples.js'
import { runScenario } from './helpers/runScenario.js'
import { singleSlotRule } from './helpers/singleSlotRule.js'
import { at, type Scenario } from './helpers/scenario.js'

const EXAMPLE_PACKAGE = 'signalk-alert-templates-example'
const EXAMPLE_DIR = join(import.meta.dirname, '..', 'examples', 'template-set-example')

describe('worked examples', () => {
  it('has a scenario for every example rule file', () => {
    expect(Object.keys(exampleScenarios).sort()).toEqual(Object.keys(workedExamples).sort())
  })

  for (const [slug, rule] of Object.entries(workedExamples)) {
    describe(slug, () => {
      it('is a valid rule named after its file', () => {
        const result = validateRule(rule)
        expect(result).toMatchObject({ ok: true, value: { slug } })
      })

      it('raises and clears as the scenario expects', () => {
        const scenario = exampleScenarios[slug]
        expect(runScenario(rule, scenario)).toEqual({ steps: scenario.expected, problems: [] })
      })
    })
  }
})

/** A pick for each part the template leaves open, as a user would make it. */
function pickFor(template: Template): TemplatePick {
  const open = template.open ?? []
  return {
    ...(open.includes('instance') ? { instance: 'house' } : {}),
    ...(open.includes('source') ? { source: 'sounder.bow' } : {})
  }
}

describe('example template set package', () => {
  let configDir: string
  let found: DiscoveryResult

  // Installed as the server installs a package: copied into its config
  // directory's node_modules and listed in that directory's package.json.
  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'skar-example-'))
    await mkdir(join(configDir, 'node_modules'))
    await cp(EXAMPLE_DIR, join(configDir, 'node_modules', EXAMPLE_PACKAGE), { recursive: true })
    const dependencies = { [EXAMPLE_PACKAGE]: '1.0.0' }
    await writeFile(join(configDir, 'package.json'), JSON.stringify({ dependencies }))
    found = discoverTemplateSets({ configDir })
  })

  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true })
  })

  it('is discovered from the packages the server installed', () => {
    expect(found.problems).toEqual([])
    expect(found.sets).toHaveLength(1)
    expect(found.sets[0]).toMatchObject({
      source: `package ${EXAMPLE_PACKAGE}`,
      package: { name: EXAMPLE_PACKAGE, version: '1.0.0' }
    })
  })

  it('has a template with an open instance and one with an open source', () => {
    const open = found.sets[0].set.templates.map((t) => t.open)
    expect(open).toEqual([['instance'], ['source']])
  })

  it('makes a valid rule from each template with a pick for its open parts', () => {
    const { set } = found.sets[0]
    for (const template of set.templates) {
      const pick = pickFor(template)
      const made = instantiate(set, template, pick)
      if (!made.ok) throw new Error(`${template.id}: ${JSON.stringify(made.errors)}`)
      expect(validateRule(made.value), template.id).toMatchObject({
        ok: true,
        value: { template: { set: set.id, id: template.id, version: set.version, pick } }
      })
    }
  })

  it('makes from each template the rule it made before templates had slots', () => {
    const { set } = found.sets[0]
    for (const template of set.templates) {
      const pick = pickFor(template)
      expect(instantiate(set, template, pick), template.id).toEqual({
        ok: true,
        value: singleSlotRule(set, template, pick)
      })
    }
  })

  it('fills the picked instance into the path, name and message', () => {
    const { set } = found.sets[0]
    expect(instantiate(set, set.templates[0], { instance: 'house' })).toMatchObject({
      ok: true,
      value: {
        slug: 'battery-discharge-high-house',
        name: 'Battery house discharging hard',
        message: 'Battery house discharge beyond {limit}: {value}',
        signal: { path: 'electrical.batteries.house.current' }
      }
    })
  })

  it('reads only the picked source', () => {
    const { set } = found.sets[0]
    expect(instantiate(set, set.templates[1], { source: 'sounder.bow' })).toMatchObject({
      ok: true,
      value: { signal: { path: 'environment.depth.belowTransducer', source: 'sounder.bow' } }
    })
  })

  /** Instantiates the template with `pick` and runs the rule through `scenario`. */
  function run(templateId: string, pick: TemplatePick, scenario: Scenario) {
    const { set } = found.sets[0]
    const template = set.templates.find((t) => t.id === templateId)
    if (template === undefined) throw new Error(`no template ${templateId}`)
    const made = instantiate(set, template, pick)
    if (!made.ok) throw new Error(`${templateId}: ${JSON.stringify(made.errors)}`)
    return runScenario(made.value, scenario)
  }

  // Beyond -100 A from 10 s, beyond -150 A from 100 s. -97 A at 200 s is
  // within the 5 A the discharge must ease by, so only -90 A clears.
  it('raises a hard discharge, escalates it and clears past the hysteresis', () => {
    const CURRENT = 'electrical.batteries.house.current'
    const ALERT = 'electrical.batteries.house.dischargeHigh'
    const samples: [number, number][] = [
      [0, -20],
      [10, -120],
      [100, -160],
      [200, -97],
      [300, -90]
    ]
    const scenario: Scenario = {
      tick: 1,
      until: 400,
      deltas: samples.map(([t, value]) => at(t, CURRENT, value)),
      expected: [
        [40, 'raise', ALERT, 'warning'],
        [130, 'priority', ALERT, 'alarm'],
        [300, 'clear', ALERT]
      ]
    }
    expect(run('battery-discharge-high', { instance: 'house' }, scenario)).toEqual({
      steps: scenario.expected,
      problems: []
    })
  })

  // The stern sounder ranks first and reads shallow from 10 s, which the
  // rule ignores; the picked bow sounder reads shallow from 100 s and
  // recovers past the 0.3 m hysteresis at 200 s.
  it('alerts on the picked source and ignores another', () => {
    const DEPTH = 'environment.depth.belowTransducer'
    const ALERT = 'environment.depth.belowTransducerShallow'
    const scenario: Scenario = {
      ranking: ['sounder.stern', 'sounder.bow'],
      tick: 1,
      until: 300,
      deltas: [
        at(0, DEPTH, 10, 'sounder.stern'),
        at(0, DEPTH, 10, 'sounder.bow'),
        at(10, DEPTH, 2, 'sounder.stern'),
        at(100, DEPTH, 2.5, 'sounder.bow'),
        at(200, DEPTH, 3.5, 'sounder.bow')
      ],
      expected: [
        [105, 'raise', ALERT, 'warning'],
        [200, 'clear', ALERT]
      ]
    }
    expect(run('sounder-shallow', { source: 'sounder.bow' }, scenario)).toEqual({
      steps: scenario.expected,
      problems: []
    })
  })

  it('refuses a use that leaves an open part unpicked', () => {
    const { set } = found.sets[0]
    expect(instantiate(set, set.templates[0], {})).toEqual({
      ok: false,
      errors: [{ path: '/instance', message: 'is required: the template leaves it open' }]
    })
  })
})
