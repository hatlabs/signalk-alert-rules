import { describe, it, expect } from 'vitest'
import { alertPathOf } from '../../src/alerts/paths.js'
import {
  FIELD_ZONES_ELSEWHERE_MESSAGE,
  FIELD_ZONES_LEVEL_MESSAGE,
  FIELD_ZONES_MESSAGE,
  FIELD_ZONES_PATH_MESSAGE,
  POINTER_MESSAGE,
  POINTER_TOKEN_MESSAGE
} from '../../src/model/pointerPath.js'
import {
  angularUnitsMessage,
  validateRule,
  type PathInfo,
  type ValidationError
} from '../../src/model/validate.js'
import { workedExamples } from '../fixtures/worked-examples.js'

const base = {
  name: 'Test rule',
  slug: 'test-rule',
  message: 'Something happened',
  signal: { path: 'electrical.batteries.house.voltage' }
}

// A combined signal has no default condition name; the tests of other fields give it one.
function rule(overrides: Record<string, unknown>): Record<string, unknown> {
  const combined = typeof overrides.signal === 'object' && 'combinator' in (overrides.signal ?? {})
  return { ...base, ...(combined ? { condition: 'combined' } : {}), ...overrides }
}

/** One step at warning: `step({ limit: 12 })`. */
function step(limit: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...limit, priority: 'warning' }
}

function errorsOf(
  input: unknown,
  pathInfo?: (path: string) => PathInfo | undefined
): ValidationError[] {
  const result = validateRule(input, { pathInfo })
  return result.ok ? [] : result.errors
}

function paths(errors: ValidationError[]): string[] {
  return errors.map((e) => e.path)
}

const minimalDetectors: Record<string, unknown> = {
  match: { type: 'match', op: 'equals', steps: [step({ value: 1 })] },
  sustained: { type: 'sustained', direction: 'below', steps: [step({ limit: 12 })] },
  outside: { type: 'outside', steps: [step({ low: -25, high: 25 })] },
  slope: { type: 'slope', direction: 'rising', window: 60, steps: [step({ limit: 0.01 })] },
  projection: {
    type: 'projection',
    direction: 'falling',
    steps: [step({ limit: 11.5 })],
    window: 600,
    horizon: 1800
  },
  accumulator: { type: 'accumulator', measure: 'integral', steps: [step({ limit: 1000 })] },
  count: { type: 'count', event: { op: 'decreases' }, window: 3600, steps: [step({ limit: 3 })] },
  absence: { type: 'absence', event: { op: 'changes' }, steps: [step({ within: 600 })] }
}

