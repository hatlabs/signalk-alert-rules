import type { PanelApi } from './api'

/** What the shell shows in place of, or around, the views. */
export type ShellView =
  | { kind: 'loading' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'restarting' }
  | { kind: 'disabled' }
  | { kind: 'failed'; error: string }
  | { kind: 'ready'; ruleCount: number }

export interface ShellSnapshot {
  view: ShellView
  /** Null until the server has said, or when it cannot tell. */
  securityEnabled: boolean | null
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Reads the plugin's condition from the server. A plugin that is not running
 * is either disabled, failed to start, or between the stop and start of a
 * configuration save; only the server's enabled flag tells the first apart,
 * because a disabled plugin keeps the error of its last failed start.
 */
export async function probe(api: PanelApi): Promise<ShellSnapshot> {
  let securityEnabled: boolean | null = null
  try {
    const state = await api.state()
    securityEnabled = state.securityEnabled
    if (state.running) {
      const rules = await api.rules()
      return { view: { kind: 'ready', ruleCount: rules.length }, securityEnabled }
    }
    if (!(await api.pluginEnabled())) return { view: { kind: 'disabled' }, securityEnabled }
    if (state.error !== undefined) {
      return { view: { kind: 'failed', error: state.error }, securityEnabled }
    }
    return { view: { kind: 'restarting' }, securityEnabled }
  } catch (err) {
    return { view: { kind: 'unreachable', reason: reasonOf(err) }, securityEnabled }
  }
}

/**
 * A disabled plugin stays disabled until someone enables it, so polling would
 * only repeat the same answer; every other view can change on its own.
 */
export function keepsPolling(view: ShellView): boolean {
  return view.kind !== 'disabled'
}
