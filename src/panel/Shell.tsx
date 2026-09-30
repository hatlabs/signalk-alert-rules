import { useEffect, useState } from 'react'
import type { PanelApi } from './api'
import { pollDelay, probe, type ShellSnapshot, type ShellView } from './shellState'

const TABS = [
  { id: 'rules', label: 'Rules' },
  { id: 'suppressions', label: 'Suppressions' },
  { id: 'rulesets', label: 'Rulesets' }
] as const

type Tab = (typeof TABS)[number]['id']

export interface ShellProps {
  api: PanelApi
}

/**
 * Keeps the plugin's condition current: probes at once, then again after the
 * view's poll delay while the document is visible. Returns a function that
 * probes again on demand.
 */
function useSnapshot(api: PanelApi): [ShellSnapshot, () => void] {
  const [snapshot, setSnapshot] = useState<ShellSnapshot>({
    view: { kind: 'loading' },
    securityEnabled: null
  })
  const [requests, setRequests] = useState(0)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const hidden = () => document.visibilityState === 'hidden'

    const run = async () => {
      timer = undefined
      inFlight = true
      const next = await probe(api)
      inFlight = false
      if (cancelled) return
      setSnapshot(next)
      const delay = pollDelay(next.view)
      if (delay !== null && !hidden()) {
        timer = setTimeout(() => void run(), delay)
      }
    }

    const onVisibilityChange = () => {
      if (hidden()) {
        clearTimeout(timer)
        timer = undefined
      } else if (timer === undefined && !inFlight) {
        void run()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    void run()
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [api, requests])

  return [
    snapshot,
    () => {
      setRequests((n) => n + 1)
    }
  ]
}

function SecurityWarning() {
  return (
    <div className="alert alert-warning" role="alert">
      <strong>Server security is disabled.</strong> Anyone who can reach this server can create,
      change, suppress and delete alert rules. Enable security in the server settings.
    </div>
  )
}

function Condition({ view, checkAgain }: { view: ShellView; checkAgain: () => void }) {
  switch (view.kind) {
    case 'loading':
      return <div role="status">Loading…</div>
    case 'unreachable':
      return (
        <div className="alert alert-info" role="alert">
          Cannot reach the alert rules plugin: {view.reason}. Retrying…
        </div>
      )
    case 'restarting':
      return (
        <div className="alert alert-info" role="alert">
          The alert rules plugin is restarting. Retrying…
        </div>
      )
    case 'disabled':
      return (
        <div className="alert alert-secondary" role="alert">
          <p>The alert rules plugin is disabled. Enable it above to manage alert rules.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={checkAgain}>
            Check again
          </button>
        </div>
      )
    case 'sessionExpired':
      return (
        <div className="alert alert-warning" role="alert">
          <p>Your session has expired or lacks administrator rights; log in as an administrator.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={checkAgain}>
            Check again
          </button>
        </div>
      )
    case 'failed':
      return (
        <div className="alert alert-danger" role="alert">
          <p>The alert rules plugin could not start: {view.error}</p>
          <p className="mb-0">Rules cannot be edited until the plugin runs.</p>
        </div>
      )
    case 'ready':
      return null
  }
}

function NoRules({ browseRulesets }: { browseRulesets: () => void }) {
  return (
    <div className="skar-empty">
      <p>There are no alert rules yet.</p>
      <p>Create a rule, or enable a ruleset shipped by an installed package.</p>
      {/* Rule editing is wired by the rule editor; until then the entry point is visible but inert. */}
      <button type="button" className="btn btn-primary me-2" disabled>
        New rule
      </button>
      <button type="button" className="btn btn-outline-secondary" onClick={browseRulesets}>
        Browse rulesets
      </button>
    </div>
  )
}

function Views({ ruleCount }: { ruleCount: number }) {
  const [tab, setTab] = useState<Tab>('rules')
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <>
      <ul className="nav nav-tabs" role="tablist">
        {TABS.map((t) => (
          <li className="nav-item" key={t.id} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              className={t.id === tab ? 'nav-link active' : 'nav-link'}
              onClick={() => {
                setTab(t.id)
              }}
            >
              {t.label}
            </button>
          </li>
        ))}
      </ul>
      <div role="tabpanel" aria-label={current.label} className="skar-view">
        {tab === 'rules' &&
          (ruleCount === 0 ? (
            <NoRules
              browseRulesets={() => {
                setTab('rulesets')
              }}
            />
          ) : (
            <p>
              {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}
            </p>
          ))}
      </div>
    </>
  )
}

export function Shell({ api }: ShellProps) {
  const [snapshot, checkAgain] = useSnapshot(api)
  const { view, securityEnabled } = snapshot

  return (
    <div className="skar-panel">
      {securityEnabled === false && <SecurityWarning />}
      <Condition view={view} checkAgain={checkAgain} />
      {view.kind === 'ready' && <Views ruleCount={view.ruleCount} />}
    </div>
  )
}
