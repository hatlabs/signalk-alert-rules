import { describe, it, expect } from 'vitest'
import { RuleEvaluator } from '../../src/engine/evaluator.js'
import { validateRule } from '../../src/model/validate.js'
import { workedExamples } from '../fixtures/worked-examples.js'
import { workedExampleDeltas } from '../fixtures/worked-example-deltas.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

const TICK = 10
const RUN = 2 * 3600

// What each worked example raises when its recorded deltas arrive at time 0
// and the evaluator then ticks for two hours.
const expected: Record<string, [number, string, string, string?][]> = {
  batteryLowFromZones: [[60, 'raise', '', 'warning']],
  bilgePumpCyclesPerHour: [],
  engineHoursSinceService: [],
  coolantTemperatureTrend: [],
  freshWaterProjectedEmpty: [],
  twinEngineRpmDifference: [[40, 'raise', '', 'caution']],
  gnssPositionSpread: [],
  watchAcknowledgementAbsent: [[900, 'raise', '', 'alarm']],
  headingDifference: [],
  engineStateChange: [
    [0, 'raise', 'port', 'warning'],
    [0, 'clear', 'port']
  ],
  depthSensorTimeout: [[30, 'raise', '', 'warning']]
}

describe('worked example rules from recorded deltas', () => {
  it('covers every worked example', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(workedExamples).sort())
  })

  for (const [key, example] of Object.entries(workedExamples)) {
    it(key, () => {
      const validated = validateRule(example)
      if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
      const recorded = workedExampleDeltas[key]
      const sm = new FakeSubscriptionManager(recorded.ranking)
      let now = 0
      const log: [number, string, string, string?][] = []
      const evaluator = new RuleEvaluator(
        validated.value,
        {
          subscriptions: sm,
          meta: (path) => recorded.meta?.[path],
          timeoutSettings: () => ({ enforce: true, useDefaults: true }),
          clock: () => now
        },
        (e) => {
          const at = e.instance?.segment ?? ''
          log.push(e.type === 'clear' ? [now, e.type, at] : [now, e.type, at, e.priority])
        }
      )
      evaluator.start()
      for (const d of recorded.deltas) sm.publish(d.path, d.source, d.value, d.state)
      for (now = TICK; now <= RUN; now += TICK) evaluator.tick()

      expect(log).toEqual(expected[key])
      expect(evaluator.status().issues).toEqual([])
    })
  }
})
