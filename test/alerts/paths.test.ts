import { describe, it, expect } from 'vitest'
import { deltaPath, parseAlertPath, ruleId } from '../../src/alerts/paths.js'
import { alertPathFor } from '../../src/model/validate.js'

describe('alert paths', () => {
  it('parses a rule alert path with and without an instance', () => {
    expect(parseAlertPath('rules.user.oil-pressure-low')).toEqual({
      ruleId: 'user.oil-pressure-low'
    })
    expect(parseAlertPath('rules.signalk-halpi.coolant-high.port')).toEqual({
      ruleId: 'signalk-halpi.coolant-high',
      segment: 'port'
    })
  })

  it('parses what alertPathFor builds', () => {
    const built = alertPathFor('user', 'coolant-high', 'port')
    expect(built.ok && parseAlertPath(built.value)).toEqual({
      ruleId: ruleId('user', 'coolant-high'),
      segment: 'port'
    })
  })

  it('rejects paths outside the reserved prefix or of the wrong length', () => {
    for (const path of ['notifications.x.y', 'rules.user', 'rules.user.a.b.c', 'rulesx.user.a']) {
      expect(parseAlertPath(path)).toBeUndefined()
    }
  })

  it('puts the alerts prefix on the delta path', () => {
    expect(deltaPath('rules.user.a')).toBe('alerts.rules.user.a')
  })
})
