import { SessionExpiredError, type PanelApi, type RuleEntry } from './api'

/** What the shell shows in place of, or around, the views. */
export type ShellView =
  | { kind: 'loading' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'notRunning' }
  | { kind: 'sessionExpired' }
  | { kind: 'failed'; error: string }
  | ReadyView

export interface ReadyView {
  kind: 'ready'
  rules: RuleEntry[]
  /** Problems found while loading, such as stored rules that are not listed because they do not validate. */
  issues: string[]
}

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
 * either failed to start, or is disabled or between the stop and start of a
 * configuration save; stopping clears a start error, so only the first
 * reports one. The panel does not tell the last two apart: the admin UI
 * lists the webapp only while the plugin is enabled, so the panel is reached
 * while it is disabled only through a bookmarked link.
 */
export async function probe(api: PanelApi): Promise<ShellSnapshot> {
  let securityEnabled: boolean | null = null
  try {
    const state = await api.state()
    securityEnabled = state.securityEnabled
    if (state.running) {
      const rules = await api.rules()
      const issues = state.issues ?? []
      return { view: { kind: 'ready', rules, issues }, securityEnabled }
    }
    if (state.error !== undefined) {
      return { view: { kind: 'failed', error: state.error }, securityEnabled }
    }
    return { view: { kind: 'notRunning' }, securityEnabled }
  } catch (err) {
    if (err instanceof SessionExpiredError)
      return { view: { kind: 'sessionExpired' }, securityEnabled }
    return { view: { kind: 'unreachable', reason: reasonOf(err) }, securityEnabled }
  }
}

/**
 * The ready view to show the views from under `view`: the view itself, or
 * the last one read while the plugin is only briefly out of reach or the
 * session has expired. One dropped poll on a boat's Wi-Fi, or a tablet waking
 * after its session lapsed, would otherwise unmount the views and lose the
 * operator's filters, tab, any confirmation in progress and a rule being
 * written; with the views kept, an action fails with the session message
 * instead. A plugin that failed to start has no views to keep.
 */
export function shownReady(view: ShellView, last: ReadyView | undefined): ReadyView | undefined {
  switch (view.kind) {
    case 'ready':
      return view
    case 'unreachable':
    case 'notRunning':
    case 'sessionExpired':
      return last
    default:
      return undefined
  }
}

export const POLL_INTERVAL_MS = 5000

/**
 * How long to wait before probing again after showing `view`, or null to stop:
 * an expired session stays expired until the operator logs in again.
 */
export function pollDelay(view: ShellView): number | null {
  return view.kind === 'sessionExpired' ? null : POLL_INTERVAL_MS
}
