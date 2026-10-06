import { describe, it, expect } from 'vitest'
import { MAX_REFERENCES, referencesOf } from '../../src/alerts/references.js'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

const base = {
  name: 'r',
  slug: 'r',
  message: 'm',
  detector: { type: 'sustained', direction: 'above', steps: [{ limit: 1, priority: 'warning' }] }
}

describe('referencesOf', () => {
  it("is the rule's input path", () => {
    expect(referencesOf(valid({ ...base, signal: { path: 'a.b.c' } }))).toEqual(['a.b.c'])
  })

  it("puts an instance's name in place of the wildcard, in the input and the gates", () => {
    const rule = valid({
      ...base,
      signal: { path: 'propulsion.*.coolantTemperature' },
      gates: [
        {
          signal: { path: 'propulsion.*.revolutions' },
          direction: 'above',
          limit: { kind: 'zone', level: 'warn', path: 'propulsion.*.revolutions' }
        },
        {
          signal: { path: 'environment.outside.temperature' },
          direction: 'below',
          limit: { kind: 'fixed', value: 300 }
        }
      ]
    })
    expect(referencesOf(rule, 'port')).toEqual([
      'propulsion.port.coolantTemperature',
      'propulsion.port.revolutions',
      'environment.outside.temperature'
    ])
  })

  it("names every input of a combined signal and the zone limit's own path", () => {
    const rule = valid({
      ...base,
      condition: 'diverge',
      signal: {
        combinator: 'difference',
        inputs: [
          { path: 'electrical.batteries.house.voltage' },
          { path: 'electrical.batteries.start.voltage' }
        ]
      },
      detector: {
        type: 'sustained',
        direction: 'above',
        limit: { kind: 'zone', level: 'warn', path: 'electrical.batteries.bank.voltage' }
      }
    })
    expect(referencesOf(rule)).toEqual([
      'electrical.batteries.house.voltage',
      'electrical.batteries.start.voltage',
      'electrical.batteries.bank.voltage'
    ])
  })

  it("names a projection's zone limit path after its input, for the instance", () => {
    const rule = valid({
      ...base,
      signal: { path: 'tanks.fuel.*.currentLevel' },
      detector: {
        type: 'projection',
        direction: 'falling',
        limit: { kind: 'zone', level: 'alarm', path: 'tanks.fuel.*.reserveLevel' },
        window: 600,
        horizon: 3600
      }
    })
    expect(referencesOf(rule, 'port')).toEqual([
      'tanks.fuel.port.currentLevel',
      'tanks.fuel.port.reserveLevel'
    ])
  })

  it("names a field's base path, once for fields of the same path, for the instance", () => {
    const combined = valid({
      ...base,
      condition: 'apart',
      signal: {
        combinator: 'difference',
        inputs: [{ path: 'navigation.attitude#/roll' }, { path: 'navigation.attitude#/pitch' }]
      }
    })
    expect(referencesOf(combined)).toEqual(['navigation.attitude'])
    const wildcard = valid({
      ...base,
      signal: { path: 'electrical.batteries.*#/voltage' },
      gates: [
        {
          signal: { path: 'electrical.batteries.*.current' },
          direction: 'above',
          limit: { kind: 'fixed', value: 0 }
        }
      ]
    })
    expect(referencesOf(wildcard, 'house')).toEqual([
      'electrical.batteries.house',
      'electrical.batteries.house.current'
    ])
  })

  it('leaves out a path core would refuse, which would otherwise lose every reference', () => {
    const rule = valid({ ...base, signal: { path: 'electrical.batteries.*.voltage' } })
    expect(referencesOf(rule, 'house bank')).toEqual([])
  })

  it('keeps the first paths, signal first, within the most core accepts', () => {
    const inputs = (g: number) =>
      Array.from({ length: 16 }, (_, i) => ({ path: `g${String(g)}.p${String(i)}.value` }))
    const rule = valid({
      ...base,
      condition: 'inputsHigh',
      signal: { combinator: 'mean', inputs: inputs(0) },
      gates: Array.from({ length: 8 }, (_, g) => ({
        signal: { combinator: 'mean', inputs: inputs(g + 1) },
        direction: 'above',
        limit: { kind: 'fixed', value: 0 }
      }))
    })
    const references = referencesOf(rule)
    expect(MAX_REFERENCES).toBe(50)
    expect(references).toHaveLength(MAX_REFERENCES)
    expect(references[0]).toBe('g0.p0.value')
    expect(references.at(-1)).toBe('g3.p1.value')
  })
})
