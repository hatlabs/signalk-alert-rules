import { describe, it, expect } from 'vitest'
import type { CoreAlert } from '../../src/alerts/emitter.js'
import { reconcile } from '../../src/alerts/reconcile.js'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'

const PLUGIN = 'signalk-alert-rules'

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

const single = valid({
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Oil pressure is low',
  priority: 'alarm',
  signal: { path: 'propulsion.main.oilPressure' },
  detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 100000 } }
})
const wildcard = valid({
  ...single,
  slug: 'coolant-high',
  signal: { path: 'propulsion.*.coolantTemperature' },
  detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } }
})

function alert(path: string, condition = true, source = PLUGIN): CoreAlert {
  return {
    path,
    $source: source,
    priority: 'alarm',
    message: 'm',
    latching: false,
    condition,
    stale: false
  }
}

describe('reconcile', () => {
  const rules = new Map([
    ['user.oil-pressure-low', single],
    ['user.coolant-high', wildcard]
  ])

  it('keeps the alerts of existing rules and instances, and starts active ones condition-active', () => {
    const result = reconcile(
      [alert('rules.user.oil-pressure-low'), alert('rules.user.coolant-high.port')],
      PLUGIN,
      rules
    )
    expect(result.toClear).toEqual([])
    expect(result.kept.map((k) => [k.alert.path, k.ruleId, k.segment])).toEqual([
      ['rules.user.oil-pressure-low', 'user.oil-pressure-low', undefined],
      ['rules.user.coolant-high.port', 'user.coolant-high', 'port']
    ])
    expect(result.activeByRule.get('user.oil-pressure-low')).toEqual([{}])
    expect(result.activeByRule.get('user.coolant-high')).toEqual([{ segment: 'port' }])
  })

  it('ignores alerts whose condition has ended, even when their rule is gone', () => {
    const result = reconcile(
      [alert('rules.user.oil-pressure-low', false), alert('rules.user.deleted-rule', false)],
      PLUGIN,
      rules
    )
    expect(result).toEqual({ kept: [], activeByRule: new Map(), toClear: [] })
  })

  it('clears alerts whose rule is gone or whose instance cannot belong to the rule', () => {
    const result = reconcile(
      [
        alert('rules.user.deleted-rule'),
        alert('rules.user.oil-pressure-low.port'),
        alert('rules.user.coolant-high'),
        alert('rules.some-ruleset.oil-pressure-low')
      ],
      PLUGIN,
      rules
    )
    expect(result.toClear.map((a) => a.path)).toEqual([
      'rules.user.deleted-rule',
      'rules.user.oil-pressure-low.port',
      'rules.user.coolant-high',
      'rules.some-ruleset.oil-pressure-low'
    ])
    expect(result.kept).toEqual([])
  })

  it('clears an active alert of a latching rule, which holds none, and starts the rule afresh', () => {
    const result = reconcile(
      [alert('rules.user.oil-pressure-low')],
      PLUGIN,
      new Map([['user.oil-pressure-low', { ...single, latching: true }]])
    )
    expect(result.toClear.map((a) => a.path)).toEqual(['rules.user.oil-pressure-low'])
    expect(result.kept).toEqual([])
    expect(result.activeByRule.size).toBe(0)
  })

  it("ignores other sources' alerts and paths outside SKAR's prefix", () => {
    const result = reconcile(
      [alert('rules.user.oil-pressure-low', true, 'other-plugin'), alert('notifications.x.y')],
      PLUGIN,
      rules
    )
    expect(result).toEqual({ kept: [], activeByRule: new Map(), toClear: [] })
  })
})
