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
  signal: { path: 'propulsion.main.oilPressure' },
  detector: { type: 'sustained', direction: 'below', steps: [{ limit: 100000, priority: 'alarm' }] }
})
const wildcard = valid({
  ...single,
  slug: 'coolant-high',
  signal: { path: 'propulsion.*.coolantTemperature' },
  detector: { type: 'sustained', direction: 'above', steps: [{ limit: 368, priority: 'alarm' }] }
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

const OIL = 'propulsion.main.oilPressureLow'
const PORT = 'propulsion.port.coolantTemperatureHigh'

describe('reconcile', () => {
  const rules = new Map([
    ['oil-pressure-low', single],
    ['coolant-high', wildcard]
  ])

  it("adopts SKAR's active alerts by source and alert path, with a wildcard rule's instance", () => {
    const result = reconcile([alert(OIL), alert(PORT)], PLUGIN, rules)
    expect(result.toClear).toEqual([])
    expect(result.kept.map((k) => [k.alert.path, k.slug, k.segment])).toEqual([
      [OIL, 'oil-pressure-low', undefined],
      [PORT, 'coolant-high', 'port']
    ])
    expect(result.activeByRule.get('oil-pressure-low')).toEqual([{ priority: 'alarm' }])
    expect(result.activeByRule.get('coolant-high')).toEqual([
      { segment: 'port', priority: 'alarm' }
    ])
  })

  it("matches by the alert path of the rule's condition name", () => {
    const named = { ...single, condition: 'lubricationFailed' }
    const result = reconcile(
      [alert('propulsion.main.lubricationFailed')],
      PLUGIN,
      new Map([['oil-pressure-low', named]])
    )
    expect(result.kept.map((k) => k.slug)).toEqual(['oil-pressure-low'])
  })

  it('ignores alerts whose condition has ended, even when their rule is gone', () => {
    const result = reconcile(
      [alert(OIL, false), alert('electrical.batteries.house.voltageLow', false)],
      PLUGIN,
      rules
    )
    expect(result).toEqual({ kept: [], activeByRule: new Map(), toClear: [] })
  })

  it("clears SKAR's alerts at paths no rule has, as orphans", () => {
    const orphans = [
      'electrical.batteries.house.voltageLow',
      `${OIL}.port`,
      'propulsion.coolantTemperatureHigh',
      'rules.oil-pressure-low'
    ]
    const result = reconcile(
      orphans.map((path) => alert(path)),
      PLUGIN,
      rules
    )
    expect(result.toClear.map((a) => a.path)).toEqual(orphans)
    expect(result.kept).toEqual([])
  })

  it('clears an active alert of a latching rule, which holds none, and starts the rule afresh', () => {
    const result = reconcile(
      [alert(OIL)],
      PLUGIN,
      new Map([['oil-pressure-low', { ...single, latching: true }]])
    )
    expect(result.toClear.map((a) => a.path)).toEqual([OIL])
    expect(result.kept).toEqual([])
    expect(result.activeByRule.size).toBe(0)
  })

  it("leaves another source's alert at a rule's path, and any other source's alert, untouched", () => {
    const result = reconcile(
      [alert(OIL, true, 'other-plugin'), alert(PORT, true, 'n2k-1'), alert('a.b', true, 'x')],
      PLUGIN,
      rules
    )
    expect(result).toEqual({ kept: [], activeByRule: new Map(), toClear: [] })
  })
})
