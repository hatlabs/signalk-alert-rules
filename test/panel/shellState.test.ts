import { describe, expect, it } from 'vitest'
import {
  SessionExpiredError,
  type PanelApi,
  type PluginState,
  type RuleEntry
} from '../../src/panel/api'
import {
  DISABLED_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  pollDelay,
  probe
} from '../../src/panel/shellState'
import { ruleEntry } from './fixtures'

interface FakeServer {
  state?: PluginState | Error
  enabled?: boolean | Error
  rules?: RuleEntry[] | Error
}

function fakeApi(server: FakeServer): PanelApi {
  const answer = <T>(value: T | Error | undefined): Promise<T> => {
    if (value === undefined) return Promise.reject(new Error('not expected to be asked'))
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  }
  return {
    state: () => answer(server.state),
    pluginEnabled: () => answer(server.enabled),
    rules: () => answer(server.rules),
    resetAccumulator: () => Promise.reject(new Error('not expected to be asked')),
    setEvaluation: () => Promise.reject(new Error('not expected to be asked'))
  }
}

const rule = ruleEntry()

describe('probe', () => {
  it('is ready with the rules and the evaluation switch while the plugin runs', async () => {
    const state = { running: true, securityEnabled: true, evaluation: { enabled: false } }
    const snapshot = await probe(fakeApi({ state, rules: [rule] }))
    expect(snapshot).toEqual({
      view: { kind: 'ready', rules: [rule], evaluationEnabled: false, issues: [] },
      securityEnabled: true
    })
  })

  it('carries the problems found while loading into the ready view', async () => {
    const issues = ['stored rule broken is not valid and does not run: /signal: required']
    const state = { running: true, securityEnabled: true, evaluation: { enabled: true }, issues }
    const snapshot = await probe(fakeApi({ state, rules: [] }))
    expect(snapshot.view).toEqual({ kind: 'ready', rules: [], evaluationEnabled: true, issues })
  })

  it('is unreachable when /state cannot be fetched', async () => {
    const snapshot = await probe(fakeApi({ state: new Error('Failed to fetch') }))
    expect(snapshot).toEqual({
      view: { kind: 'unreachable', reason: 'Failed to fetch' },
      securityEnabled: null
    })
  })

  it('is disabled when the server has the plugin switched off', async () => {
    const snapshot = await probe(
      fakeApi({ state: { running: false, securityEnabled: false }, enabled: false })
    )
    expect(snapshot).toEqual({ view: { kind: 'disabled' }, securityEnabled: false })
  })

  it('is disabled rather than failed when a disabled plugin still reports a start error', async () => {
    const snapshot = await probe(
      fakeApi({ state: { running: false, error: 'old', securityEnabled: true }, enabled: false })
    )
    expect(snapshot.view).toEqual({ kind: 'disabled' })
  })

  it('is failed with the start error when an enabled plugin did not start', async () => {
    const error = 'the server has no alerts API'
    const snapshot = await probe(
      fakeApi({ state: { running: false, error, securityEnabled: true }, enabled: true })
    )
    expect(snapshot.view).toEqual({ kind: 'failed', error })
  })

  it('is restarting when an enabled plugin is not running and reports no error', async () => {
    const snapshot = await probe(
      fakeApi({ state: { running: false, securityEnabled: true }, enabled: true })
    )
    expect(snapshot.view).toEqual({ kind: 'restarting' })
  })

  it('is session expired when the server refuses the session', async () => {
    const snapshot = await probe(fakeApi({ state: new SessionExpiredError() }))
    expect(snapshot).toEqual({ view: { kind: 'sessionExpired' }, securityEnabled: null })
  })

  it('is session expired when a later request is refused', async () => {
    const snapshot = await probe(
      fakeApi({
        state: { running: false, securityEnabled: true },
        enabled: new SessionExpiredError()
      })
    )
    expect(snapshot.view).toEqual({ kind: 'sessionExpired' })
  })

  it('keeps the security state when a later request fails', async () => {
    const snapshot = await probe(
      fakeApi({ state: { running: true, securityEnabled: false }, rules: new Error('503') })
    )
    expect(snapshot).toEqual({
      view: { kind: 'unreachable', reason: '503' },
      securityEnabled: false
    })
  })
})

describe('pollDelay', () => {
  it('polls a disabled plugin slowly and every other view at the normal interval', () => {
    expect(pollDelay({ kind: 'disabled' })).toBe(DISABLED_POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'loading' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'restarting' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'unreachable', reason: 'x' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'failed', error: 'x' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'ready', rules: [], evaluationEnabled: true, issues: [] })).toBe(
      POLL_INTERVAL_MS
    )
  })

  it('stops polling once the session has expired', () => {
    expect(pollDelay({ kind: 'sessionExpired' })).toBeNull()
  })
})
