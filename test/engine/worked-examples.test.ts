import { describe, it, expect } from 'vitest'
import { openSignal, type Reading } from '../../src/engine/signals.js'
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
