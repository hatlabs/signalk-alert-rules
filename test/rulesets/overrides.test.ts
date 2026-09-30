import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import type { Ruleset } from '../../src/model/ruleset.js'
import { validateRuleset } from '../../src/model/validate.js'
import { upgradeRuleset, withParameters } from '../../src/rulesets/overrides.js'
import type { RulesetControl } from '../../src/store/store.js'

const AT = '2026-09-30T12:00:00.000Z'

function rule(slug: string, limit: unknown = { param: 'lowVoltage' }) {
  return {
    name: `Rule ${slug}`,
    slug,
    message: 'Battery voltage low',
    priority: 'warning',
    signal: { path: '${prefix}.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      limit: { kind: 'fixed', value: limit },
      duration: 60
    }
  }
}

function ruleset(version: string, rules: unknown[], lowVoltage: Record<string, unknown> = {}) {
  const result = validateRuleset({
    name: 'Batteries',
    slug: 'batteries',
    version,
    parameters: [
      { name: 'prefix', type: 'string', default: 'electrical.batteries.house' },
      { name: 'lowVoltage', type: 'number', default: 12, minimum: 10, maximum: 14, ...lowVoltage }
    ],
    rules
  })
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

function stored(overrides: Partial<RulesetControl> = {}): RulesetControl {
  return {
    enabled: true,
    parameters: {},
    version: '1.0.0',
    rules: ['low', 'gone'],
    notices: [],
    ...overrides
  }
}

describe('upgradeRuleset', () => {
  it('records a newly discovered ruleset as disabled with its rules at the defaults', () => {
    const upgrade = upgradeRuleset(ruleset('1.0.0', [rule('low')]), undefined, AT)

    expect(upgrade.control).toEqual({
      enabled: false,
      parameters: {},
      version: '1.0.0',
      rules: ['low'],
      notices: []
    })
    expect(upgrade.removed).toEqual([])
    expect(upgrade.rules.map((r) => [r.slug, r.signal])).toEqual([
      ['low', { path: 'electrical.batteries.house.voltage' }]
    ])
  })

  it('keeps the settings of surviving rules and reports a removed one', () => {
    const upgrade = upgradeRuleset(
      ruleset('2.0.0', [rule('low'), rule('new')]),
      stored({ parameters: { lowVoltage: 11 } }),
      AT
    )

    expect(upgrade.removed).toEqual(['gone'])
    expect(upgrade.control).toMatchObject({
      enabled: true,
      parameters: { lowVoltage: 11 },
      version: '2.0.0',
      rules: ['low', 'new']
    })
    expect(upgrade.control.notices).toEqual([
      { at: AT, message: expect.stringMatching(/rule gone .*2\.0\.0.*cleared/) as string }
    ])
    expect(upgrade.rules[0]?.detector).toMatchObject({ limit: { value: 11 } })
  })

  it.each([
    ['a parameter the ruleset no longer has', { voltage: 11 }, /voltage/],
    ['a value of the wrong type', { lowVoltage: 'low' }, /lowVoltage/],
    ['a value outside the new bounds', { lowVoltage: 9 }, /lowVoltage.*at least 10/]
  ])('drops %s with a notice and applies the default', (_, parameters, message) => {
    const upgrade = upgradeRuleset(
      ruleset('2.0.0', [rule('low')], { minimum: 10 }),
      stored({
        rules: ['low'],
        parameters: { ...parameters, prefix: 'electrical.batteries.start' }
      }),
      AT
    )

    expect(upgrade.control.parameters).toEqual({ prefix: 'electrical.batteries.start' })
    expect(upgrade.control.notices).toEqual([
      { at: AT, message: expect.stringMatching(message) as string }
    ])
    expect(upgrade.rules[0]?.detector).toMatchObject({ limit: { value: 12 } })
  })

  it('drops every value when together they no longer make valid rules', () => {
    // Each value is in bounds, but a zero duration is not a valid sustained rule.
    const zeroDelay = {
      ...rule('low'),
      detector: { ...rule('low').detector, duration: { param: 'lowVoltage' } }
    }
    const upgrade = upgradeRuleset(
      ruleset('2.0.0', [zeroDelay], { minimum: -1 }),
      stored({ rules: ['low'], parameters: { lowVoltage: -1 } }),
      AT
    )

    expect(upgrade.control.parameters).toEqual({})
    expect(upgrade.control.notices).toEqual([
      { at: AT, message: expect.stringMatching(/defaults apply/) as string }
    ])
    expect(upgrade.rules[0]?.detector).toMatchObject({ duration: 12 })
  })

  it('keeps earlier notices until they are dismissed', () => {
    const earlier = { at: '2026-01-01T00:00:00.000Z', message: 'earlier' }
    const upgrade = upgradeRuleset(
      ruleset('1.0.0', [rule('low')]),
      stored({ rules: ['low'], notices: [earlier] }),
      AT
    )
    expect(upgrade.control.notices).toEqual([earlier])
  })

  it('does not change the parsed ruleset when YAML aliases share its objects', () => {
    const text = [
      'name: Batteries',
      'slug: batteries',
      'version: "1"',
      'parameters:',
      '  - { name: lowVoltage, type: number, default: 12 }',
      'rules:',
      '  - name: A',
      '    slug: a',
      '    message: A',
      '    priority: warning',
      '    signal: &signal { path: electrical.batteries.house.voltage }',
      '    detector: &detector',
      '      type: sustained',
      '      direction: below',
      '      limit: { kind: fixed, value: { param: lowVoltage } }',
      '  - name: B',
      '    slug: b',
      '    message: B',
      '    priority: warning',
      '    signal: *signal',
      '    detector: *detector'
    ].join('\n')
    const parsed = validateRuleset(parseDocument(text, { schema: 'core' }).toJS())
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    const before = JSON.stringify(parsed.value)

    const upgrade = upgradeRuleset(parsed.value, stored({ parameters: { lowVoltage: 11 } }), AT)
    const [a, b] = upgrade.rules

    expect(a.detector).not.toBe(b.detector)
    expect(a.signal).not.toBe(b.signal)
    expect(JSON.stringify(parsed.value)).toBe(before)
  })
})

describe('withParameters', () => {
  const batteries: Ruleset = ruleset('1.0.0', [rule('low'), rule('fixed', 11)])

  it('resolves the rules with the values given and the defaults for the rest', () => {
    const result = withParameters(batteries, { lowVoltage: 13 })
    expect(result.ok && result.value.map((r) => r.detector)).toMatchObject([
      { limit: { value: 13 } },
      { limit: { value: 11 } }
    ])
  })

  it('refuses a value out of bounds, naming it', () => {
    const result = withParameters(batteries, { lowVoltage: 20 })
    expect(result.ok ? [] : result.errors.map((e) => e.path)).toEqual(['/values/lowVoltage'])
  })

  it('refuses values that are not an object', () => {
    const result = withParameters(batteries, [12])
    expect(result.ok ? [] : result.errors.map((e) => e.path)).toEqual([''])
  })
})
