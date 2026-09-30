import { describe, it, expect } from 'vitest'
import { BADGES, statusBadge, type InstanceFacts } from '../../src/alerts/badge.js'

const idle: InstanceFacts = { active: false, input: 'value', gates: [] }
const holding = { holds: true, input: 'value' } as const

describe('status badge', () => {
  it.each<[string, InstanceFacts, (typeof BADGES)[number]]>([
    ['inactive', { ...idle, inactive: 'the path has no warn zone', active: true }, 'inactive'],
    ['alert active', { ...idle, active: true, input: 'unavailable' }, 'alertActive'],
    [
      'gated off',
      { ...idle, input: 'neverSeen', gates: [holding, { holds: false, input: 'value' }] },
      'gatedOff'
    ],
    [
      'input unavailable',
      {
        ...idle,
        input: 'unavailable',
        progress: { kind: 'timer', toward: 'set', elapsed: 3, target: 5 }
      },
      'inputUnavailable'
    ],
    [
      'never seen',
      {
        ...idle,
        input: 'neverSeen',
        progress: { kind: 'timer', toward: 'set', elapsed: 3, target: 5 }
      },
      'neverSeen'
    ],
    [
      'timer running',
      {
        ...idle,
        gates: [holding],
        progress: { kind: 'timer', toward: 'set', elapsed: 3, target: 5 }
      },
      'timerRunning'
    ],
    ['idle', idle, 'idle'],
    [
      'idle with an event count',
      { ...idle, progress: { kind: 'events', count: 2, limit: 4 } },
      'idle'
    ],
    ['idle with a total', { ...idle, progress: { kind: 'total', total: 20, limit: 90 } }, 'idle']
  ])('an instance that is %s', (_what, facts, badge) => {
    expect(statusBadge([], [facts]).instances[0]?.badge).toBe(badge)
    expect(statusBadge([], [facts]).badge).toBe(badge)
  })

  it('a rule with an evaluation error is errored with the error as its reason', () => {
    const status = statusBadge(['evaluation failed: boom', 'other'], [{ ...idle, active: true }])
    expect(status).toMatchObject({ badge: 'errored', reason: 'evaluation failed: boom' })
    expect(status.instances[0]?.badge).toBe('alertActive')
  })

  it('an inactive instance carries its reason to the rule', () => {
    const status = statusBadge([], [idle, { ...idle, inactive: 'no timeout marker possible' }])
    expect(status).toMatchObject({ badge: 'inactive', reason: 'no timeout marker possible' })
    expect(status.instances[1]).toMatchObject({
      badge: 'inactive',
      reason: 'no timeout marker possible'
    })
    expect(status.instances[0]?.reason).toBeUndefined()
  })

  it('a rule has the badge of its highest-precedence instance', () => {
    const status = statusBadge(
      [],
      [
        { ...idle, gates: [{ holds: false, input: 'value' }] },
        { ...idle, active: true },
        { ...idle, input: 'neverSeen' }
      ]
    )
    expect(status.badge).toBe('alertActive')
    expect(status.instances.map((i) => i.badge)).toEqual(['gatedOff', 'alertActive', 'neverSeen'])
  })

  it('a wildcard rule with no instance yet has never seen its input', () => {
    expect(statusBadge([], [])).toEqual({ badge: 'neverSeen', subLabels: [], instances: [] })
  })

  it('a timer toward clearing is not a running timer', () => {
    const progress = { kind: 'timer', toward: 'clear', elapsed: 1, target: 5 } as const
    expect(statusBadge([], [{ ...idle, progress }]).badge).toBe('idle')
  })

  describe('sub-labels', () => {
    it('gate input unavailable, on a gate that keeps holding', () => {
      const status = statusBadge(
        [],
        [{ ...idle, gates: [holding, { holds: true, input: 'unavailable' }] }]
      )
      expect(status).toMatchObject({ badge: 'idle', subLabels: ['gateInputUnavailable'] })
    })

    it('waiting for clear, while an active alert times its clear duration', () => {
      const progress = { kind: 'timer', toward: 'clear', elapsed: 1, target: 5 } as const
      const status = statusBadge([], [{ ...idle, active: true, progress }])
      expect(status).toMatchObject({ badge: 'alertActive', subLabels: ['waitingForClear'] })
    })

    it('awaiting input, for an alert whose heartbeat has stopped', () => {
      const status = statusBadge(
        [],
        [{ ...idle, active: true, input: 'unavailable', awaitingInput: true }]
      )
      expect(status).toMatchObject({ badge: 'alertActive', subLabels: ['awaitingInput'] })
    })

    it('are the union of the instances, in a fixed order', () => {
      const progress = { kind: 'timer', toward: 'clear', elapsed: 1, target: 5 } as const
      const status = statusBadge(
        [],
        [
          { ...idle, active: true, awaitingInput: true },
          { ...idle, active: true, progress, gates: [{ holds: true, input: 'unavailable' }] }
        ]
      )
      expect(status.subLabels).toEqual(['gateInputUnavailable', 'waitingForClear', 'awaitingInput'])
      expect(status.instances[0]?.subLabels).toEqual(['awaitingInput'])
    })
  })

  it('lists the badges in precedence order', () => {
    expect(BADGES).toEqual([
      'disabled',
      'suppressed',
      'errored',
      'inactive',
      'alertActive',
      'gatedOff',
      'inputUnavailable',
      'neverSeen',
      'timerRunning',
      'idle'
    ])
  })
})

describe('suppressed status', () => {
  it('an input-suppressed instance is suppressed with its scope, above an error', () => {
    const scope = { scope: 'input', path: 'propulsion.port.oilPressure' } as const
    const status = statusBadge(['evaluation failed: boom'], [{ ...idle, suppression: scope }, idle])
    expect(status).toMatchObject({ badge: 'suppressed', suppression: scope, subLabels: [] })
    expect(status.reason).toBeUndefined()
    expect(status.instances.map((i) => i.badge)).toEqual(['suppressed', 'idle'])
    expect(status.instances[0]?.suppression).toEqual(scope)
  })

  it('a rule-level suppression makes a rule with no instance yet suppressed', () => {
    const scope = { scope: 'rule' } as const
    expect(statusBadge([], [], scope)).toMatchObject({ badge: 'suppressed', suppression: scope })
  })

  it('a suppression that ends by itself waits for clear', () => {
    const scope = { scope: 'rule', autoEndAfter: 600 } as const
    const status = statusBadge([], [{ ...idle, suppression: scope }], scope)
    expect(status.subLabels).toEqual(['waitingForClear'])
    expect(status.instances[0]?.subLabels).toEqual(['waitingForClear'])
  })
})
