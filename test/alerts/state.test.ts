import { describe, it, expect } from 'vitest'
import {
  CONDITIONS,
  conditionOf,
  instanceState,
  ruleCondition,
  type InstanceFacts,
  type InstanceState
} from '../../src/alerts/state.js'
import type { Judgement } from '../../src/engine/evaluator.js'

const START = '2026-10-02T08:00:00.000Z'

const judged: Judgement = { gatesHold: true, present: false, undecided: false, input: 'value' }
const idle: InstanceFacts = {
  judgement: judged,
  value: 13.1,
  limit: 12,
  gates: [],
  awaitingInput: false
}
/** Idle facts with parts of the judgement and the other facts replaced. */
const judgedAs = (
  judgement: Partial<Judgement>,
  rest: Partial<Omit<InstanceFacts, 'judgement'>> = {}
): InstanceFacts => ({ ...idle, ...rest, judgement: { ...judged, ...judgement } })
const closed = {
  path: 'propulsion.main.revolutions',
  value: 0,
  holds: false,
  input: 'value'
} as const
const timer = { kind: 'timer', toward: 'set', elapsed: 3, target: 5 } as const

const enabled = (facts: InstanceFacts) => instanceState(facts, false, START)
const disabled = (facts: InstanceFacts) => instanceState(facts, true, START)

describe('the state of an instance of an enabled rule', () => {
  it.each<[string, InstanceFacts, Partial<InstanceState>]>([
    [
      'an active alert is alerting, at the priority and step it reached',
      judgedAs({ alert: { step: 1, priority: 'alarm', level: 'alarm' } }, { value: 11.4 }),
      {
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        step: 1,
        level: 'alarm',
        awaitingInput: false,
        value: 11.4,
        limit: 12
      }
    ],
    [
      'an active alert whose input stopped reporting is alerting, awaiting input',
      judgedAs(
        { alert: { step: 0, priority: 'warning' }, input: 'unavailable' },
        { awaitingInput: true }
      ),
      { condition: 'alerting', reason: 'alertActive', awaitingInput: true }
    ],
    [
      'an idle instance is normal, within its limits',
      idle,
      { condition: 'normal', reason: 'withinLimits', value: 13.1, limit: 12 }
    ],
    [
      'an instance waiting out its duration is normal, with no timer',
      judgedAs({}, { value: 11.9, progress: timer }),
      { condition: 'normal', reason: 'withinLimits' }
    ],
    [
      'an instance outside its gate is normal, with the gate facts',
      judgedAs({ gatesHold: false }, { gates: [closed] }),
      { condition: 'normal', reason: 'outsideGate', gates: [closed] }
    ],
    [
      'an unavailable input is no data, with when it last had a value',
      judgedAs({ input: 'unavailable' }, { value: undefined, lastSeen: START }),
      { condition: 'noData', reason: 'inputUnavailable', lastSeen: START }
    ],
    [
      'an input never seen is no data, not a problem',
      judgedAs({ input: 'neverSeen' }, { value: undefined }),
      { condition: 'noData', reason: 'neverReported' }
    ],
    [
      'a missing zone is a problem, over an active alert',
      judgedAs({
        alert: { step: 0, priority: 'warning' },
        problem: { reason: 'missingZone', level: 'warn' }
      }),
      { condition: 'problem', reason: 'missingZone', level: 'warn' }
    ],
    [
      'a path that never times out is a problem with its cause',
      judgedAs({
        problem: { reason: 'timeoutNotPossible', cause: 'updateContract', contract: 'event' }
      }),
      {
        condition: 'problem',
        reason: 'timeoutNotPossible',
        cause: 'updateContract',
        contract: 'event'
      }
    ]
  ])('%s', (_what, facts, state) => {
    expect(enabled(facts)).toMatchObject(state)
    expect(conditionOf(facts.judgement, false)).toBe(state.condition)
  })

  it('reports a clear time once the condition has cleared', () => {
    expect(enabled({ ...idle, clearedAt: START })).toMatchObject({ clearedAt: START })
  })

  it('reports a total and an event count, but no timer', () => {
    const total = { kind: 'total', total: 20, limit: 90 } as const
    expect(enabled({ ...idle, progress: total }).progress).toEqual(total)
    expect(enabled({ ...idle, progress: timer }).progress).toBeUndefined()
  })

  it('does not report a cleared state as clear since start', () => {
    expect(enabled(idle)).not.toHaveProperty('clearSince')
  })
})

