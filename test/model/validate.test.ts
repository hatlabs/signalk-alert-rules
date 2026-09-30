import { describe, it, expect } from 'vitest'
import {
  alertPathFor,
  findRulesetSlugConflicts,
  resolveRuleset,
  validateRule,
  validateRuleSet,
  validateRuleset,
  type PathInfo,
  type ValidationError
} from '../../src/model/validate.js'
import { MAX_RULES, type Rule } from '../../src/model/rule.js'
import type { Ruleset } from '../../src/model/ruleset.js'
import { workedExamples } from '../fixtures/worked-examples.js'

const base = {
  name: 'Test rule',
  slug: 'test-rule',
  message: 'Something happened',
  priority: 'warning',
  signal: { path: 'electrical.batteries.house.voltage' }
}

function rule(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...overrides }
}

function unprioritised(overrides: Record<string, unknown>): Record<string, unknown> {
  const { priority: _priority, ...rest } = rule(overrides)
  return rest
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
  match: { type: 'match', op: 'equals', value: 1 },
  sustained: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 12 } },
  slope: { type: 'slope', direction: 'rising', window: 60, limit: 0.01 },
  projection: {
    type: 'projection',
    direction: 'falling',
    limit: { kind: 'fixed', value: 11.5 },
    window: 600,
    horizon: 1800
  },
  accumulator: { type: 'accumulator', measure: 'integral', limit: 1000 },
  count: { type: 'count', event: { op: 'decreases' }, window: 3600, limit: 3 },
  absence: { type: 'absence', event: { op: 'changes' }, within: 600 }
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
      rule({ detector: { type: 'slope', direction: 'rising', window: 'x', limit: 1 } })
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
    expect(paths(errors)).toEqual(['/detector/limit'])
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

  describe('limits and priority', () => {
    it('rejects a zone level that zones do not raise on', () => {
      const errors = errorsOf(
        unprioritised({
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
        unprioritised({
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

    const zoneDetector = {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'zone', level: 'warn' }
    }

    it('accepts a zone-limit rule without a priority: its levels set it', () => {
      expect(errorsOf(unprioritised({ detector: zoneDetector }))).toEqual([])
    })

    it('rejects a priority on a zone-limit rule', () => {
      const errors = errorsOf(rule({ detector: zoneDetector }))
      expect(paths(errors)).toEqual(['/priority'])
      expect(errors[0]?.message).toMatch(/zone/)
    })

    it.each(['sustained', 'projection', 'match', 'count'])(
      'requires a priority on a %s rule without a zone limit',
      (type) => {
        expect(paths(errorsOf(unprioritised({ detector: minimalDetectors[type] })))).toEqual([
          '/priority'
        ])
      }
    )

    it('requires a priority when only a gate has a zone limit', () => {
      const gates = [
        {
          signal: { path: 'propulsion.main.revolutions' },
          direction: 'above',
          limit: { kind: 'zone', level: 'warn' }
        }
      ]
      expect(paths(errorsOf(unprioritised({ detector: minimalDetectors.match, gates })))).toEqual([
        '/priority'
      ])
      expect(errorsOf(rule({ detector: minimalDetectors.match, gates }))).toEqual([])
    })

    it('rejects an unknown priority', () => {
      expect(
        paths(errorsOf(rule({ priority: 'urgent', detector: minimalDetectors.match })))
      ).toEqual(['/priority'])
    })
  })

  describe('match detector', () => {
    it('requires a value for equals', () => {
      expect(paths(errorsOf(rule({ detector: { type: 'match', op: 'equals' } })))).toEqual([
        '/detector/value'
      ])
    })

    it('rejects a value for decreases', () => {
      expect(
        paths(errorsOf(rule({ detector: { type: 'match', op: 'decreases', value: 3 } })))
      ).toEqual(['/detector/value'])
    })

    it('rejects a duration on a transition', () => {
      expect(
        paths(
          errorsOf(
            rule({ detector: { type: 'match', op: 'changesTo', value: 'on', duration: 10 } })
          )
        )
      ).toEqual(['/detector/duration'])
    })
  })

  describe('latching', () => {
    it.each<[string, unknown]>([
      ['a count', minimalDetectors.count],
      ['a changesTo match', { type: 'match', op: 'changesTo', value: true }],
      ['a decreases match', { type: 'match', op: 'decreases' }]
    ])('accepts latching on %s, whose condition is an event', (_what, detector) => {
      expect(errorsOf(rule({ latching: true, detector }))).toEqual([])
    })

    it.each<[string, unknown]>([
      ['an equals match', { type: 'match', op: 'equals', value: 1 }],
      ['a notEquals match', { type: 'match', op: 'notEquals', value: 1 }],
      ['a timedOut match', { type: 'match', op: 'timedOut', duration: 30 }],
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
      expect(paths(errorsOf(unprioritised({ latching: true, detector })))).toEqual(['/latching'])
    })

    it('accepts latching false on any detector', () => {
      expect(errorsOf(rule({ latching: false, detector: minimalDetectors.sustained }))).toEqual([])
    })
  })

  describe('timeout rules', () => {
    const timeout = { type: 'match', op: 'timedOut', duration: 30 }

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
      expect(paths(errorsOf(rule({ detector: { type: 'match', op: 'timedOut' } })))).toEqual([
        '/detector/duration'
      ])
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
        rule({ detector: { type: 'slope', direction: 'rising', window: 86401, limit: 1 } })
      )
      expect(paths(errors)).toEqual(['/detector/window'])
    })

    it('accepts a window of exactly 24 h', () => {
      expect(
        errorsOf(
          rule({ detector: { type: 'slope', direction: 'rising', window: 86400, limit: 1 } })
        )
      ).toEqual([])
    })

    it('rejects a zero window', () => {
      const errors = errorsOf(
        rule({ detector: { type: 'count', event: { op: 'changes' }, window: 0, limit: 1 } })
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

describe('validateRuleSet', () => {
  function valid(slug: string): Rule {
    const result = validateRule(rule({ slug, detector: minimalDetectors.match }))
    if (!result.ok) throw new Error('fixture invalid')
    return result.value
  }

  it('accepts distinct slugs, and the same slug in different origins', () => {
    expect(
      validateRuleSet([
        { origin: 'user', rule: valid('a') },
        { origin: 'user', rule: valid('b') },
        { origin: 'batteries', rule: valid('a') }
      ])
    ).toEqual([])
  })

  it('rejects a duplicate slug within an origin', () => {
    const errors = validateRuleSet([
      { origin: 'user', rule: valid('a') },
      { origin: 'user', rule: valid('a') }
    ])
    expect(paths(errors)).toEqual(['/1/slug'])
  })

  it('rejects more than the rule limit', () => {
    const entries = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({
      origin: 'user',
      rule: valid(`r${String(i)}`)
    }))
    expect(paths(validateRuleSet(entries))).toEqual([''])
    expect(validateRuleSet(entries.slice(1))).toEqual([])
  })
})

describe('alertPathFor', () => {
  it('builds the reserved path', () => {
    expect(alertPathFor('user', 'low-battery')).toEqual({
      ok: true,
      value: 'rules.user.low-battery'
    })
    expect(alertPathFor('engines', 'hot', 'port')).toEqual({
      ok: true,
      value: 'rules.engines.hot.port'
    })
  })

  it('rejects an instance that is not a valid segment', () => {
    expect(alertPathFor('user', 'hot', 'port side').ok).toBe(false)
  })

  it('rejects a path over 255 characters', () => {
    expect(alertPathFor('user', 'hot', 'x'.repeat(250)).ok).toBe(false)
  })
})

const ruleset = {
  name: 'Battery monitoring',
  slug: 'batteries',
  version: '1.2.0',
  parameters: [
    { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
    { name: 'lowVoltage', type: 'number', unit: 'V', default: 12, minimum: 10, maximum: 14 },
    { name: 'delay', type: 'number', unit: 's', default: 60, minimum: 0, maximum: 600 }
  ],
  rules: [
    {
      name: 'Battery low',
      slug: 'low',
      message: 'Battery voltage low',
      priority: 'warning',
      signal: { path: '${prefix}.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        limit: { kind: 'fixed', value: { param: 'lowVoltage' } },
        duration: { param: 'delay' }
      }
    }
  ]
}

function rulesetErrors(input: unknown): ValidationError[] {
  const result = validateRuleset(input)
  return result.ok ? [] : result.errors
}

function withRule(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...ruleset, rules: [{ ...ruleset.rules[0], ...changes }] }
}

describe('validateRuleset', () => {
  it('accepts a parameterised ruleset', () => {
    expect(rulesetErrors(ruleset)).toEqual([])
  })

  it('rejects a reference to an undeclared parameter', () => {
    const errors = rulesetErrors(
      withRule({ detector: { ...ruleset.rules[0]?.detector, duration: { param: 'missing' } } })
    )
    expect(paths(errors)).toEqual(['/rules/0/detector/duration'])
  })

  it('rejects an undeclared parameter in a path', () => {
    const errors = rulesetErrors(withRule({ signal: { path: '${nope}.voltage' } }))
    expect(paths(errors)).toEqual(['/rules/0/signal/path'])
  })

  it('rejects a string parameter used as a number', () => {
    const errors = rulesetErrors(
      withRule({ detector: { ...ruleset.rules[0]?.detector, duration: { param: 'prefix' } } })
    )
    expect(paths(errors)).toEqual(['/rules/0/detector/duration'])
  })

  it('rejects a default outside the parameter bounds', () => {
    const parameters = [
      ...ruleset.parameters.slice(0, 1),
      { name: 'lowVoltage', type: 'number', default: 20, maximum: 14 },
      ruleset.parameters[2]
    ]
    expect(paths(rulesetErrors({ ...ruleset, parameters }))).toEqual(['/parameters/1/default'])
  })

  it('rejects the reserved slug user', () => {
    expect(paths(rulesetErrors({ ...ruleset, slug: 'user' }))).toEqual(['/slug'])
  })

  it('rejects duplicate rule slugs', () => {
    expect(
      paths(rulesetErrors({ ...ruleset, rules: [ruleset.rules[0], ruleset.rules[0]] }))
    ).toEqual(['/rules/1/slug'])
  })

  it('rejects duplicate parameter names', () => {
    const parameters = [...ruleset.parameters, ruleset.parameters[0]]
    expect(paths(rulesetErrors({ ...ruleset, parameters }))).toEqual(['/parameters/3/name'])
  })

  it('reports rule errors that only appear once defaults are substituted', () => {
    const parameters = [
      ruleset.parameters[0],
      ruleset.parameters[1],
      { name: 'delay', type: 'number', default: 90000 }
    ]
    expect(paths(rulesetErrors({ ...ruleset, parameters }))).toEqual(['/rules/0/detector/duration'])
  })
})

describe('resolveRuleset', () => {
  function parsed(): Ruleset {
    const result = validateRuleset(ruleset)
    if (!result.ok) throw new Error('fixture invalid')
    return result.value
  }

  it('substitutes defaults', () => {
    const result = resolveRuleset(parsed(), {})
    expect(result.ok && result.value[0]).toMatchObject({
      signal: { path: 'electrical.batteries.house.voltage' },
      detector: { limit: { kind: 'fixed', value: 12 }, duration: 60 }
    })
  })

  it('substitutes user values', () => {
    const result = resolveRuleset(parsed(), {
      prefix: 'electrical.batteries.start',
      lowVoltage: 11.8
    })
    expect(result.ok && result.value[0]).toMatchObject({
      signal: { path: 'electrical.batteries.start.voltage' },
      detector: { limit: { value: 11.8 } }
    })
  })

  it('rejects a value outside bounds', () => {
    const result = resolveRuleset(parsed(), { lowVoltage: 9 })
    expect(result.ok ? [] : paths(result.errors)).toEqual(['/values/lowVoltage'])
  })

  it('rejects a value of the wrong type', () => {
    const result = resolveRuleset(parsed(), { lowVoltage: 'high' })
    expect(result.ok ? [] : paths(result.errors)).toEqual(['/values/lowVoltage'])
  })

  it('rejects a value for an undeclared parameter', () => {
    const result = resolveRuleset(parsed(), { other: 1 })
    expect(result.ok ? [] : paths(result.errors)).toEqual(['/values/other'])
  })

  it('reports a substituted path that is invalid', () => {
    const result = resolveRuleset(parsed(), { prefix: 'electrical..house' })
    expect(result.ok ? [] : paths(result.errors)).toEqual(['/rules/0/signal/path'])
  })
})

describe('findRulesetSlugConflicts', () => {
  it('reports every ruleset sharing a slug', () => {
    const a = { slug: 'batteries' }
    const b = { slug: 'engines' }
    expect(findRulesetSlugConflicts([a, b, a])).toEqual(new Set(['batteries']))
  })
})
