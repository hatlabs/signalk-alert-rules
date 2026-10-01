import { describe, it, expect } from 'vitest'
import { deltaPath, parseAlertPath } from '../../src/alerts/paths.js'
import { alertPathFor } from '../../src/model/validate.js'

describe('alert paths', () => {
  it('parses a rule alert path with and without an instance', () => {
    expect(parseAlertPath('rules.oil-pressure-low')).toEqual({
      slug: 'oil-pressure-low'
    })
    expect(parseAlertPath('rules.coolant-high.port')).toEqual({
      slug: 'coolant-high',
      segment: 'port'
    })
  })

  it('parses what alertPathFor builds', () => {
    const built = alertPathFor('coolant-high', 'port')
    expect(built.ok && parseAlertPath(built.value)).toEqual({
      slug: 'coolant-high',
      segment: 'port'
    })
  })

  it('rejects paths outside the reserved prefix or of the wrong length', () => {
    for (const path of ['notifications.x.y', 'rules', 'rules.a.b.c', 'rulesx.a']) {
      expect(parseAlertPath(path)).toBeUndefined()
    }
  })

  it('puts the alerts prefix on the delta path', () => {
    expect(deltaPath('rules.a')).toBe('alerts.rules.a')
  })
})