describe('validateRule', () => {
  it.each(Object.entries(minimalDetectors))('accepts a minimal %s detector', (_type, detector) => {
    expect(errorsOf(rule({ detector }))).toEqual([])
  })

  it.each(Object.entries(workedExamples))('accepts worked example %s', (_name, example) => {
    expect(errorsOf(example)).toEqual([])
  })

  it('returns the typed rule on success', () => {
    const result = validateRule(rule({ detector: minimalDetectors.match }))
    expect(result.ok && result.value.slug).toBe('test-rule')
  })

  it('reports a schema error at the offending field', () => {
    const errors = errorsOf(
      rule({
        detector: { type: 'slope', direction: 'rising', window: 'x', steps: [step({ limit: 1 })] }
      })
    )
    expect(paths(errors)).toEqual(['/detector/window'])
  })

  it('reports an unknown detector type at the discriminator', () => {
    const errors = errorsOf(rule({ detector: { type: 'magic' } }))
    expect(paths(errors)).toEqual(['/detector/type'])
    expect(errors[0]?.message).toContain('sustained')
  })

  it('reports only the chosen variant when a detector field is missing', () => {
    const errors = errorsOf(
      rule({ detector: { type: 'count', event: { op: 'changes' }, window: 60 } })
    )
    expect(paths(errors)).toEqual(['/detector/steps'])
  })

  it('rejects unknown properties', () => {
    expect(paths(errorsOf(rule({ detector: minimalDetectors.match, colour: 'red' })))).toEqual([
      '/colour'
    ])
  })

  describe('combinators', () => {
    it('rejects a nested combinator naming the field path', () => {
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'mean',
            inputs: [
              { path: 'a.b' },
              { combinator: 'mean', inputs: [{ path: 'c.d' }, { path: 'e.f' }] }
            ]
          },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/inputs/1'])
      expect(errors[0]?.message).toMatch(/nest/)
    })

    it('rejects a ratio with one input', () => {
      const errors = errorsOf(
        rule({
          signal: { combinator: 'ratio', inputs: [{ path: 'a.b' }] },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/inputs'])
    })

    it('rejects a difference with three inputs', () => {
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'difference',
            inputs: [{ path: 'a.b' }, { path: 'c.d' }, { path: 'e.f' }]
          },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/inputs'])
    })

    it('rejects position spread over a non-position path', () => {
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'positionSpread',
            inputs: [{ path: 'navigation.position' }, { path: 'navigation.speedOverGround' }]
          },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/inputs/1/path'])
    })

    it('rejects a mean over positions', () => {
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'mean',
            inputs: [{ path: 'navigation.position' }, { path: 'a.position' }]
          },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/inputs/0/path', '/signal/inputs/1/path'])
    })

    it('rejects angular on a combinator that cannot wrap angles', () => {
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'ratio',
            angular: true,
            inputs: [{ path: 'a.b' }, { path: 'c.d' }]
          },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/angular'])
    })

    it('rejects angular over inputs whose known unit is not radians', () => {
      const pathInfo = (path: string): PathInfo | undefined =>
        path === 'environment.wind.angleApparent' ? { units: 'rad' } : { units: 'm/s' }
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'difference',
            angular: true,
            inputs: [
              { path: 'environment.wind.angleApparent' },
              { path: 'environment.wind.speedApparent' }
            ]
          },
          detector: minimalDetectors.sustained
        }),
        pathInfo
      )
      expect(paths(errors)).toEqual(['/signal/inputs/1/path'])
    })

    it('rejects a wildcard combinator input', () => {
      const errors = errorsOf(
        rule({
          signal: {
            combinator: 'mean',
            inputs: [{ path: 'propulsion.*.revolutions' }, { path: 'a.b' }]
          },
          detector: minimalDetectors.sustained
        })
      )
      expect(paths(errors)).toEqual(['/signal/inputs/0/path'])
    })
  })

  describe('paths', () => {
    it('rejects a path with two wildcard segments', () => {
      const errors = errorsOf(
        rule({ signal: { path: 'propulsion.*.*.temperature' }, detector: minimalDetectors.match })
      )
      expect(paths(errors)).toEqual(['/signal/path'])
    })

    it('rejects a partial wildcard segment', () => {
      const errors = errorsOf(
        rule({ signal: { path: 'propulsion.port*.rpm' }, detector: minimalDetectors.match })
      )
      expect(paths(errors)).toEqual(['/signal/path'])
    })

    it('rejects a context-qualified path', () => {
      const errors = errorsOf(
        rule({
          signal: { path: 'vessels.self.navigation.speedOverGround' },
          detector: minimalDetectors.match
        })
      )
      expect(paths(errors)).toEqual(['/signal/path'])
    })

    it('rejects a gate wildcard when the signal has none', () => {
      const errors = errorsOf(
        rule({
          detector: minimalDetectors.match,
          gates: [
            {
              signal: { path: 'propulsion.*.revolutions' },
              direction: 'above',
              limit: { kind: 'fixed', value: 1 }
            }
          ]
        })
      )
      expect(paths(errors)).toEqual(['/gates/0/signal/path'])
    })
  })

  describe('zone limits', () => {
    it('rejects a zone level that zones do not raise on', () => {
      const errors = errorsOf(
        rule({
          detector: {
            type: 'sustained',
            direction: 'below',
            limit: { kind: 'zone', level: 'normal' }
          }
        })
      )
      expect(paths(errors)).toEqual(['/detector/limit/level'])
    })

    it('requires a zone path when the signal is a combinator', () => {
      const errors = errorsOf(
        rule({
          signal: { combinator: 'mean', inputs: [{ path: 'a.b' }, { path: 'c.d' }] },
          detector: {
            type: 'sustained',
            direction: 'above',
            limit: { kind: 'zone', level: 'alarm' }
          }
        })
      )
      expect(paths(errors)).toEqual(['/detector/limit/path'])
    })
  })

  describe('field paths', () => {
    const ROLL = 'navigation.attitude#/roll'
    const heel = { type: 'outside', steps: [step({ low: -0.35, high: 0.35 })] }
    const zoned = { type: 'sustained', direction: 'above', limit: { kind: 'zone', level: 'warn' } }
    const fixedGate = (path: string) => ({
      signal: { path },
      direction: 'above',
      limit: { kind: 'fixed', value: 0.1 }
    })

    it('accepts a field of a path as a signal, a combined input and a gate', () => {
      expect(errorsOf(rule({ signal: { path: ROLL }, detector: heel }))).toEqual([])
      expect(errorsOf(rule({ signal: { path: 'a.b#/c/d' }, detector: heel }))).toEqual([])
      const pair = [{ path: ROLL }, { path: 'navigation.attitude#/pitch' }]
      expect(
        errorsOf(rule({ signal: { combinator: 'difference', inputs: pair }, detector: heel }))
      ).toEqual([])
      expect(
        errorsOf(rule({ detector: heel, gates: [fixedGate('navigation.attitude#/pitch')] }))
      ).toEqual([])
    })

    it("keeps a wildcard in the base path, as one of the rule's", () => {
      expect(errorsOf(rule({ signal: { path: 'propulsion.*.x#/y' }, detector: heel }))).toEqual([])
      const gated = rule({
        signal: { path: 'propulsion.*.x#/y' },
        detector: heel,
        gates: [fixedGate('propulsion.*.z#/w')]
      })
      expect(errorsOf(gated)).toEqual([])
      expect(
        paths(errorsOf(rule({ signal: { path: 'propulsion.*.*.x#/y' }, detector: heel })))
      ).toEqual(['/signal/path'])
    })

    it.each([
      'navigation.attitude#',
      'navigation.attitude#roll',
      'navigation.attitude#/',
      'navigation.attitude#/a~2',
      'navigation.attitude#/roll#/pitch',
      'navigation.attitude#roll.x',
      'navigation.att#tude.x#/roll'
    ])('refuses %s at the path with the pointer message alone', (path) => {
      expect(errorsOf(rule({ signal: { path }, detector: heel }))).toEqual([
        { path: '/signal/path', message: POINTER_MESSAGE }
      ])
    })

    it.each(['navigation.attitude#/a.b', 'navigation.attitude#/a b', 'navigation.attitude#/*'])(
      'refuses %s, whose field name is not one segment, at the path alone',
      (path) => {
        expect(errorsOf(rule({ signal: { path }, detector: heel }))).toEqual([
          { path: '/signal/path', message: POINTER_TOKEN_MESSAGE }
        ])
      }
    )

    it('refuses an invalid pointer in a combined input and a gate where it is', () => {
      const inputs = [{ path: ROLL }, { path: 'navigation.attitude#pitch' }]
      expect(
        errorsOf(rule({ signal: { combinator: 'difference', inputs }, detector: heel }))
      ).toEqual([{ path: '/signal/inputs/1/path', message: POINTER_MESSAGE }])
      expect(errorsOf(rule({ detector: heel, gates: [fixedGate('a#b')] }))).toEqual([
        { path: '/gates/0/signal/path', message: POINTER_MESSAGE }
      ])
    })

    it('refuses a path without a base path by the schema', () => {
      for (const path of ['#/roll', 'a.#/roll', 'a.*b#/roll']) {
        const errors = errorsOf(rule({ signal: { path }, detector: heel }))
        expect(paths(errors)).toEqual(['/signal/path'])
        expect(errors[0]?.message).toMatch(/dot-separated path/)
      }
    })

    it('does not take a field of a position for a position', () => {
      const distance = {
        combinator: 'distance',
        inputs: [{ path: 'navigation.position' }, { path: 'navigation.position#/altitude' }]
      }
      expect(errorsOf(rule({ signal: distance, detector: heel }))).toEqual([
        { path: '/signal/inputs/1/path', message: 'distance needs a position path' }
      ])
      const mean = {
        combinator: 'mean',
        inputs: [{ path: 'navigation.position#/altitude' }, { path: 'a.position#/altitude' }]
      }
      expect(errorsOf(rule({ signal: mean, detector: heel }))).toEqual([])
    })

    it("checks an angular combination against the field's unit", () => {
      const asked: string[] = []
      const pathInfo = (path: string): PathInfo => {
        asked.push(path)
        return { units: path === ROLL ? 'rad' : 'deg' }
      }
      const signal = {
        combinator: 'difference',
        angular: true,
        inputs: [{ path: ROLL }, { path: 'navigation.attitude#/yaw' }]
      }
      expect(errorsOf(rule({ signal, detector: heel }), pathInfo)).toEqual([
        { path: '/signal/inputs/1/path', message: angularUnitsMessage('deg') }
      ])
      expect(asked).toEqual([ROLL, 'navigation.attitude#/yaw'])
    })

    it.each([
      ['sustained', zoned],
      [
        'projection',
        { ...zoned, type: 'projection', direction: 'rising', window: 600, horizon: 1800 }
      ]
    ])('refuses a %s zone limit on a field, which has no zones', (_type, detector) => {
      expect(errorsOf(rule({ signal: { path: ROLL }, detector }))).toEqual([
        { path: '/detector/limit', message: FIELD_ZONES_MESSAGE }
      ])
    })

    it('refuses a zone limit whose zones path is a field', () => {
      const detector = { ...zoned, limit: { ...zoned.limit, path: 'x#/y' } }
      expect(errorsOf(rule({ detector }))).toEqual([
        { path: '/detector/limit/path', message: FIELD_ZONES_PATH_MESSAGE }
      ])
      const malformed = { ...zoned, limit: { ...zoned.limit, path: 'x#y' } }
      expect(errorsOf(rule({ detector: malformed }))).toEqual([
        { path: '/detector/limit/path', message: POINTER_MESSAGE }
      ])
    })

    it('asks a field rule naming a field for its zones for a path with zones', () => {
      const detector = { ...zoned, limit: { ...zoned.limit, path: 'x#/y' } }
      expect(errorsOf(rule({ signal: { path: ROLL }, detector }))).toEqual([
        { path: '/detector/limit/path', message: FIELD_ZONES_ELSEWHERE_MESSAGE }
      ])
    })

    it("takes a field's zones from the zones path it names", () => {
      const detector = { ...zoned, limit: { ...zoned.limit, path: 'navigation.attitude' } }
      expect(errorsOf(rule({ signal: { path: ROLL }, detector }))).toEqual([])
    })

    it("refuses a gate's zone limit on a field, or naming a field's zones", () => {
      const zoneGate = (path: string, zonesPath?: string) => ({
        signal: { path },
        direction: 'above',
        limit: { kind: 'zone', level: 'warn', ...(zonesPath ? { path: zonesPath } : {}) }
      })
      expect(errorsOf(rule({ detector: heel, gates: [zoneGate(ROLL)] }))).toEqual([
        { path: '/gates/0/limit', message: FIELD_ZONES_LEVEL_MESSAGE }
      ])
      expect(errorsOf(rule({ detector: heel, gates: [zoneGate('a.b', ROLL)] }))).toEqual([
        { path: '/gates/0/limit/path', message: FIELD_ZONES_PATH_MESSAGE }
      ])
      const combined = {
        signal: { combinator: 'mean', inputs: [{ path: ROLL }, { path: 'a.b#/c' }] },
        direction: 'above',
        limit: { kind: 'zone', level: 'warn', path: 'a.b' }
      }
      expect(errorsOf(rule({ detector: heel, gates: [combined] }))).toEqual([])
    })

    it('words each zones message for the editor field it is shown on', () => {
      expect(FIELD_ZONES_MESSAGE).toBe('A field has no zones: turn this off and type the limits.')
      expect(FIELD_ZONES_PATH_MESSAGE).toBe(
        'A field has no zones: choose another path or leave this empty.'
      )
      expect(FIELD_ZONES_LEVEL_MESSAGE).toBe(
        'A field has no zones: choose A fixed value and type the limit.'
      )
    })
  })

  describe('steps', () => {
    const zoneDetector = {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'zone', level: 'warn' }
    }

    it('accepts a zone-limit rule without steps: its levels set them', () => {
      expect(errorsOf(rule({ detector: zoneDetector }))).toEqual([])
    })

    it('refuses steps on a zone-limit rule', () => {
      const errors = errorsOf(rule({ detector: { ...zoneDetector, steps: [step({ limit: 12 })] } }))
      expect(paths(errors)).toEqual(['/detector/steps'])
      expect(errors[0]?.message).toMatch(/zone/)
    })

    it.each(['sustained', 'projection'])('requires steps or a zone limit on a %s rule', (type) => {
      const { steps: _steps, ...detector } = minimalDetectors[type] as Record<string, unknown>
      const errors = errorsOf(rule({ detector }))
      expect(paths(errors)).toEqual(['/detector/steps'])
      expect(errors[0]?.message).toMatch(/zone/)
    })

    it.each(Object.keys(minimalDetectors))('requires at least one step on a %s rule', (type) => {
      const detector = { ...(minimalDetectors[type] as object), steps: [] }
      expect(paths(errorsOf(rule({ detector })))).toEqual(['/detector/steps'])
    })

    it('requires a priority on each step', () => {
      const detector = { ...(minimalDetectors.count as object), steps: [{ limit: 3 }] }
      expect(paths(errorsOf(rule({ detector })))).toEqual(['/detector/steps/0/priority'])
    })

    it('rejects an unknown priority', () => {
      const detector = {
        ...(minimalDetectors.count as object),
        steps: [{ limit: 3, priority: 'urgent' }]
      }
      expect(paths(errorsOf(rule({ detector })))).toEqual(['/detector/steps/0/priority'])
    })

    it('refuses a priority on the rule: steps hold it', () => {
      const errors = errorsOf(rule({ priority: 'warning', detector: minimalDetectors.match }))
      expect(paths(errors)).toEqual(['/priority'])
    })

    it('refuses a fixed limit on the detector: steps hold it', () => {
      const detector = {
        type: 'sustained',
        direction: 'below',
        limit: { kind: 'fixed', value: 12 }
      }
      expect(paths(errorsOf(rule({ detector })))).toContain('/detector/limit/kind')
    })

    it('checks a step limit against its detector', () => {
      const detector = { ...(minimalDetectors.count as object), steps: [step({ limit: 2.5 })] }
      expect(paths(errorsOf(rule({ detector })))).toEqual(['/detector/steps/0/limit'])
    })
  })

  describe('escalation steps', () => {
    const below = (...steps: [number, string][]) => ({
      type: 'sustained',
      direction: 'below',
      steps: steps.map(([limit, priority]) => ({ limit, priority }))
    })

    it('accepts steps that climb in priority and move in the condition direction', () => {
      expect(
        errorsOf(
          rule({
            detector: below(
              [12.4, 'caution'],
              [12.2, 'warning'],
              [11.8, 'alarm'],
              [11, 'emergency']
            )
          })
        )
      ).toEqual([])
    })

    it('refuses a fifth step at the step', () => {
      const detector = below(
        [12.4, 'caution'],
        [12.2, 'warning'],
        [11.8, 'alarm'],
        [11, 'emergency'],
        [10, 'emergency']
      )
      const errors = errorsOf(rule({ detector }))
      expect(paths(errors)).toEqual(['/detector/steps/4'])
      expect(errors[0]?.message).toMatch(/at most 4 steps/)
    })

    it('refuses steps out of order at the step', () => {
      const errors = errorsOf(rule({ detector: below([11.8, 'alarm'], [12.2, 'warning']) }))
      expect(paths(errors)).toEqual(['/detector/steps/1/priority', '/detector/steps/1/limit'])
    })

    it('refuses a repeated priority', () => {
      const errors = errorsOf(rule({ detector: below([12.2, 'warning'], [11.8, 'warning']) }))
      expect(paths(errors)).toEqual(['/detector/steps/1/priority'])
      expect(errors[0]?.message).toMatch(/warning/)
    })

    it.each<[string, Record<string, unknown>, number, number]>([
      ['a sustained rule below a limit', { type: 'sustained', direction: 'below' }, 12.2, 12.4],
      ['a sustained rule above a limit', { type: 'sustained', direction: 'above' }, 368, 360],
      [
        'a falling projection',
        { type: 'projection', direction: 'falling', window: 600, horizon: 1800 },
        12,
        12.2
      ],
      [
        'a rising projection',
        { type: 'projection', direction: 'rising', window: 600, horizon: 1800 },
        0.9,
        0.8
      ],
      ['a slope', { type: 'slope', direction: 'falling', window: 60 }, 0.02, 0.01],
      ['an accumulator', { type: 'accumulator', measure: 'time' }, 7200, 3600],
      ['a count', { type: 'count', event: { op: 'changes' }, window: 3600 }, 5, 2]
    ])('refuses a step limit back toward normal on %s', (_, detector, first, second) => {
      const steps = [step({ limit: first }), { limit: second, priority: 'alarm' }]
      const errors = errorsOf(rule({ detector: { ...detector, steps } }))
      expect(paths(errors)).toEqual(['/detector/steps/1/limit'])
    })

    it('refuses an equal step limit', () => {
      const errors = errorsOf(rule({ detector: below([12, 'warning'], [12, 'alarm']) }))
      expect(paths(errors)).toEqual(['/detector/steps/1/limit'])
      expect(errors[0]?.message).toBe("must be below the previous step's limit")
    })

    it.each(['equals', 'changesTo'])('accepts a different value at each step of %s', (op) => {
      const steps = [step({ value: 'fault' }), { value: 'critical', priority: 'alarm' }]
      expect(errorsOf(rule({ detector: { type: 'match', op, steps } }))).toEqual([])
    })

    it('refuses a repeated match value', () => {
      const steps = [step({ value: 'fault' }), { value: 'fault', priority: 'alarm' }]
      const errors = errorsOf(rule({ detector: { type: 'match', op: 'equals', steps } }))
      expect(paths(errors)).toEqual(['/detector/steps/1/value'])
    })

    it.each<[string, Record<string, unknown>]>([
      [
        'notEquals',
        { op: 'notEquals', steps: [step({ value: 'ok' }), { value: 'x', priority: 'alarm' }] }
      ],
      ['decreases', { op: 'decreases', steps: [step(), { priority: 'alarm' }] }],
      ['timedOut', { op: 'timedOut', duration: 30, steps: [step(), { priority: 'alarm' }] }]
    ])('refuses a second step on a %s match', (op, fields) => {
      const errors = errorsOf(rule({ detector: { type: 'match', ...fields } }))
      expect(paths(errors)).toEqual(['/detector/steps/1'])
      expect(errors[0]?.message).toContain(op)
    })

    it('accepts growing absence windows and refuses a shrinking one', () => {
      const absence = (first: number, second: number) => ({
        type: 'absence',
        event: { op: 'changes' },
        steps: [step({ within: first }), { within: second, priority: 'alarm' }]
      })
      expect(errorsOf(rule({ detector: absence(600, 1800) }))).toEqual([])
      expect(paths(errorsOf(rule({ detector: absence(1800, 600) })))).toEqual([
        '/detector/steps/1/within'
      ])
    })

    it('accepts latching steps on a count', () => {
      const detector = {
        type: 'count',
        event: { op: 'changes' },
        window: 86400,
        steps: [step({ limit: 2 }), { limit: 5, priority: 'alarm' }]
      }
      expect(errorsOf(rule({ latching: true, detector }))).toEqual([])
    })
  })

  describe('outside a range', () => {
    const outside = (...steps: [number, number, string][]) => ({
      type: 'outside',
      steps: steps.map(([low, high, priority]) => ({ low, high, priority }))
    })

    it('accepts one step and steps that widen on both sides', () => {
      expect(errorsOf(rule({ detector: outside([-25, 25, 'warning']) }))).toEqual([])
      expect(
        errorsOf(rule({ detector: outside([-25, 25, 'warning'], [-35, 35, 'alarm']) }))
      ).toEqual([])
    })

    it('accepts a later step that widens on one side only', () => {
      expect(errorsOf(rule({ detector: outside([49, 51, 'warning'], [49, 52, 'alarm']) }))).toEqual(
        []
      )
    })

    it.each([
      ['equal to', 25],
      ['below', 30]
    ])('refuses a high limit %s the low limit', (_, low) => {
      const errors = errorsOf(rule({ detector: outside([low, 25, 'warning']) }))
      expect(paths(errors)).toEqual(['/detector/steps/0/high'])
      expect(errors[0]?.message).toBe('must be above the low limit')
    })

    it('checks the limit order of every step', () => {
      const detector = outside([-25, 25, 'warning'], [-35, -40, 'alarm'])
      expect(paths(errorsOf(rule({ detector })))).toContain('/detector/steps/1/high')
    })

    it.each<[string, [number, number], string]>([
      ['low', [-20, 35], '/detector/steps/1/low'],
      ['high', [-35, 20], '/detector/steps/1/high']
    ])('refuses a later step whose %s limit moves inward', (_, [low, high], at) => {
      const errors = errorsOf(
        rule({ detector: outside([-25, 25, 'warning'], [low, high, 'alarm']) })
      )
      expect(paths(errors)).toEqual([at])
      expect(errors[0]?.message).toBe("must not be inside the previous step's range")
    })

    it('refuses a later step with the same range at its high limit', () => {
      const errors = errorsOf(rule({ detector: outside([-25, 25, 'warning'], [-25, 25, 'alarm']) }))
      expect(paths(errors)).toEqual(['/detector/steps/1/high'])
    })

    it('refuses a later step out of priority order', () => {
      const errors = errorsOf(rule({ detector: outside([-35, 35, 'alarm'], [-45, 45, 'warning']) }))
      expect(paths(errors)).toEqual(['/detector/steps/1/priority'])
    })

    it('refuses a fifth step', () => {
      const detector = outside(
        [-10, 10, 'caution'],
        [-20, 20, 'warning'],
        [-30, 30, 'alarm'],
        [-40, 40, 'emergency'],
        [-50, 50, 'emergency']
      )
      expect(paths(errorsOf(rule({ detector })))).toEqual(['/detector/steps/4'])
    })

    it('requires at least one step, without offering a zone limit', () => {
      const errors = errorsOf(rule({ detector: { type: 'outside', steps: [] } }))
      expect(paths(errors)).toEqual(['/detector/steps'])
      expect(errors[0]?.message).toBe('a rule needs at least one step')
      expect(paths(errorsOf(rule({ detector: { type: 'outside' } })))).toEqual(['/detector/steps'])
    })

    it('requires both limits on a step', () => {
      const errors = errorsOf(rule({ detector: { type: 'outside', steps: [step({ low: -25 })] } }))
      expect(paths(errors)).toEqual(['/detector/steps/0/high'])
    })

    it('refuses a zone limit', () => {
      const detector = { type: 'outside', limit: { kind: 'zone', level: 'warn' } }
      const errors = errorsOf(rule({ detector }))
      expect(errors).toContainEqual({ path: '/detector/limit', message: 'is not a known property' })
    })

    it("needs hysteresis under half the first step's range to clear", () => {
      const detector = (hysteresis: number) => ({
        ...outside([-25, 25, 'warning']),
        hysteresis
      })
      const errors = errorsOf(rule({ detector: detector(25) }))
      expect(paths(errors)).toEqual(['/detector/hysteresis'])
      expect(errors[0]?.message).toMatch(/half/)
      expect(errorsOf(rule({ detector: detector(24.9) }))).toEqual([])
    })

    it('reports only the step error for an inverted first step with a large hysteresis', () => {
      const detector = { ...outside([30, 25, 'warning']), hysteresis: 10 }
      expect(paths(errorsOf(rule({ detector })))).toEqual(['/detector/steps/0/high'])
    })

    it('checks hysteresis against the first step only', () => {
      const detector = {
        ...outside([-25, 25, 'warning'], [-25.5, 25.5, 'alarm']),
        hysteresis: 20,
        duration: 10,
        clearDuration: 30
      }
      expect(errorsOf(rule({ detector }))).toEqual([])
    })
  })

  describe('match detector', () => {
    it('requires a value for equals', () => {
      expect(
        paths(errorsOf(rule({ detector: { type: 'match', op: 'equals', steps: [step()] } })))
      ).toEqual(['/detector/steps/0/value'])
    })

    it('rejects a value for decreases', () => {
      expect(
        paths(
          errorsOf(
            rule({ detector: { type: 'match', op: 'decreases', steps: [step({ value: 3 })] } })
          )
        )
      ).toEqual(['/detector/steps/0/value'])
    })

    it('rejects a duration on a transition', () => {
      expect(
        paths(
          errorsOf(
            rule({
              detector: {
                type: 'match',
                op: 'changesTo',
                steps: [step({ value: 'on' })],
                duration: 10
              }
            })
          )
        )
      ).toEqual(['/detector/duration'])
    })
  })

  describe('latching', () => {
    it.each<[string, unknown]>([
      ['a count', minimalDetectors.count],
      ['a changesTo match', { type: 'match', op: 'changesTo', steps: [step({ value: true })] }],
      ['a decreases match', { type: 'match', op: 'decreases', steps: [step()] }]
    ])('accepts latching on %s, whose condition is an event', (_what, detector) => {
      expect(errorsOf(rule({ latching: true, detector }))).toEqual([])
    })

    it.each<[string, unknown]>([
      ['an equals match', minimalDetectors.match],
      ['a notEquals match', { type: 'match', op: 'notEquals', steps: [step({ value: 1 })] }],
      ['a timedOut match', { type: 'match', op: 'timedOut', steps: [step()], duration: 30 }],
      ['a sustained detector', minimalDetectors.sustained],
      ['a slope detector', minimalDetectors.slope],
      ['a projection detector', minimalDetectors.projection],
      ['an accumulator', minimalDetectors.accumulator],
      ['an absence detector', minimalDetectors.absence]
    ])('rejects latching on %s, whose condition lasts', (_what, detector) => {
      const errors = errorsOf(rule({ latching: true, detector }))
      expect(paths(errors)).toEqual(['/latching'])
      expect(errors[0]?.message).toContain('return to normal')
    })

    it('rejects latching on a zone-limit rule', () => {
      const detector = {
        type: 'sustained',
        direction: 'below',
        limit: { kind: 'zone', level: 'warn' }
      }
      expect(paths(errorsOf(rule({ latching: true, detector })))).toEqual(['/latching'])
    })

    it('accepts latching false on any detector', () => {
      expect(errorsOf(rule({ latching: false, detector: minimalDetectors.sustained }))).toEqual([])
    })
  })

  describe('timeout rules', () => {
    const timeout = { type: 'match', op: 'timedOut', steps: [step()], duration: 30 }

    it('rejects a timeout rule on a boolean path', () => {
      const errors = errorsOf(rule({ detector: timeout }), () => ({ valueType: 'boolean' }))
      expect(paths(errors)).toEqual(['/signal/path'])
    })

    it('rejects a timeout rule on a string path', () => {
      const errors = errorsOf(rule({ detector: timeout }), () => ({ valueType: 'string' }))
      expect(paths(errors)).toEqual(['/signal/path'])
    })

    it('accepts a timeout rule on a path of unknown type', () => {
      expect(errorsOf(rule({ detector: timeout }), () => undefined)).toEqual([])
    })

    it('requires a duration', () => {
      expect(
        paths(errorsOf(rule({ detector: { type: 'match', op: 'timedOut', steps: [step()] } })))
      ).toEqual(['/detector/duration'])
    })

    it('rejects a timeout rule over a combinator', () => {
      const errors = errorsOf(
        rule({
          signal: { combinator: 'mean', inputs: [{ path: 'a.b' }, { path: 'c.d' }] },
          detector: timeout
        })
      )
      expect(paths(errors)).toEqual(['/detector/op'])
    })
  })

  describe('bounds', () => {
    it('rejects a window longer than 24 h', () => {
      const errors = errorsOf(
        rule({
          detector: {
            type: 'slope',
            direction: 'rising',
            window: 86401,
            steps: [step({ limit: 1 })]
          }
        })
      )
      expect(paths(errors)).toEqual(['/detector/window'])
    })

    it('accepts a window of exactly 24 h', () => {
      expect(
        errorsOf(
          rule({
            detector: {
              type: 'slope',
              direction: 'rising',
              window: 86400,
              steps: [step({ limit: 1 })]
            }
          })
        )
      ).toEqual([])
    })

    it('rejects a zero window', () => {
      const errors = errorsOf(
        rule({
          detector: {
            type: 'count',
            event: { op: 'changes' },
            window: 0,
            steps: [step({ limit: 1 })]
          }
        })
      )
      expect(paths(errors)).toEqual(['/detector/window'])
    })

    it('rejects a negative hysteresis', () => {
      const errors = errorsOf(
        rule({ detector: { ...(minimalDetectors.sustained as object), hysteresis: -1 } })
      )
      expect(paths(errors)).toEqual(['/detector/hysteresis'])
    })
  })

  describe('slug', () => {
    it.each(['Upper', 'with space', 'under_score', '-leading', 'trailing-', 'double--hyphen', ''])(
      'rejects slug %j',
      (slug) => {
        expect(paths(errorsOf(rule({ slug, detector: minimalDetectors.match })))).toEqual(['/slug'])
      }
    )

    it('rejects a slug longer than 64 characters', () => {
      expect(
        paths(errorsOf(rule({ slug: 'a'.repeat(65), detector: minimalDetectors.match })))
      ).toEqual(['/slug'])
    })
  })
})

