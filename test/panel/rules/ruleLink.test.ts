import { describe, expect, it } from 'vitest'
import { hashWithRule, parseRuleFragment } from '../../../src/panel/rules/ruleLink'

const ADMIN = '#/apps/configuration/signalk-alert-rules'

describe('parseRuleFragment', () => {
  it('reads the rule after the admin UI route', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=user/oil-pressure-low`)).toEqual({
      origin: 'user',
      slug: 'oil-pressure-low'
    })
  })

  it('reads the rule when it is the whole fragment', () => {
    expect(parseRuleFragment('#rule=user/a')).toEqual({ origin: 'user', slug: 'a' })
  })

  it('reads a scoped package origin, whose name has a slash of its own', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=%40acme%2Frules/engine-hours`)).toEqual({
      origin: '@acme/rules',
      slug: 'engine-hours'
    })
  })

  it('reads the instance after the rule', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=user/battery-low&instance=house`)).toEqual({
      origin: 'user',
      slug: 'battery-low',
      instance: 'house'
    })
    expect(parseRuleFragment('#rule=%40acme%2Frules/x&instance=a%26b%2Fc')).toEqual({
      origin: '@acme/rules',
      slug: 'x',
      instance: 'a&b/c'
    })
  })

  it('ignores an empty instance or other parameters', () => {
    expect(parseRuleFragment(`${ADMIN}#rule=user/a&instance=`)).toEqual({
      origin: 'user',
      slug: 'a'
    })
    expect(parseRuleFragment(`${ADMIN}#rule=user/a&later=1`)).toEqual({ origin: 'user', slug: 'a' })
  })

  it('finds no rule without the marker or with an incomplete one', () => {
    expect(parseRuleFragment(ADMIN)).toBeUndefined()
    expect(parseRuleFragment('')).toBeUndefined()
    expect(parseRuleFragment(`${ADMIN}#rule=user`)).toBeUndefined()
    expect(parseRuleFragment(`${ADMIN}#rule=user/`)).toBeUndefined()
    expect(parseRuleFragment(`${ADMIN}#rule=%E0%A4%A/x`)).toBeUndefined()
  })
})

describe('hashWithRule', () => {
  it('appends the rule to the admin UI route', () => {
    expect(hashWithRule(ADMIN, { origin: 'user', slug: 'a' })).toBe(`${ADMIN}#rule=user/a`)
  })

  it('replaces a rule already there', () => {
    expect(hashWithRule(`${ADMIN}#rule=user/a`, { origin: '@acme/rules', slug: 'b' })).toBe(
      `${ADMIN}#rule=%40acme%2Frules/b`
    )
  })

  it('adds the instance, escaped', () => {
    expect(hashWithRule(ADMIN, { origin: 'user', slug: 'a', instance: 'a&b' })).toBe(
      `${ADMIN}#rule=user/a&instance=a%26b`
    )
  })

  it('drops the rule, keeping the admin UI route', () => {
    expect(hashWithRule(`${ADMIN}#rule=user/a`)).toBe(ADMIN)
  })

  it('keeps a link to this page when there is no route to keep', () => {
    expect(hashWithRule('#rule=user/a')).toBe('#')
    expect(hashWithRule('', { origin: 'user', slug: 'a' })).toBe('#rule=user/a')
  })
})
