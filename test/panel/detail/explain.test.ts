import { describe, expect, it } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import { explain, instanceFact, sentenceText } from '../../../src/panel/detail/explain'
import { ruleDisplay } from '../../../src/panel/rules/describe'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { instance, ruleEntry } from '../fixtures'

const COOLANT = 'propulsion.port.coolantTemperature'
const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
const paths: PathEntry[] = [
  { path: COOLANT, units: 'K', unit: celsius },
  { path: 'propulsion.stbd.coolantTemperature', units: 'K', unit: celsius }
]
const units = unitLookup(paths, displayUnit({ units: 'm' }))

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

/** A coolant rule: alerts above 95 °C (368.15 K) at warning, 100 °C at alarm. */
function coolant(status: Partial<RuleEntry['status']>, overrides: Partial<RuleEntry> = {}) {
  return ruleEntry({
    ...overrides,
    rule: {
      name: 'Coolant hot',
      priority: 'warning',
      steps: [
        { limit: 368.15, priority: 'warning' },
        { limit: 373.15, priority: 'alarm' }
      ],
      detector: { type: 'sustained', direction: 'above' },
      signal: { paths: [COOLANT] }
    },
    status: { changedAt: ago(4 * MIN), instances: [], ...status }
  })
}

const text = (entry: RuleEntry) => sentenceText(explain(entry, units, NOW))

