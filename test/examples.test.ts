import { describe, it, expect } from 'vitest'
import type { AlertValue } from '../src/alerts/emitter.js'
import { RuleRunner } from '../src/alerts/runner.js'
import { validateRule } from '../src/model/validate.js'
import { exampleScenarios, type AlertStep, type Scenario } from './fixtures/example-scenarios.js'
import { workedExamples } from './fixtures/worked-examples.js'
import { FakeSubscriptionManager } from './helpers/FakeSubscriptionManager.js'

/**
 * Runs a rule through the runner as the plugin would, from an empty alerts
 * store. Returns what it sends to core with heartbeats left out (a raise of
 * an alert not active, a changed priority of one that is, and a clear) and
 * the rule's issues and inactive reasons at the end.
 */
function run(rule: unknown, scenario: Scenario): { steps: AlertStep[]; problems: string[] } {
  const validated = validateRule(rule)
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
  const sm = new FakeSubscriptionManager(scenario.ranking)
  const steps: AlertStep[] = []
  const active = new Map<string, AlertValue>()
  let now = 0
  const runner = new RuleRunner(
    {
      pluginId: 'signalk-alert-rules',
      subscriptions: sm,
      meta: (path) => scenario.meta?.[path],
      timeoutSettings: () => ({ enforce: true, useDefaults: true }),
      clock: () => now,
      wallClock: () => new Date('2026-09-30T12:00:00Z'),
      alerts: { list: () => [] },
      send: (path, value) => {
        if (value === null) {
          active.delete(path)
          steps.push([now, 'clear', path])
          return
        }
        const previous = active.get(path)
        if (previous === undefined) steps.push([now, 'raise', path, value.priority])
        else if (previous.priority !== value.priority)
          steps.push([now, 'priority', path, value.priority])
        // A latching raise is a whole occurrence; core holds nothing active for it.
        if (!value.latching) active.set(path, value)
      }
    },
    [validated.value]
  )
  runner.start()

  const deltas = [...scenario.deltas].sort((a, b) => a.t - b.t)
  const times = new Set(deltas.map((d) => d.t))
  for (let t = 0; t <= scenario.until; t += scenario.tick) times.add(t)
  let next = 0
  for (const t of [...times].sort((a, b) => a - b)) {
    now = t
    for (; next < deltas.length && deltas[next].t === t; next++) {
      const d = deltas[next]
      sm.publish(d.path, d.source, d.value, d.state)
    }
    runner.tick()
  }
  const status = runner.status(validated.value.slug)
  if (status === undefined) throw new Error('the rule has no status')
  const problems = [
    ...status.issues,
    ...status.instances.flatMap((i) => (i.inactive === undefined ? [] : [i.inactive]))
  ]
  return { steps, problems }
}

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
        expect(run(rule, scenario)).toEqual({ steps: scenario.expected, problems: [] })
      })
    })
  }
})
