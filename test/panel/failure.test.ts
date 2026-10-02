import { describe, expect, it } from 'vitest'
import { LevelRefusedError, RuleRejectedError, SessionExpiredError } from '../../src/panel/api'
import { failureMessage, fieldErrorText } from '../../src/panel/failure'

describe('failureMessage', () => {
  it('says an expired login needs logging in again, not more rights', () => {
    const message = failureMessage(new SessionExpiredError())
    expect(message).toMatch(/your login has expired/i)
    expect(message).not.toMatch(/administrator/i)
  })

  it('says an action refused to a read/write login needs an administrator, not a new login', () => {
    const message = failureMessage(new LevelRefusedError('readwrite'))
    expect(message).toMatch(/needs an administrator/i)
    expect(message).not.toMatch(/log in again/i)
  })

  // Where the server lets anyone read, an expired login reads as read-only.
  it('offers both a new login and an administrator for an action refused to a read-only login', () => {
    expect(failureMessage(new LevelRefusedError('readonly'))).toBe(
      'Log in again, or ask an administrator: this action needs more rights than your login has.'
    )
  })

  it('names the fields of a refused rule', () => {
    const err = new RuleRejectedError('invalid rule', [{ path: '/name', message: 'is required' }])
    expect(failureMessage(err)).toBe('invalid rule: name is required')
  })

  it('names a field by its path, or not at all for the whole rule', () => {
    expect(fieldErrorText({ path: '/signal/path', message: 'is required' })).toBe(
      'signal/path is required'
    )
    expect(fieldErrorText({ path: '', message: 'must be an object' })).toBe('must be an object')
  })

  it('passes on any other error message', () => {
    expect(failureMessage(new Error('disk full'))).toBe('disk full')
  })
})
