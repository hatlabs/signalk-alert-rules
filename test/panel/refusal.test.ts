import { describe, expect, it, vi } from 'vitest'
import {
  LevelRefusedError,
  SessionExpiredError,
  type PanelApi,
  type PluginState
} from '../../src/panel/api'
import { withRefusals } from '../../src/panel/refusal'
import { noAuthoring, ruleEntry } from './fixtures'

const readonly: PluginState = { running: true, securityEnabled: true, permissions: 'readonly' }

function api(state: () => Promise<PluginState>, disable: PanelApi['disableRule']): PanelApi {
  return {
    state,
    rules: () => Promise.resolve([]),
    resetAccumulator: () => Promise.reject(new SessionExpiredError()),
    ...noAuthoring,
    disableRule: disable,
    enableRule: () => Promise.resolve(ruleEntry())
  }
}

const refused = () => Promise.reject(new SessionExpiredError())

describe('withRefusals', () => {
  it('passes a write that succeeds through, without reading the state', async () => {
    const state = vi.fn(() => Promise.resolve(readonly))
    const onLevelRefused = vi.fn()
    const entry = ruleEntry()
    const wrapped = withRefusals(
      api(state, () => Promise.resolve(entry)),
      onLevelRefused
    )
    await expect(wrapped.disableRule('x', '')).resolves.toBe(entry)
    expect(state).not.toHaveBeenCalled()
    expect(onLevelRefused).not.toHaveBeenCalled()
  })

  it.each(['readonly', 'readwrite'] as const)(
    'reads a refusal as a level refusal carrying the %s level the state still answers',
    async (permissions) => {
      const onLevelRefused = vi.fn()
      const wrapped = withRefusals(
        api(() => Promise.resolve({ ...readonly, permissions }), refused),
        onLevelRefused
      )
      await expect(wrapped.disableRule('x', '')).rejects.toMatchObject({
        name: 'LevelRefusedError',
        permissions
      })
      await expect(wrapped.resetAccumulator('x')).rejects.toBeInstanceOf(LevelRefusedError)
      expect(onLevelRefused).toHaveBeenCalledTimes(2)
      expect(onLevelRefused).toHaveBeenCalledWith(expect.objectContaining({ permissions }))
    }
  )

  it.each([
    ['refused too', new SessionExpiredError()],
    ['not answered in time', new Error('the request timed out')]
  ])('reads a refusal as an expired login when the state is %s', async (_, failure) => {
    const onLevelRefused = vi.fn()
    const wrapped = withRefusals(
      api(() => Promise.reject(failure), refused),
      onLevelRefused
    )
    await expect(wrapped.disableRule('x', '')).rejects.toBeInstanceOf(SessionExpiredError)
    expect(onLevelRefused).not.toHaveBeenCalled()
  })

  it('passes other failures through as they are', async () => {
    const state = vi.fn(() => Promise.resolve(readonly))
    const wrapped = withRefusals(
      api(state, () => Promise.reject(new Error('503'))),
      vi.fn()
    )
    await expect(wrapped.disableRule('x', '')).rejects.toThrow('503')
    expect(state).not.toHaveBeenCalled()
  })
})
