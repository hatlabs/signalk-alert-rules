import { describe, expect, it } from 'vitest'
import {
  SessionExpiredError,
  type ListedRule,
  type PanelApi,
  type PluginState
} from '../../src/panel/api'
import {
  POLL_INTERVAL_MS,
  pollDelay,
  probe,
  shownReady,
  viewMessage,
  type ReadyView
} from '../../src/panel/shellState'
import { invalidEntry, noAuthoring, noControls, ruleEntry } from './fixtures'

interface FakeServer {
  state?: PluginState | Error
  rules?: ListedRule[] | Error
}

function fakeApi(server: FakeServer): PanelApi {
  const answer = <T>(value: T | Error | undefined): Promise<T> => {
    if (value === undefined) return Promise.reject(new Error('not expected to be asked'))
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  }
  return {
    state: () => answer(server.state),
    rules: () => answer(server.rules),
    resetAccumulator: () => Promise.reject(new Error('not expected to be asked')),
    ...noAuthoring,
    ...noControls
  }
}

const rule = ruleEntry()
const READ_AT = Date.parse('2026-09-30T12:04:00.000Z')
const clock = () => READ_AT
const running: PluginState = { running: true, securityEnabled: true, permissions: 'admin' }
const ready = (rules: ListedRule[] = [], issues: string[] = []): ReadyView => ({
  kind: 'ready',
  rules,
  issues,
  permissions: 'admin',
  readAt: READ_AT
})

describe('probe', () => {
  it("is ready with the rules, the caller's level and the read time while the plugin runs", async () => {
    const invalid = invalidEntry()
    const snapshot = await probe(fakeApi({ state: running, rules: [rule, invalid] }), clock)
    expect(snapshot).toEqual({ view: ready([rule, invalid]), securityEnabled: true })
  })

  it.each(['readonly', 'readwrite'] as const)('carries the %s level', async (permissions) => {
    const snapshot = await probe(fakeApi({ state: { ...running, permissions }, rules: [] }), clock)
    expect(snapshot.view).toEqual({ ...ready(), permissions })
  })

  it('carries the problems found while loading into the ready view', async () => {
    const issues = ['stored rule broken is not valid and does not run: /signal: required']
    const snapshot = await probe(fakeApi({ state: { ...running, issues }, rules: [] }), clock)
    expect(snapshot.view).toEqual(ready([], issues))
  })

  it('is unreachable when /state cannot be fetched', async () => {
    const snapshot = await probe(fakeApi({ state: new Error('Failed to fetch') }))
    expect(snapshot).toEqual({
      view: { kind: 'unreachable', reason: 'Failed to fetch' },
      securityEnabled: null
    })
  })

  it('is failed with the start error when the plugin did not start', async () => {
    const error = 'the server has no alerts API'
    const snapshot = await probe(
      fakeApi({ state: { running: false, error, securityEnabled: true, permissions: 'admin' } })
    )
    expect(snapshot.view).toEqual({ kind: 'failed', error })
  })

  // A disabled plugin and one between the stop and start of a restart look
  // alike, so both read as not running.
  it('is not running when the plugin is not running and reports no error', async () => {
    const snapshot = await probe(
      fakeApi({ state: { running: false, securityEnabled: false, permissions: 'admin' } })
    )
    expect(snapshot).toEqual({ view: { kind: 'notRunning' }, securityEnabled: false })
  })

  it('is session expired when the server refuses the session', async () => {
    const snapshot = await probe(fakeApi({ state: new SessionExpiredError() }))
    expect(snapshot).toEqual({ view: { kind: 'sessionExpired' }, securityEnabled: null })
  })

  it('is session expired when a later request is refused', async () => {
    const snapshot = await probe(fakeApi({ state: running, rules: new SessionExpiredError() }))
    expect(snapshot.view).toEqual({ kind: 'sessionExpired' })
  })

  it('keeps the security state when a later request fails', async () => {
    const snapshot = await probe(
      fakeApi({ state: { ...running, securityEnabled: false }, rules: new Error('503') })
    )
    expect(snapshot).toEqual({
      view: { kind: 'unreachable', reason: '503' },
      securityEnabled: false
    })
  })
})

describe('pollDelay', () => {
  it('polls every view but an expired session at the normal interval', () => {
    expect(pollDelay({ kind: 'loading' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'notRunning' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'unreachable', reason: 'x' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay({ kind: 'failed', error: 'x' })).toBe(POLL_INTERVAL_MS)
    expect(pollDelay(ready())).toBe(POLL_INTERVAL_MS)
  })

  it('stops polling once the session has expired', () => {
    expect(pollDelay({ kind: 'sessionExpired' })).toBeNull()
  })
})

describe('shownReady', () => {
  const last = ready([rule])

  it('shows a ready view as it is', () => {
    const now: ReadyView = { ...last, rules: [] }
    expect(shownReady(now, last)).toBe(now)
  })

  it('keeps the last ready view while the plugin is unreachable or not running, or the session expired', () => {
    expect(shownReady({ kind: 'unreachable', reason: 'x' }, last)).toBe(last)
    expect(shownReady({ kind: 'notRunning' }, last)).toBe(last)
    expect(shownReady({ kind: 'sessionExpired' }, last)).toBe(last)
  })

  it('drops it once the plugin failed', () => {
    expect(shownReady({ kind: 'failed', error: 'x' }, last)).toBeUndefined()
  })
})

describe('viewMessage', () => {
  it('says what each view other than a ready one means', () => {
    expect(viewMessage({ kind: 'loading' })).toBe('Loading…')
    expect(viewMessage({ kind: 'unreachable', reason: 'Failed to fetch' })).toBe(
      'Reconnecting to the plugin (Failed to fetch).'
    )
    expect(viewMessage({ kind: 'notRunning' })).toMatch(/not running\. retrying/i)
    expect(viewMessage({ kind: 'sessionExpired' })).toMatch(/your login has expired/i)
    expect(viewMessage({ kind: 'failed', error: 'no alerts API' })).toMatch(
      /could not start: no alerts API\. rules cannot be edited/i
    )
    expect(viewMessage(ready())).toBeUndefined()
  })
})