describe('the state of an instance of a disabled rule', () => {
  it.each<[string, InstanceFacts, Partial<InstanceState>]>([
    [
      'a condition that holds is present',
      judgedAs({ present: true }, { value: 11.5 }),
      { condition: 'present', reason: 'conditionPresent', value: 11.5 }
    ],
    [
      "an absence rule's silence is present though its input is unavailable",
      judgedAs({ input: 'unavailable', present: true }),
      { condition: 'present', reason: 'conditionPresent' }
    ],
    [
      'an active alert is not alerting, as a disabled rule raises nothing',
      judgedAs({ alert: { step: 0, priority: 'warning' }, present: true }),
      { condition: 'present', reason: 'conditionPresent' }
    ],
    [
      'a condition clear since a known time is normal, cleared then',
      judgedAs({}, { clearedAt: START }),
      { condition: 'normal', reason: 'withinLimits', clearedAt: START }
    ],
    [
      'a condition that has not held since the rule started is clear since then',
      idle,
      { condition: 'normal', reason: 'withinLimits', clearSince: START }
    ],
    [
      'a condition held when the gate closed is normal, outside its gate',
      judgedAs({ present: true, gatesHold: false }, { gates: [closed] }),
      { condition: 'normal', reason: 'outsideGate' }
    ],
    [
      'an input never seen is no data',
      judgedAs({ input: 'neverSeen' }),
      { condition: 'noData', reason: 'neverReported' }
    ],
    [
      'a missing zone is a problem',
      judgedAs({ present: true, problem: { reason: 'missingZone', level: 'alarm' } }),
      { condition: 'problem', reason: 'missingZone' }
    ]
  ])('%s', (_what, facts, state) => {
    expect(disabled(facts)).toMatchObject(state)
    expect(conditionOf(facts.judgement, true)).toBe(state.condition)
  })

  it('a clear time known is not also a clear since start', () => {
    expect(disabled({ ...idle, clearedAt: START })).not.toHaveProperty('clearSince')
  })

  it('a condition held across a gate cycle and undecided since is normal, with no clear time', () => {
    const resuming = judgedAs({ undecided: true })
    const state = disabled(resuming)
    expect(state).toMatchObject({ condition: 'normal', reason: 'withinLimits' })
    expect(state).not.toHaveProperty('clearSince')
    expect(state).not.toHaveProperty('clearedAt')
    expect(conditionOf(resuming.judgement, true)).toBe('normal')
  })
})

describe('the condition of a rule', () => {
  const alerting = enabled(
    judgedAs(
      { alert: { step: 0, priority: 'warning' } },
      { instance: { name: 'port', segment: 'port' } }
    )
  )
  const normal = enabled({ ...idle, instance: { name: 'aft', segment: 'aft' } })
  const noData = enabled(
    judgedAs({ input: 'neverSeen' }, { instance: { name: 'fwd', segment: 'fwd' } })
  )
  const problem = enabled(
    judgedAs(
      { problem: { reason: 'missingZone', level: 'warn' } },
      { instance: { name: 'mid', segment: 'mid' } }
    )
  )

  it('a wildcard rule with one alerting instance is alerting, as that instance', () => {
    expect(ruleCondition(false, [normal, alerting, normal])).toEqual(alerting)
  })

  it('takes its worst instance, in the order alerting, problem, no data, normal', () => {
    expect(ruleCondition(false, [normal, noData, problem]).condition).toBe('problem')
    expect(ruleCondition(false, [normal, noData]).condition).toBe('noData')
    expect(ruleCondition(false, [normal]).condition).toBe('normal')
    expect(ruleCondition(false, [problem, alerting]).condition).toBe('alerting')
  })

  it('takes the first of equally bad instances', () => {
    const second = enabled(
      judgedAs({ input: 'neverSeen' }, { instance: { name: 'b', segment: 'b' } })
    )
    expect(ruleCondition(false, [noData, second])).toBe(noData)
  })

  it('a rule with an evaluation error is a problem, even with an alerting instance', () => {
    expect(ruleCondition(true, [normal])).toEqual({
      condition: 'problem',
      reason: 'evaluationError'
    })
    expect(ruleCondition(true, [alerting]).condition).toBe('problem')
  })

  it('a wildcard rule with no instance yet has no data', () => {
    expect(ruleCondition(false, [])).toEqual({ condition: 'noData', reason: 'neverReported' })
  })

  it('lists the conditions worst first', () => {
    expect(CONDITIONS).toEqual(['alerting', 'present', 'problem', 'noData', 'normal'])
  })
})