describe('the alert path', () => {
  const sustained = minimalDetectors.sustained
  const combined = {
    combinator: 'difference',
    inputs: [
      { path: 'electrical.batteries.house.voltage' },
      { path: 'electrical.batteries.start.voltage' }
    ]
  }

  function pathOf(input: unknown): string | undefined {
    const result = validateRule(input)
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    return alertPathOf(result.value)
  }

  it("defaults to the input's parent and the default condition name, storing none", () => {
    const result = validateRule(rule({ detector: sustained }))
    expect(result.ok && result.value.condition).toBeUndefined()
    expect(pathOf(rule({ detector: sustained }))).toBe('electrical.batteries.house.voltageLow')
  })

  it('keeps the wildcard of a wildcard input in the parent', () => {
    const wild = rule({ signal: { path: 'electrical.batteries.*.voltage' }, detector: sustained })
    expect(pathOf(wild)).toBe('electrical.batteries.*.voltageLow')
    expect(pathOf({ ...wild, condition: 'flat' })).toBe('electrical.batteries.*.flat')
  })

  it("puts a stored condition name under the input's parent", () => {
    expect(pathOf(rule({ detector: sustained, condition: 'flat' }))).toBe(
      'electrical.batteries.house.flat'
    )
  })

  it("puts a combined signal's condition name under its inputs' common parent", () => {
    expect(pathOf(rule({ signal: combined, detector: sustained, condition: 'diverge' }))).toBe(
      'electrical.batteries.diverge'
    )
    const apart = {
      combinator: 'difference',
      inputs: [{ path: 'environment.depth.belowKeel' }, { path: 'navigation.speedThroughWater' }]
    }
    expect(pathOf(rule({ signal: apart, detector: sustained, condition: 'shoaling' }))).toBe(
      'shoaling'
    )
  })

  it('refuses a combined signal without a condition name, saying why', () => {
    const missing = {
      path: '/condition',
      message: 'is required: a rule over several paths has no default name'
    }
    expect(errorsOf({ ...base, signal: combined, detector: sustained })).toEqual([missing])
    // Reported with the rule's other errors, not before them.
    expect(errorsOf({ ...base, signal: combined, detector: sustained, latching: true })).toEqual([
      missing,
      expect.objectContaining({ path: '/latching' })
    ])
    expect(errorsOf({ ...base, signal: combined, detector: { type: 'magic' } })).toEqual([
      missing,
      expect.objectContaining({ path: '/detector/type' })
    ])
  })

  it('refuses an input ending in a wildcard without a condition name', () => {
    const wildLeaf = rule({
      signal: { path: 'electrical.batteries.*' },
      detector: minimalDetectors.match
    })
    expect(paths(errorsOf(wildLeaf))).toEqual(['/condition'])
    // The instance is part of the parent, so each has an alert of its own.
    expect(pathOf({ ...wildLeaf, condition: 'fault' })).toBe('electrical.batteries.*.fault')
  })

  it('refuses a condition name that is not one segment core accepts', () => {
    for (const condition of ['', 'house.low', '*', 'low voltage', ' low', '__proto__']) {
      expect(paths(errorsOf(rule({ detector: sustained, condition })))).toEqual(['/condition'])
    }
  })

  it('refuses an alert path field: only the condition name is stored', () => {
    const given = rule({ detector: sustained, alertPath: 'electrical.batteries.house.low' })
    expect(paths(errorsOf(given))).toEqual(['/alertPath'])
  })

  it('refuses an overlong alert path at the condition name, or at the input without one', () => {
    const long = 'x'.repeat(250)
    expect(paths(errorsOf(rule({ detector: sustained, condition: long })))).toEqual(['/condition'])
    const deep = rule({ signal: { path: `a.${long}.voltage` }, detector: sustained })
    expect(paths(errorsOf(deep))).toEqual(['/signal/path'])
  })

  it('refuses a parent segment core forbids at the input', () => {
    const proto = rule({ signal: { path: 'a.__proto__.voltage' }, detector: sustained })
    expect(paths(errorsOf(proto))).toEqual(['/signal/path'])
    // A combined signal's parent is common to its inputs, so the first stands for them.
    const protoCombined = rule({
      signal: {
        combinator: 'difference',
        inputs: [{ path: 'a.__proto__.b.voltage' }, { path: 'a.__proto__.c.voltage' }]
      },
      detector: sustained,
      condition: 'diverge'
    })
    expect(errorsOf(protoCombined)).toEqual([
      { path: '/signal/inputs/0/path', message: '"__proto__" is not allowed in an alert path' }
    ])
  })

  describe('of a field', () => {
    const heel = { type: 'outside', steps: [step({ low: -0.35, high: 0.35 })] }

    it('puts the field under its base path, named after the field', () => {
      expect(pathOf(rule({ signal: { path: 'navigation.attitude#/roll' }, detector: heel }))).toBe(
        'navigation.attitude.rollOutOfRange'
      )
      expect(pathOf(rule({ signal: { path: 'a.b#/c/d' }, detector: sustained }))).toBe('a.b.c.dLow')
    })

    it('needs no condition name when its base path ends in a wildcard', () => {
      const wild = rule({ signal: { path: 'electrical.batteries.*#/x' }, detector: sustained })
      expect(pathOf(wild)).toBe('electrical.batteries.*.xLow')
    })

    it('counts a wildcard just before the pointer, so a wildcard gate is allowed', () => {
      const wild = rule({
        signal: { path: 'electrical.batteries.*#/x' },
        detector: sustained,
        gates: [
          {
            signal: { path: 'electrical.batteries.*.current' },
            direction: 'above',
            limit: { kind: 'fixed', value: 1 }
          }
        ]
      })
      expect(errorsOf(wild)).toEqual([])
    })

    it('refuses a stored path whose segment holds "#" not starting a pointer', () => {
      const stored = rule({
        signal: { path: 'electrical.batteries.#1.voltage' },
        detector: sustained
      })
      expect(errorsOf(stored).map((e) => e.path)).toEqual(['/signal/path'])
    })

    it('refuses a field name core forbids in the parent at the input', () => {
      const proto = rule({ signal: { path: 'a#/__proto__/b' }, detector: sustained })
      expect(errorsOf(proto)).toEqual([
        { path: '/signal/path', message: '"__proto__" is not allowed in an alert path' }
      ])
    })
  })
})

