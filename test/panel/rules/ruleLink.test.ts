import { describe, expect, it } from 'vitest'
import { hashWithRule, parseRuleFragment } from '../../../src/panel/rules/ruleLink'

const ADMIN = '#/e/signalk_alert_rules'

describe('parseRuleFragment', () => {
  it('reads the rule after the admin UI route', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=oil-pressure-low`)).toEqual({
      slug: 'oil-pressure-low'
    })
  })

  it('reads the rule when it is the whole fragment', () => {
    expect(parseRuleFragment('#rule=a')).toEqual({ slug: 'a' })
  })

  it('reads the instance after the rule', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=battery-low&instance=house`)).toEqual({
      slug: 'battery-low',
      instance: 'house'
    })
    expect(parseRuleFragment('#rule=x&instance=a%26b%2Fc')).toEqual({
      slug: 'x',
      instance: 'a&b/c'
    })
  })

  it('ignores an empty instance or other parameters', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=a&instance=`)).toEqual({ slug: 'a' })
    expect(parseRuleFragment(`${ADMIN}#rule=a&later=1`)).toEqual({ slug: 'a' })
  })

  it('reads a slug no rule can have as it is, which then finds no rule', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=user%2Fa`)).toEqual({ slug: 'user/a' })
  })

  it('finds no rule without the marker or with an incomplete one', () => {
    expect(parseRuleFragment(ADMIN)).toBeUndefined()
    expect(parseRuleFragment('')).toBeUndefined()
    expect(parseRuleFragment(`${ADMIN}#rule=`)).toBeUndefined()
    expect(parseRuleFragment(`${ADMIN}#rule=%E0%A4%A`)).toBeUndefined()
  })
})

describe('hashWithRule', () => {
  it('appends the rule to the admin UI route', () => {
    expect(hashWithRule(ADMIN, { slug: 'a' })).toBe(`${ADMIN}#rule=a`)
  })

  it('replaces a rule already there', () => {
    expect(hashWithRule(`${ADMIN}#rule=a`, { slug: 'b' })).toBe(`${ADMIN}#rule=b`)
  })

  it('escapes the slug and the instance', () => {
    expect(hashWithRule(ADMIN, { slug: 'a/b', instance: 'a&b' })).toBe(
      `${ADMIN}#rule=a%2Fb&instance=a%26b`
    )
  })

  it('drops the rule, keeping the admin UI route', () => {
    expect(hashWithRule(`${ADMIN}#rule=a`)).toBe(ADMIN)
  })

  it('keeps a link to this page when there is no route to keep', () => {
    expect(hashWithRule('#rule=a')).toBe('#')
    expect(hashWithRule('', { slug: 'a' })).toBe('#rule=a')
  })
})
