import { SessionExpiredError, type ListedRule, type PanelApi, type Permissions } from './api'

/** What the shell shows in place of, or around, the views. */
export type ShellView =
  | { kind: 'loading' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'notRunning' }
  /** A 401 on `/state`, which any logged-in user can read: always a login problem. */
  | { kind: 'sessionExpired' }
  | { kind: 'failed'; error: string }
  | ReadyView

export interface ReadyView {
  kind: 'ready'
  /** The rules that run, then the stored rules that do not. */
  rules: ListedRule[]
  /** Problems found while loading, such as a stored rule file that could not be read. */
  issues: string[]
  /** The caller's access level, which decides the controls shown. */
  permissions: Permissions
  /** When the rules were read, in ms since the epoch; shown while they go stale. */
  readAt: number
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
export async function probe(api: PanelApi, now: () => number = Date.now): Promise<ShellSnapshot> {
  let securityEnabled: boolean | null = null
  try {
    const state = await api.state()
    securityEnabled = state.securityEnabled
    if (state.running) {
      const rules = await api.rules()
      const issues = state.issues ?? []
      const { permissions } = state
      return {
        view: { kind: 'ready', rules, issues, permissions, readAt: now() },
        securityEnabled
      }
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

/**
 * What the shell says about a view other than a ready one, whether it stands
 * in for the views or sits over the last rules read.
 */
export function viewMessage(view: ShellView): string | undefined {
  switch (view.kind) {
    case 'loading':
      return 'Loading…'
    case 'unreachable':
      return `Reconnecting to the plugin (${view.reason}).`
    case 'notRunning':
      return 'The alert rules plugin is not running. Retrying…'
    case 'sessionExpired':
      return 'Your login has expired. Log in again, then check again.'
    case 'failed':
      return `The alert rules plugin could not start: ${view.error}. Rules cannot be edited until the plugin runs.`
    case 'ready':
      return undefined
  }
}