describe('explain', () => {
  it('alertActive: the limit passed and for how long, and the value now, in display units', () => {
    const entry = coolant({
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'warning',
      step: 0,
      value: 370.15,
      limit: 368.15
    })
    expect(text(entry)).toBe('Port coolant temperature has been above 95 °C for 4 min. Now 97 °C.')
  })

  it('alertActive at a further step: the first limit, the step reached and the escalation', () => {
    const entry = coolant({
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'alarm',
      step: 1,
      value: 374.15,
      limit: 373.15
    })
    expect(text(entry)).toBe(
      'Port coolant temperature has been above 95 °C for 4 min and went above 100 °C, so the warning became an alarm. Now 101 °C.'
    )
  })

  it('alertActive at a further zone level: the level reached and its threshold, in display units', () => {
    const entry = ruleEntry({
      rule: {
        name: 'Coolant hot',
        steps: [],
        detector: { type: 'sustained', direction: 'above', zoneLevel: 'warn' },
        signal: { paths: [COOLANT] }
      },
      status: {
        changedAt: ago(4 * MIN),
        instances: [],
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        step: 1,
        level: 'alarm',
        value: 374.15,
        limit: 373.15
      }
    })
    expect(text(entry)).toBe(
      'Port coolant temperature reached the alarm zone at 100 °C. Alerting for 4 min. Now 101 °C.'
    )
  })

  it('alertActive emphasises the limit, its time and the value', () => {
    const parts = explain(
      coolant({
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'warning',
        step: 0,
        value: 370.15,
        limit: 368.15
      }),
      units,
      NOW
    )
    expect(parts.flatMap((p) => (typeof p === 'string' ? [] : [p.strong]))).toEqual([
      'above 95 °C for 4 min',
      '97 °C'
    ])
  })

  it('alertActive on an input gone quiet says no new value has come since', () => {
    const entry = coolant({
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'warning',
      step: 0,
      awaitingInput: true,
      value: 370.15,
      limit: 368.15
    })
    expect(text(entry)).toMatch(/Now 97 °C\. No new value since\.$/)
  })

  it('alertActive of a detector without a reading against a limit gives its message', () => {
    const entry = ruleEntry({
      rule: { detector: { type: 'count' }, signal: { paths: [COOLANT] } },
      status: {
        condition: 'alerting',
        reason: 'alertActive',
        priority: 'alarm',
        message: 'Bilge pump ran 6 times in an hour',
        changedAt: ago(10 * MIN)
      }
    })
    expect(text(entry)).toBe('Bilge pump ran 6 times in an hour. Alerting for 10 min.')
  })

  it('conditionPresent: a disabled rule whose condition still holds', () => {
    const entry = coolant(
      {
        ruleState: 'disabled',
        condition: 'present',
        reason: 'conditionPresent',
        value: 369.15,
        limit: 368.15,
        changedAt: ago(2 * 24 * HOUR)
      },
      { disabled: { since: ago(2 * 24 * HOUR), actor: 'skipper' } }
    )
    expect(text(entry)).toBe('Condition still present: above 95 °C for at least 2 d, now 96 °C.')
  })

  it("withinLimits with clearedAt: when a disabled rule's condition cleared", () => {
    const entry = coolant(
      {
        ruleState: 'disabled',
        condition: 'normal',
        reason: 'withinLimits',
        clearedAt: ago(3 * HOUR),
        value: 353.15
      },
      { disabled: { since: ago(5 * HOUR), actor: 'skipper' } }
    )
    expect(text(entry)).toBe('Condition cleared 3 h ago. Now 80 °C.')
  })

  it('withinLimits with clearSince: clear at least since the rule started evaluating', () => {
    const entry = coolant(
      {
        ruleState: 'disabled',
        condition: 'normal',
        reason: 'withinLimits',
        clearSince: ago(3 * HOUR),
        value: 353.15
      },
      { disabled: { since: ago(5 * HOUR), actor: 'skipper' } }
    )
    expect(text(entry)).toBe('Condition clear for at least 3 h. Now 80 °C.')
  })

  it('withinLimits undecided: a disabled rule waiting for a reading to decide', () => {
    const entry = coolant(
      { ruleState: 'disabled', condition: 'normal', reason: 'withinLimits' },
      { disabled: { since: ago(5 * HOUR), actor: 'skipper' } }
    )
    expect(text(entry)).toBe('Waiting for a reading to tell whether the condition is present.')
  })

  it('withinLimits on an enabled rule: the value now', () => {
    expect(text(coolant({ condition: 'normal', reason: 'withinLimits', value: 353.15 }))).toBe(
      'Within limits. Now 80 °C.'
    )
  })

  it('outsideGate: not watching while a gate is closed', () => {
    expect(text(coolant({ condition: 'normal', reason: 'outsideGate' }))).toBe(
      'Not watching now: a gate is closed.'
    )
  })

  it('inputUnavailable: how long the input has not reported', () => {
    const entry = coolant({
      condition: 'noData',
      reason: 'inputUnavailable',
      lastSeen: ago(2 * HOUR)
    })
    expect(text(entry)).toBe('Port coolant temperature has not reported for 2 h.')
  })

  it('inputUnavailable without a last value, and neverReported: not since the plugin started', () => {
    const since = 'Port coolant temperature has not reported since the plugin started.'
    expect(text(coolant({ condition: 'noData', reason: 'inputUnavailable' }))).toBe(since)
    expect(text(coolant({ condition: 'noData', reason: 'neverReported' }))).toBe(since)
  })

  it('notEvaluated: the plugin has not started evaluating', () => {
    expect(text(coolant({ condition: 'noData', reason: 'notEvaluated' }))).toBe(
      'Not evaluated yet: the plugin is starting.'
    )
  })

  it.each([
    [{ reason: 'missingZone', level: 'alarm' }, 'The path has no alarm zone.'],
    [{ reason: 'timeoutNotPossible', cause: 'booleanPath' }, 'An on/off value cannot time out.'],
    [{ reason: 'unitsNotRadians', path: COOLANT, units: 'K' }, `${COOLANT} is in K, not radians.`],
    [{ reason: 'alertPathInvalid' }, 'The alert path is not valid.'],
    [{ reason: 'evaluationError' }, 'The rule failed to evaluate.']
  ])('problem %o', (facts, sentence) => {
    expect(text(coolant({ condition: 'problem', ...facts }))).toBe(sentence)
  })

  it("names the subject by the path's display name when the server gives one", () => {
    const named = unitLookup(
      [{ path: COOLANT, units: 'K', unit: celsius, displayName: 'Main engine coolant' }],
      displayUnit({ units: 'm' })
    )
    const entry = coolant({ condition: 'noData', reason: 'neverReported' })
    expect(sentenceText(explain(entry, named, NOW))).toMatch(/^Main engine coolant has not/)
  })

  it('names the instance of a wildcard rule its condition comes from', () => {
    const entry = ruleEntry({
      rule: {
        detector: { type: 'sustained', direction: 'above' },
        signal: { paths: ['propulsion.*.coolantTemperature'] }
      },
      status: {
        condition: 'noData',
        reason: 'inputUnavailable',
        instance: { name: 'stbd', segment: 'stbd' },
        lastSeen: ago(2 * HOUR),
        instances: [instance(), instance()]
      }
    })
    expect(text(entry)).toBe('Stbd coolant temperature has not reported for 2 h.')
  })

  describe('a field rule', () => {
    const silent = (path: string, name?: string) =>
      ruleEntry({
        rule: { detector: { type: 'sustained', direction: 'above' }, signal: { paths: [path] } },
        status: {
          condition: 'noData',
          reason: 'inputUnavailable',
          lastSeen: ago(2 * HOUR),
          instances: [],
          ...(name === undefined ? {} : { instance: { name, segment: name } })
        }
      })

    it("names the field after its base path's words", () => {
      expect(text(silent('navigation.attitude#/roll'))).toBe(
        'Attitude roll has not reported for 2 h.'
      )
    })

    it('names the instance of the base path once', () => {
      expect(text(silent('electrical.batteries.house#/voltage'))).toBe(
        'House voltage has not reported for 2 h.'
      )
      expect(text(silent('electrical.batteries.*#/voltage', 'start'))).toBe(
        'Start voltage has not reported for 2 h.'
      )
    })

    it("takes the field's display name from metadata", () => {
      const named = unitLookup(
        [{ path: 'navigation.attitude#/roll', unit: displayUnit({}), displayName: 'Heel' }],
        displayUnit({ units: 'm' })
      )
      expect(sentenceText(explain(silent('navigation.attitude#/roll'), named, NOW))).toBe(
        'Heel has not reported for 2 h.'
      )
    })
  })

  it('counts the instances of a wildcard rule that are all within limits', () => {
    const entry = ruleEntry({
      rule: { signal: { paths: ['propulsion.*.coolantTemperature'] } },
      status: { instances: [instance(), instance(), instance()] }
    })
    expect(text(entry)).toBe('All 3 instances are within limits.')
  })
})

