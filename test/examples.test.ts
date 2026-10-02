import { describe, it, expect } from 'vitest'
import { validateRule } from '../src/model/validate.js'
import { exampleScenarios } from './fixtures/example-scenarios.js'
import { workedExamples } from './fixtures/worked-examples.js'
import { runScenario } from './helpers/runScenario.js'

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
