import { LevelRefusedError, SessionExpiredError, type PanelApi, type PluginState } from './api'

/**
 * The api with each write's refusal told apart. Signal K answers 401 both to
 * a login that expired and to one whose level does not reach the route, so a
 * refused write reads `/state` again. If that fails too, the login expired.
 * If it answers, the refusal carries the level it answered with (see
 * LevelRefusedError for why `readonly` stays ambiguous), and `onLevelRefused`
 * re-reads the level so the views drop the controls it no longer allows.
 */
export function withRefusals(
  api: PanelApi,
  onLevelRefused: (refusal: LevelRefusedError) => void
): PanelApi {
  const refusal = async <T>(write: () => Promise<T>): Promise<T> => {
    try {
      return await write()
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err
      let state: PluginState
      try {
        state = await api.state()
      } catch {
        throw err
      }
      const refused = new LevelRefusedError(state.permissions)
      onLevelRefused(refused)
      throw refused
    }
  }
  return {
    ...api,
    resetAccumulator: (slug) => refusal(() => api.resetAccumulator(slug)),
    createRule: (rule) => refusal(() => api.createRule(rule)),
    updateRule: (slug, rule) => refusal(() => api.updateRule(slug, rule)),
    previewRule: (slug, rule) => refusal(() => api.previewRule(slug, rule)),
    disableRule: (slug, note) => refusal(() => api.disableRule(slug, note)),
    enableRule: (slug) => refusal(() => api.enableRule(slug)),
    deleteRule: (slug) => refusal(() => api.deleteRule(slug))
  }
}
