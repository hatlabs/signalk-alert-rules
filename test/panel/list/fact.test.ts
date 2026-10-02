import { describe, expect, it } from 'vitest'
import type { RuleEntry, RuleStatus } from '../../../src/panel/api'
import { currentFact, elapsed } from '../../../src/panel/list/fact'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { instance, invalidEntry, ruleEntry } from '../fixtures'

const VOLTAGE = 'electrical.batteries.house.voltage'
const units = unitLookup(
  [{ path: VOLTAGE, units: 'V', unit: displayUnit({ units: 'V' }) }],
  displayUnit({ units: 'm' })
)
const NOW = Date.parse('2026-09-30T14:00:00.000Z')

function battery(status: Partial<RuleStatus>, overrides: Partial<RuleEntry> = {}): RuleEntry {
  return ruleEntry({
    ...overrides,
    rule: { name: 'House bank voltage low', signal: { paths: [VOLTAGE] } },
    status: { value: 12.6, ...status }
  })
}

const fact = (entry: Parameters<typeof currentFact>[0]) => currentFact(entry, units, NOW)

describe('currentFact', () => {
  describe('of an enabled rule', () => {
    const alert: Partial<RuleStatus> = {
      condition: 'alerting',
      reason: 'alertActive',
      priority: 'alarm',
      message: 'House bank voltage low'
    }

    it('leads an alert with its reading and the limit it passed, not the message', () => {
      expect(fact(battery({ ...alert, value: 11.6, limit: 11.8 }))).toBe('11.6 V: below 11.8 V')
    })

    it('shows the reading alone when the alert has no limit', () => {
      expect(fact(battery({ ...alert, value: 11.6 }))).toBe('11.6 V')
    })

    it('shows the total of an accumulator alert', () => {
      const hours = ruleEntry({
        rule: { detector: { type: 'accumulator', measure: 'time' } },
        status: {
          ...alert,
          value: undefined,
          progress: { kind: 'total', total: 950400, limit: 900000 }
        }
      })
      expect(fact(hours)).toBe('264 h of 250 h')
    })

    it.each([
      [
        { type: 'count', direction: undefined },
        { progress: { kind: 'events', count: 5, limit: 4 } as const }
      ],
      [{ type: 'match', direction: undefined }, { value: 'aground' }],
      [{ type: 'absence', direction: undefined }, { value: undefined }]
    ])('shows the message of a %o alert, which has no reading to lead with', (d, status) => {
      const entry = ruleEntry({
        rule: { detector: { type: d.type, direction: d.direction } },
        status: { ...alert, ...status }
      })
      expect(fact(entry)).toBe('House bank voltage low')
    })

    /** An alert from a house bank voltage rule with the given detector. */
    const alertOn = (detector: RuleEntry['rule']['detector'], status: Partial<RuleStatus>) =>
      ruleEntry({
        rule: { detector, signal: { paths: [VOLTAGE] } },
        status: { ...alert, ...status }
      })

    // A slope's limit is a rate per second, which the value's unit cannot show.
    it('shows the message of a slope alert, not its rate limit as a value', () => {
      const entry = alertOn(
        { type: 'slope', direction: 'above' },
        { value: 13.4, limit: 0.01, message: 'House bank voltage rising fast' }
      )
      expect(fact(entry)).toBe('House bank voltage rising fast')
    })

    // The value has not passed a projection's limit; it is expected to.
    it('shows the message of a projection alert, not the limit as if passed', () => {
      const entry = alertOn(
        { type: 'projection', direction: 'below' },
        { value: 12.4, limit: 11.8, message: 'House bank expected below 11.8 V within 30 min' }
      )
      expect(fact(entry)).toBe('House bank expected below 11.8 V within 30 min')
    })

    it('shows the message of an alert with no reading, without the priority', () => {
      expect(fact(battery({ ...alert, value: undefined }))).toBe('House bank voltage low')
    })

    it('says an alert is waiting for its input', () => {
      expect(fact(battery({ ...alert, value: 11.6, limit: 11.8, awaitingInput: true }))).toBe(
        '11.6 V: below 11.8 V. No new value since.'
      )
    })

    describe('of a wildcard rule', () => {
      const wildcard = (status: Partial<RuleStatus>, overrides: Partial<RuleEntry> = {}) =>
        ruleEntry({
          ...overrides,
          rule: { signal: { paths: ['electrical.batteries.*.voltage'] } },
          status: {
            instance: { name: 'start', segment: 'start' },
            instances: [
              instance({ instance: { segment: 'house' } }),
              instance({ instance: { name: 'start', segment: 'start' } })
            ],
            ...status
          }
        })

      it('names the instance an alert is on, before its reading', () => {
        expect(fact(wildcard({ ...alert, value: 11.5, limit: 12 }))).toBe(
          'start at 11.5 V: below 12 V'
        )
      })

      it('shows an alert message as it is, since it names its own instance', () => {
        const entry = ruleEntry({
          rule: {
            detector: { type: 'count' },
            signal: { paths: ['electrical.switches.*.state'] }
          },
          status: {
            ...alert,
            message: 'start pump started 5 times in 24 h',
            instance: { name: 'start', segment: 'start' },
            progress: { kind: 'events', count: 5, limit: 4 }
          }
        })
        expect(fact(entry)).toBe('start pump started 5 times in 24 h')
      })

      it('names the instance whose condition a disabled rule still has', () => {
        const entry = wildcard(
          { ruleState: 'disabled', condition: 'present', reason: 'conditionPresent', value: 11.5 },
          { disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin', note: 'swapping' } }
        )
        expect(fact(entry)).toBe('“swapping”. Condition still present on start: 11.5 V')
      })

      it('words a disabled wildcard rule whose condition is clear', () => {
        const entry = wildcard(
          { ruleState: 'disabled', clearedAt: '2026-09-30T13:00:00.000Z' },
          { disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' } }
        )
        expect(fact(entry)).toBe('Condition clear for 60 min')
      })
    })

    it('shows the value of a normal rule in its display unit', () => {
      expect(fact(battery({}))).toBe('12.6 V')
    })

    it('shows the progress of a count or total', () => {
      expect(
        fact(battery({ value: undefined, progress: { kind: 'events', count: 2, limit: 4 } }))
      ).toBe('2 of 4 events')
      const hours = ruleEntry({
        rule: { detector: { type: 'accumulator', measure: 'time' } },
        status: { value: undefined, progress: { kind: 'total', total: 763200, limit: 900000 } }
      })
      expect(fact(hours)).toBe('212 h of 250 h')
    })

    it('says a rule outside its gate is not watching now', () => {
      expect(fact(battery({ reason: 'outsideGate' }))).toBe('Not watching now: a gate is closed')
    })

    it('counts the instances of a normal wildcard rule', () => {
      const entry = battery({
        instances: [
          instance({ instance: { segment: 'house' } }),
          instance({ instance: { segment: 'start' } })
        ]
      })
      expect(fact(entry)).toBe('2 instances')
    })

    it('names the worst instance of a wildcard rule', () => {
      const entry = battery({
        condition: 'noData',
        reason: 'neverReported',
        value: undefined,
        instance: { name: 'start', segment: 'start' },
        instances: [
          instance({ instance: { segment: 'house' } }),
          instance({ instance: { name: 'start', segment: 'start' }, condition: 'noData' })
        ]
      })
      expect(fact(entry)).toBe('start: no value since the plugin started')
    })

    it.each<[Partial<RuleStatus>, string]>([
      [{ reason: 'neverReported' }, 'No value since the plugin started'],
      [{ reason: 'inputUnavailable', lastSeen: '2026-09-30T12:00:00.000Z' }, 'No value for 2 h'],
      [{ reason: 'inputUnavailable' }, 'No value since the plugin started'],
      [{ reason: 'notEvaluated' }, 'Not evaluated yet']
    ])('words no data with %o', (status, sentence) => {
      expect(fact(battery({ condition: 'noData', value: undefined, ...status }))).toBe(sentence)
    })

    it.each<[Partial<RuleStatus>, string]>([
      [{ reason: 'missingZone', level: 'alarm' }, 'The path has no alarm zone'],
      [{ reason: 'missingZone', level: 'warn', side: 'low' }, 'The path has no low warn zone'],
      [{ reason: 'missingZone', level: 'alarm', gate: 0 }, 'The path of gate 1 has no alarm zone'],
      [{ reason: 'timeoutNotPossible', cause: 'booleanPath' }, 'An on/off value cannot time out'],
      [{ reason: 'timeoutNotPossible', cause: 'stringPath' }, 'A text value cannot time out'],
      [
        { reason: 'timeoutNotPossible', cause: 'notEnforced' },
        'The server does not enforce timeouts'
      ],
      [
        { reason: 'timeoutNotPossible', cause: 'updateContract', contract: 'onChange' },
        'The path updates onChange, not periodically, so it cannot time out'
      ],
      [{ reason: 'timeoutNotPossible', cause: 'timeoutOff' }, "The path's timeout is disabled"],
      [
        { reason: 'timeoutNotPossible', cause: 'noTimeout' },
        'The path has no timeout and the server sets none'
      ],
      [
        { reason: 'unitsNotRadians', path: 'navigation.headingMagnetic', units: 'deg' },
        'navigation.headingMagnetic is in deg, not radians'
      ],
      [{ reason: 'alertPathInvalid' }, 'The alert path is not valid'],
      [{ reason: 'evaluationError' }, 'The rule failed to evaluate'],
      [{ reason: 'somethingNew' }, 'The rule cannot run']
    ])('words a problem with %o', (status, sentence) => {
      expect(fact(battery({ condition: 'problem', ...status }))).toBe(sentence)
    })
  })

  describe('of a disabled rule', () => {
    const off = (status: Partial<RuleStatus>, note?: string) =>
      battery(
        { ruleState: 'disabled', ...status },
        {
          disabled: {
            since: '2026-09-30T12:00:00.000Z',
            actor: 'admin',
            ...(note === undefined ? {} : { note })
          }
        }
      )

    it('takes the rule state as the one word on whether the rule is disabled', () => {
      const present = { condition: 'present', reason: 'conditionPresent', value: 11.6 } as const
      expect(fact(battery({ ruleState: 'disabled', ...present }))).toBe(
        'Condition still present: 11.6 V'
      )
    })

    it('quotes the note, then says the condition is still present, with the value', () => {
      const entry = off({ condition: 'present', reason: 'conditionPresent', value: 11.6 }, 'fouled')
      expect(fact(entry)).toBe('“fouled”. Condition still present: 11.6 V')
    })

    it('says since when the condition has been clear', () => {
      const entry = off({ clearedAt: '2026-09-30T13:30:00.000Z' })
      expect(fact(entry)).toBe('Condition clear for 30 min')
    })

    it('says the condition has been clear at least since the plugin started', () => {
      const entry = off({ clearSince: '2026-09-30T13:00:00.000Z' })
      expect(fact(entry)).toBe('Condition clear for at least 60 min')
    })

    it('words other conditions as an enabled rule would', () => {
      const entry = off({ condition: 'noData', reason: 'neverReported', value: undefined })
      expect(fact(entry)).toBe('No value since the plugin started')
    })
  })

  it('says a stored rule that does not run is not valid', () => {
    expect(fact(invalidEntry())).toBe('The stored rule is not valid')
  })
})

describe('elapsed', () => {
  it.each([
    [45_000, '45 s'],
    [119_000, '119 s'],
    [4 * 60_000, '4 min'],
    [119 * 60_000, '119 min'],
    [2 * 3_600_000, '2 h'],
    [47 * 3_600_000, '47 h'],
    [3 * 86_400_000, '3 d']
  ])('reads %i ms as %s', (ms, text) => {
    expect(elapsed(ms)).toBe(text)
  })
})