describe('the template record', () => {
  const record = {
    set: 'batteries',
    id: 'voltage-low',
    version: '1.0.0',
    pick: { instance: 'house', source: 'can0.12' }
  }
  const detector = minimalDetectors.match

  it('is accepted as information about the template a rule came from', () => {
    expect(errorsOf(rule({ detector, template: record }))).toEqual([])
    expect(errorsOf(rule({ detector, template: { ...record, pick: {} } }))).toEqual([])
  })

  it('is accepted with the instance pick a single-slot template stored', () => {
    const template = { ...record, pick: { instance: 'house' } }
    expect(errorsOf(rule({ detector, template }))).toEqual([])
  })

  it("is accepted with each slot's pick by slot name, and a source", () => {
    const pick = { battery: 'start', engine: 'main', source: 'can0.12' }
    expect(errorsOf(rule({ detector, template: { ...record, pick } }))).toEqual([])
  })

  it.each([
    ['without its set', { ...record, set: undefined }, '/template/set'],
    ['with a set id that is not a slug', { ...record, set: 'Batteries' }, '/template/set'],
    ['without its version', { ...record, version: '' }, '/template/version'],
    [
      'with a pick key that is not a slot name',
      { ...record, pick: { 'main-engine': 'house' } },
      '/template/pick/main-engine'
    ],
    [
      'with a slot pick of two segments',
      { ...record, pick: { battery: 'start', engine: 'main.port' } },
      '/template/pick/engine'
    ],
    [
      'with more picks than slots and a source',
      { ...record, pick: { a: '1', b: '2', c: '3', d: '4', e: '5', source: 'x' } },
      '/template/pick'
    ],
    ['with an empty instance', { ...record, pick: { instance: '' } }, '/template/pick/instance'],
    [
      'with an instance of two segments',
      { ...record, pick: { instance: 'house.port' } },
      '/template/pick/instance'
    ],
    ['with a wildcard instance', { ...record, pick: { instance: '*' } }, '/template/pick/instance'],
    [
      'with a field pointer in a slot pick',
      { ...record, pick: { battery: 'start', engine: 'main#/x' } },
      '/template/pick/engine'
    ],
    ['with a field of its own', { ...record, extra: 1 }, '/template/extra']
  ])('is refused %s', (_, template, path) => {
    expect(paths(errorsOf(rule({ detector, template })))).toEqual([path])
  })
})
