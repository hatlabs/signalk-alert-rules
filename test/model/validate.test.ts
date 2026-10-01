import { describe, it, expect } from 'vitest'
import { alertPathOf } from '../../src/alerts/paths.js'
import { validateRule, type PathInfo, type ValidationError } from '../../src/model/validate.js'
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

  it.each([
    ['without its set', { ...record, set: undefined }, '/template/set'],
    ['with a set id that is not a slug', { ...record, set: 'Batteries' }, '/template/set'],
    ['without its version', { ...record, version: '' }, '/template/version'],
    ['with a pick of another part', { ...record, pick: { bank: 'house' } }, '/template/pick/bank'],
    ['with an empty instance', { ...record, pick: { instance: '' } }, '/template/pick/instance'],
    [
      'with an instance of two segments',
      { ...record, pick: { instance: 'house.port' } },
      '/template/pick/instance'
    ],
    ['with a wildcard instance', { ...record, pick: { instance: '*' } }, '/template/pick/instance'],
    ['with a field of its own', { ...record, extra: 1 }, '/template/extra']
  ])('is refused %s', (_, template, path) => {
    expect(paths(errorsOf(rule({ detector, template })))).toEqual([path])
  })
})
