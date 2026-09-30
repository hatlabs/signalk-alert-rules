import { describe, expect, it } from 'vitest'
import type { Rule } from '../../src/model/rule.js'
import { PathPresence, rulePaths } from '../../src/rulesets/presence.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

const detector = {
  type: 'sustained',
  direction: 'above',
  limit: { kind: 'fixed', value: 1 }
} as const

function rule(fields: Partial<Rule>): Rule {
  return {
    name: 'R',
    slug: 'r',
    message: 'm',
    priority: 'warning',
    signal: { path: 'a.b' },
    detector,
    ...fields
  }
}

describe('rulePaths', () => {
  it('lists the detector, combinator and gate inputs once each', () => {
    const paths = rulePaths(
      rule({
        signal: { combinator: 'difference', inputs: [{ path: 'a.x' }, { path: 'a.y' }] },
        gates: [
          { signal: { path: 'a.x' }, ...detector },
          { signal: { path: 'b.*.z' }, ...detector }
        ]
      })
    )
    expect(paths).toEqual(['a.x', 'a.y', 'b.*.z'])
  })
})

describe('PathPresence', () => {
  it('counts a path the server already has, and one that arrives later', () => {
    const subscriptions = new FakeSubscriptionManager()
    subscriptions.publish('a.b', 'src', 1)
    const presence = new PathPresence(subscriptions)

    presence.watch(['a.b', 'a.c'])
    expect(presence.has('a.b')).toBe(true)
    expect(presence.has('a.c')).toBe(false)

    subscriptions.publish('a.c', 'other', null)
    expect(presence.has('a.c')).toBe(true)
  })

  it('counts a wildcard pattern once one path matches it in exactly one segment', () => {
    const subscriptions = new FakeSubscriptionManager()
    const presence = new PathPresence(subscriptions)
    presence.watch(['b.*.z'])

    subscriptions.publish('b.one.two.z', 'src', 1)
    expect(presence.has('b.*.z')).toBe(false)
    subscriptions.publish('b.one.z', 'src', 1)
    expect(presence.has('b.*.z')).toBe(true)
  })

  it('stops watching seen paths when pruned, and everything when stopped', () => {
    const subscriptions = new FakeSubscriptionManager()
    const presence = new PathPresence(subscriptions)
    presence.watch(['a.b', 'a.c'])
    presence.watch(['a.b'])
    expect(subscriptions.activeSubscriptions).toBe(2)

    subscriptions.publish('a.b', 'src', 1)
    presence.prune()
    expect(subscriptions.activeSubscriptions).toBe(1)

    presence.stop()
    expect(subscriptions.activeSubscriptions).toBe(0)
    expect(presence.has('a.b')).toBe(true)
  })
})
