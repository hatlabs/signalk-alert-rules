import { describe, expect, it } from 'vitest'
import { hashWithRoute, parseRoute, type Route } from '../../src/panel/route'

const ADMIN = '#/e/signalk_alert_rules'

describe('parseRoute', () => {
  it('reads the list from the admin UI route alone, or from nothing', () => {
    expect(parseRoute(ADMIN)).toEqual({ kind: 'list' })
    expect(parseRoute('')).toEqual({ kind: 'list' })
    expect(parseRoute('#')).toEqual({ kind: 'list' })
  })

  it('reads the rule after the admin UI route', () => {
    expect(parseRoute(`${ADMIN}#rule=oil-pressure-low`)).toEqual({
      kind: 'rule',
      slug: 'oil-pressure-low'
    })
  })

  it('reads the rule when it is the whole fragment', () => {
    expect(parseRoute('#rule=a')).toEqual({ kind: 'rule', slug: 'a' })
  })

  it('reads the instance after the rule', () => {
    expect(parseRoute(`${ADMIN}#rule=battery-low&instance=house`)).toEqual({
      kind: 'rule',
      slug: 'battery-low',
      instance: 'house'
    })
    expect(parseRoute('#rule=x&instance=a%26b%2Fc')).toEqual({
      kind: 'rule',
      slug: 'x',
      instance: 'a&b/c'
    })
  })

  it('ignores an empty instance or other parameters', () => {
    expect(parseRoute(`${ADMIN}#rule=a&instance=`)).toEqual({ kind: 'rule', slug: 'a' })
    expect(parseRoute(`${ADMIN}#rule=a&later=1`)).toEqual({ kind: 'rule', slug: 'a' })
  })

  it('reads a slug no rule can have as it is, which then finds no rule', () => {
    expect(parseRoute(`${ADMIN}#rule=user%2Fa`)).toEqual({ kind: 'rule', slug: 'user/a' })
  })

  it('reads a rule link without a slug, or one that does not decode, as the list', () => {
    expect(parseRoute(`${ADMIN}#rule=`)).toEqual({ kind: 'list' })
    expect(parseRoute(`${ADMIN}#rule=%E0%A4%A`)).toEqual({ kind: 'list' })
    expect(parseRoute(`${ADMIN}#edit=`)).toEqual({ kind: 'list' })
  })

  it('reads the editor of a rule', () => {
    expect(parseRoute(`${ADMIN}#edit=a%2Fb`)).toEqual({ kind: 'edit', slug: 'a/b' })
  })

  it('reads Add rule and its two ways to start', () => {
    expect(parseRoute(`${ADMIN}#add`)).toEqual({ kind: 'add' })
    expect(parseRoute(`${ADMIN}#add=template`)).toEqual({ kind: 'add', from: 'template' })
    expect(parseRoute(`${ADMIN}#add=path`)).toEqual({ kind: 'add', from: 'path' })
    expect(parseRoute(`${ADMIN}#add=path&later=1`)).toEqual({ kind: 'add', from: 'path' })
  })

  it('reads the value and condition kind chosen From a path', () => {
    expect(parseRoute(`${ADMIN}#add=path&path=electrical.batteries.house.voltage`)).toEqual({
      kind: 'add',
      from: 'path',
      path: 'electrical.batteries.house.voltage'
    })
    expect(parseRoute(`${ADMIN}#add=path&path=a.b&when=below`)).toEqual({
      kind: 'add',
      from: 'path',
      path: 'a.b',
      when: 'below'
    })
  })

  it('drops a condition kind it does not know, or one without a path', () => {
    expect(parseRoute(`${ADMIN}#add=path&path=a.b&when=sideways`)).toEqual({
      kind: 'add',
      from: 'path',
      path: 'a.b'
    })
    expect(parseRoute(`${ADMIN}#add=path&when=below`)).toEqual({ kind: 'add', from: 'path' })
  })

  it('reads Add rule from an unknown starting point as the list', () => {
    expect(parseRoute(`${ADMIN}#add=elsewhere`)).toEqual({ kind: 'list' })
  })

  it('reads a fragment it does not know as the list', () => {
    expect(parseRoute(`${ADMIN}#rules`)).toEqual({ kind: 'list' })
    expect(parseRoute(`${ADMIN}#address=1`)).toEqual({ kind: 'list' })
  })
})

describe('hashWithRoute', () => {
  it('appends the route to the admin UI route', () => {
    expect(hashWithRoute(ADMIN, { kind: 'rule', slug: 'a' })).toBe(`${ADMIN}#rule=a`)
  })

  it('replaces a route already there', () => {
    expect(hashWithRoute(`${ADMIN}#rule=a`, { kind: 'rule', slug: 'b' })).toBe(`${ADMIN}#rule=b`)
    expect(hashWithRoute(`${ADMIN}#add=path`, { kind: 'edit', slug: 'b' })).toBe(`${ADMIN}#edit=b`)
  })

  it('escapes every part', () => {
    expect(hashWithRoute(ADMIN, { kind: 'rule', slug: 'a/b', instance: 'a&b' })).toBe(
      `${ADMIN}#rule=a%2Fb&instance=a%26b`
    )
  })

  it('drops the route for the list, keeping the admin UI route', () => {
    expect(hashWithRoute(`${ADMIN}#rule=a`, { kind: 'list' })).toBe(ADMIN)
  })

  it('keeps a link to this page when there is no route to keep', () => {
    expect(hashWithRoute('#rule=a', { kind: 'list' })).toBe('#')
    expect(hashWithRoute('', { kind: 'rule', slug: 'a' })).toBe('#rule=a')
  })

  it.each<Route>([
    { kind: 'list' },
    { kind: 'rule', slug: 'a b', instance: 'c/d' },
    { kind: 'edit', slug: 'x' },
    { kind: 'add' },
    { kind: 'add', from: 'path' },
    { kind: 'add', from: 'template' },
    { kind: 'add', from: 'path', path: 'a.*.b c' },
    { kind: 'add', from: 'path', path: 'a.b', when: 'often' }
  ])('reads back what it writes: %o', (route) => {
    expect(parseRoute(hashWithRoute(ADMIN, route))).toEqual(route)
  })
})
