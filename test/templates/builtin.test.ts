import { getMetadata } from '@signalk/path-metadata'
import { describe, expect, it } from 'vitest'
import { validateRule } from '../../src/model/validate.js'
import { BUILTIN_TEMPLATES, discoverTemplateSets } from '../../src/templates/discovery.js'
import { instantiate } from '../../src/templates/instantiate.js'
import { isRecord } from '../../src/util.js'
import { templateScenarios } from '../fixtures/template-scenarios.js'
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

function made(id: string) {
  const template = builtin?.templates.find((t) => t.id === id)
  if (builtin === undefined || template === undefined) throw new Error(`no template ${id}`)
  const result = instantiate(builtin, template, templateScenarios[id].pick)
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