describe('instanceFact', () => {
  const rule = coolant({}).rule
  const display = ruleDisplay(rule, units)

  it('shows the value and the limit in force, in display units', () => {
    expect(instanceFact(instance({ value: 370.15, limit: 368.15 }), rule, display, NOW)).toBe(
      '97 °C, limit 95 °C'
    )
  })

  it('says how long an instance has had no value', () => {
    const i = instance({
      condition: 'noData',
      reason: 'inputUnavailable',
      value: undefined,
      lastSeen: ago(2 * HOUR)
    })
    expect(instanceFact(i, rule, display, NOW)).toBe('No value for 2 h')
  })

  it('words a problem', () => {
    const i = instance({
      condition: 'problem',
      reason: 'missingZone',
      level: 'warn',
      value: undefined
    })
    expect(instanceFact(i, rule, display, NOW)).toBe('The path has no warn zone')
  })
})

describe('an outside rule', () => {
  const HEEL = 'navigation.heel'
  const heelUnits = unitLookup(
    [{ path: HEEL, units: '°', unit: displayUnit({ units: '°' }) }],
    displayUnit({ units: 'm' })
  )
  /** Heel: a warning outside -25 to 25 °, an alarm outside -35 to 35 °. */
  function heel(status: Partial<RuleEntry['status']>, overrides: Partial<RuleEntry> = {}) {
    return ruleEntry({
      ...overrides,
      rule: {
        name: 'Heel',
        priority: 'warning',
        steps: [
          { low: -25, high: 25, priority: 'warning' },
          { low: -35, high: 35, priority: 'alarm' }
        ],
        detector: { type: 'outside' },
        signal: { paths: [HEEL] }
      },
      status: { changedAt: ago(4 * MIN), instances: [], ...status }
    })
  }
  const said = (entry: RuleEntry) => sentenceText(explain(entry, heelUnits, NOW))
  const alert = {
    condition: 'alerting',
    reason: 'alertActive',
    priority: 'warning',
    step: 0
  } as const

  it('alertActive above: the range, how long, the limit passed and the value now', () => {
    expect(said(heel({ ...alert, value: 27, limit: 25, passed: 'high' }))).toBe(
      'Heel has been outside -25 to 25 ° for 4 min and went above 25 °. Now 27 °.'
    )
  })

  it('alertActive below names the low limit', () => {
    expect(said(heel({ ...alert, value: -27, limit: -25, passed: 'low' }))).toBe(
      'Heel has been outside -25 to 25 ° for 4 min and went below -25 °. Now -27 °.'
    )
  })

  it('alertActive at a further step: the side and limit passed and the escalation', () => {
    const entry = heel({
      ...alert,
      priority: 'alarm',
      step: 1,
      value: -37,
      limit: -35,
      passed: 'low'
    })
    expect(said(entry)).toBe(
      'Heel has been outside -25 to 25 ° for 4 min and went below -35 °, so the warning became an alarm. Now -37 °.'
    )
  })

  it('alertActive without a side gives the message', () => {
    const entry = heel({ ...alert, value: 27, limit: 25, message: 'Heel 27 °' })
    expect(said(entry)).toBe('Heel 27 °. Alerting for 4 min. Now 27 °.')
  })

  it('conditionPresent: the value now, as a disabled rule reports no side', () => {
    const entry = heel(
      { ruleState: 'disabled', condition: 'present', reason: 'conditionPresent', value: 27 },
      { disabled: { since: ago(HOUR), actor: 'skipper' } }
    )
    expect(said(entry)).toBe('Condition still present: now 27 °.')
  })

  it('withinLimits without a limit: the value now', () => {
    expect(said(heel({ value: 3 }))).toBe('Within limits. Now 3 °.')
  })

  it('instanceFact: the side and limit passed while alerting, the value alone otherwise', () => {
    const { rule } = heel({})
    const display = ruleDisplay(rule, heelUnits)
    const alerting = instance({ ...alert, value: 27, limit: 25, passed: 'high' })
    expect(instanceFact(alerting, rule, display, NOW)).toBe('27 °, above 25 °')
    expect(instanceFact(instance({ value: 3, limit: 25 }), rule, display, NOW)).toBe('3 °')
    expect(instanceFact(instance({ value: 3 }), rule, display, NOW)).toBe('3 °')
  })
})
