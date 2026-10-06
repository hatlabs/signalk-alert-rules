import { describe, it, expect } from 'vitest'
import { RuleEvaluator, type RuleEvent } from '../../src/engine/evaluator.js'
import { openSignal, type Reading } from '../../src/engine/signals.js'
import { ruleAlertPath } from '../../src/model/alertPath.js'
import type { Rule, Signal } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'
import { workedExamples } from '../fixtures/worked-examples.js'
import { workedExampleDeltas } from '../fixtures/worked-example-deltas.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

function signalsOf(rule: Rule): [string, Signal][] {
  return [
    ['signal', rule.signal],
    ...(rule.gates ?? []).map((g, i): [string, Signal] => [`gate${String(i)}`, g.signal])
  ]
}

function expectReading(actual: Reading | undefined, expected: Reading): void {
  if (expected.available && typeof expected.value === 'number') {
    expect(actual?.available).toBe(true)
    expect(actual?.available && actual.value).toBeCloseTo(expected.value, 6)
  } else {
    expect(actual).toEqual(expected)
  }
}

describe('worked example signals from recorded deltas', () => {
  it('covers every worked example', () => {
    expect(Object.keys(workedExampleDeltas).sort()).toEqual(Object.keys(workedExamples).sort())
  })

  for (const [key, example] of Object.entries(workedExamples)) {
    it(key, () => {
      const validated = validateRule(example)
      if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
      const recorded = workedExampleDeltas[key]

      const sm = new FakeSubscriptionManager(recorded.ranking)
      const last = new Map<string, Reading>()
      for (const [name, signal] of signalsOf(validated.value)) {
        openSignal(signal, sm, {
          onSample: (s) => last.set(`${name}|${s.instance?.name ?? ''}`, s.reading),
          onIssue: (m) => {
            throw new Error(m)
          },
          onError: (e) => {
            throw e
          }
        })
      }
      for (const d of recorded.deltas) sm.publish(d.path, d.source, d.value, d.state)

      for (const e of recorded.expected) {
        expectReading(last.get(`${e.signal}|${e.instance ?? ''}`), e.reading)
      }
      expect(last.size).toBe(recorded.expected.length)
    })
  }
})

// Signal K reports roll only inside navigation.attitude's object value, so a
// heel alert watches that field.
describe('heel from the roll of navigation.attitude', () => {
  const DEG = Math.PI / 180
  const heel = validateRule({
    name: 'Heel',
    slug: 'heel',
    message: 'Heel {value} past {limit}',
    signal: { path: 'navigation.attitude#/roll' },
    detector: {
      type: 'outside',
      steps: [{ low: -20 * DEG, high: 20 * DEG, priority: 'warning' }],
      duration: 5
    }
  })

  it('alerts while the roll stays outside the range and clears when it is back inside', () => {
    if (!heel.ok) throw new Error(JSON.stringify(heel.errors))
    expect(ruleAlertPath(heel.value)).toBe('navigation.attitude.rollOutOfRange')
    const sm = new FakeSubscriptionManager()
    const events: [number, RuleEvent['type'], number | undefined][] = []
    let now = 0
    const evaluator = new RuleEvaluator(
      heel.value,
      {
        subscriptions: sm,
        meta: (path) => (path === 'navigation.attitude#/roll' ? { units: 'rad' } : undefined),
        timeoutSettings: () => ({ enforce: true, useDefaults: true }),
        clock: () => now
      },
      (e) => events.push([now, e.type, e.type === 'raise' ? e.limit : undefined])
    )
    evaluator.start()
    const attitude = (t: number, roll: number) => {
      now = t
      sm.publish('navigation.attitude', 'imu', { roll, pitch: 0.02, yaw: 1.2 })
    }
    attitude(0, 0.1)
    attitude(1, 0.4)
    now = 5
    evaluator.tick()
    expect(events).toEqual([])
    now = 6
    evaluator.tick()
    attitude(8, 0.1)
    expect(events).toEqual([
      [6, 'raise', 20 * DEG],
      [8, 'clear', undefined]
    ])
  })
})
