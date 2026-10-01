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
    ['oil-pressure-low', single],
    ['coolant-high', wildcard]
  ])

  it('keeps the alerts of existing rules and instances, and starts active ones condition-active', () => {
    const result = reconcile(
      [alert('rules.oil-pressure-low'), alert('rules.coolant-high.port')],
      PLUGIN,
      rules
    )
    expect(result.toClear).toEqual([])
    expect(result.kept.map((k) => [k.alert.path, k.slug, k.segment])).toEqual([
      ['rules.oil-pressure-low', 'oil-pressure-low', undefined],
      ['rules.coolant-high.port', 'coolant-high', 'port']
    ])
    expect(result.activeByRule.get('oil-pressure-low')).toEqual([{}])
    expect(result.activeByRule.get('coolant-high')).toEqual([{ segment: 'port' }])
  })

  it('ignores alerts whose condition has ended, even when their rule is gone', () => {
    const result = reconcile(
      [alert('rules.oil-pressure-low', false), alert('rules.deleted-rule', false)],
      PLUGIN,
      rules
    )
    expect(result).toEqual({ kept: [], activeByRule: new Map(), toClear: [] })
  })

  it('clears alerts whose rule is gone or whose instance cannot belong to the rule', () => {
    const result = reconcile(
      [
        alert('rules.deleted-rule'),
        alert('rules.oil-pressure-low.port'),
        alert('rules.coolant-high'),
        alert('rules.user.oil-pressure-low')
      ],
      PLUGIN,
      rules
    )
    expect(result.toClear.map((a) => a.path)).toEqual([
      'rules.deleted-rule',
      'rules.oil-pressure-low.port',
      'rules.coolant-high',
      'rules.user.oil-pressure-low'
    ])
    expect(result.kept).toEqual([])
  })

  it('clears an active alert of a latching rule, which holds none, and starts the rule afresh', () => {
    const result = reconcile(
      [alert('rules.oil-pressure-low')],
      PLUGIN,
      new Map([['oil-pressure-low', { ...single, latching: true }]])
    )
    expect(result.toClear.map((a) => a.path)).toEqual(['rules.oil-pressure-low'])
    expect(result.kept).toEqual([])
    expect(result.activeByRule.size).toBe(0)
  })

  it("ignores other sources' alerts and paths outside SKAR's prefix", () => {
    const result = reconcile(
      [alert('rules.oil-pressure-low', true, 'other-plugin'), alert('notifications.x.y')],
      PLUGIN,
      rules
    )
    expect(result).toEqual({ kept: [], activeByRule: new Map(), toClear: [] })
  })
})
