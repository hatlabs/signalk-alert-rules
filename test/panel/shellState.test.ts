import { describe, expect, it } from 'vitest'
import type { PanelApi, PluginState, RuleSummary } from '../../src/panel/api'
import { probe, keepsPolling } from '../../src/panel/shellState'

interface FakeServer {
  state?: PluginState | Error
  enabled?: boolean | Error
  rules?: RuleSummary[] | Error
}

function fakeApi(server: FakeServer): PanelApi {
  const answer = <T>(value: T | Error | undefined): Promise<T> => {
    if (value === undefined) return Promise.reject(new Error('not expected to be asked'))
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  }
  return {
    state: () => answer(server.state),
    pluginEnabled: () => answer(server.enabled),
    rules: () => answer(server.rules)
  }
}

const rule: RuleSummary = { origin: 'user', slug: 'oil-pressure-low' }

describe('probe', () => {
  it('is ready with the rule count while the plugin runs', async () => {
    const snapshot = await probe(
      fakeApi({ state: { running: true, securityEnabled: true }, rules: [rule] })
    )
    expect(snapshot).toEqual({ view: { kind: 'ready', ruleCount: 1 }, securityEnabled: true })
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

describe('keepsPolling', () => {
  it('stops only for a disabled plugin', () => {
    expect(keepsPolling({ kind: 'disabled' })).toBe(false)
    expect(keepsPolling({ kind: 'loading' })).toBe(true)
    expect(keepsPolling({ kind: 'restarting' })).toBe(true)
    expect(keepsPolling({ kind: 'unreachable', reason: 'x' })).toBe(true)
    expect(keepsPolling({ kind: 'failed', error: 'x' })).toBe(true)
    expect(keepsPolling({ kind: 'ready', ruleCount: 0 })).toBe(true)
  })
})
