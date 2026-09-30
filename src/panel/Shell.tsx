import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { USER_ORIGIN, type PanelApi, type RuleEntry } from './api'
import { EditRule } from './editor/EditRule'
import { RuleEditor } from './editor/RuleEditor'
import type { PathSource } from './paths/selfPaths'
import { activeAlerts, ClearAllAlerts } from './rules/ClearAllAlerts'
import { Confirm } from './rules/Confirm'
import { EvaluationOffBanner } from './rules/EvaluationOffBanner'
import { RuleDetail } from './rules/RuleDetail'
import { hashWithRule, parseRuleFragment, type RuleRef } from './rules/ruleLink'
import { RulesView } from './rules/RulesView'
import {
  pollDelay,
  probe,
  shownReady,
  type ReadyView,
  type ShellSnapshot,
  type ShellView
} from './shellState'
import { useUnits } from './signalUnits'

const TABS = [
  { id: 'rules', label: 'Rules' },
  { id: 'suppressions', label: 'Suppressions' },
  { id: 'rulesets', label: 'Rulesets' }
] as const

type Tab = (typeof TABS)[number]['id']

export interface ShellProps {
  api: PanelApi
  /** The server's paths and their units, for display units and the path picker. */
  paths: PathSource
}

/**
 * Keeps the plugin's condition current: probes at once, then again after the
 * view's poll delay while the document is visible. Returns the ready view to
 * show the views from (see shownReady) and a function that probes again on
 * demand.
 */
function useSnapshot(api: PanelApi): [ShellSnapshot, ReadyView | undefined, () => void] {
  const [snapshot, setSnapshot] = useState<ShellSnapshot>({
    view: { kind: 'loading' },
    securityEnabled: null
  })
  const [ready, setReady] = useState<ReadyView | undefined>(undefined)
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
      setReady((last) => shownReady(next.view, last))
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
    ready,
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

interface ConditionProps {
  view: ShellView
  /** The views below show the rules as last read, not as they are now. */
  stale: boolean
  checkAgain: () => void
}

function Condition({ view, stale, checkAgain }: ConditionProps) {
  const lastRead = stale ? ' The rules below are as last read.' : ''
  switch (view.kind) {
    case 'loading':
      return <div role="status">Loading…</div>
    case 'unreachable':
      return (
        <div className="alert alert-info" role="alert">
          Cannot reach the alert rules plugin: {view.reason}. Retrying…{lastRead}
        </div>
      )
    case 'restarting':
      return (
        <div className="alert alert-info" role="alert">
          The alert rules plugin is restarting. Retrying…{lastRead}
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
          <p>
            Your session has expired or lacks administrator rights; log in as an administrator.
            {lastRead}
          </p>
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

/**
 * A link to a rule that is not listed: deleted, renamed, from a ruleset no
 * longer installed, or a stored rule that no longer validates.
 */
function RuleNotFound({
  ruleRef,
  backHref,
  headingRef
}: {
  ruleRef: RuleRef
  backHref: string
  headingRef: Ref<HTMLHeadingElement>
}) {
  return (
    <div className="skar-empty">
      <h3 ref={headingRef} tabIndex={-1} className="h5">
        Rule not found
      </h3>
      <p>
        There is no rule {ruleRef.origin}/{ruleRef.slug}. It may have been deleted, or it no longer
        validates.
      </p>
      <a href={backHref}>
        <span aria-hidden="true">←</span> All rules
      </a>
    </div>
  )
}

/**
 * What went wrong while loading the data directory. A stored rule that no
 * longer validates is not listed at all, so without this it would vanish.
 */
function LoadIssues({ issues }: { issues: string[] }) {
  const headingId = useId()
  if (issues.length === 0) return null
  return (
    <section className="alert alert-warning" aria-labelledby={headingId}>
      <h3 id={headingId} className="h6">
        Problems found while loading the stored data
      </h3>
      <ul className="mb-0">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </section>
  )
}

function NoRules({
  browseRulesets,
  onNew,
  someNotLoaded
}: {
  browseRulesets: () => void
  onNew: () => void
  /** Stored rules may exist that did not load, so "none yet" would be untrue. */
  someNotLoaded: boolean
}) {
  return (
    <div className="skar-empty">
      <p>{someNotLoaded ? 'No alert rule is listed.' : 'There are no alert rules yet.'}</p>
      <p>Create a rule, or enable a ruleset shipped by an installed package.</p>
      <button type="button" className="btn btn-primary me-2" onClick={onNew}>
        New rule
      </button>
      <button type="button" className="btn btn-outline-secondary" onClick={browseRulesets}>
        Browse rulesets
      </button>
    </div>
  )
}

/**
 * The location hash, kept current. The admin UI's router owns the hash, and
 * the panel reads its own fragment after it (see rules/ruleLink.ts).
 */
function useLocationHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const update = () => {
      setHash(window.location.hash)
    }
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  return hash
}

interface ViewsProps {
  api: PanelApi
  view: ReadyView
  paths: PathSource
  /** Probes again at once, so the views show the outcome of an action. */
  refresh: () => void
}

/** What the authoring form is open on. */
type EditorTarget = { kind: 'new' } | { kind: 'edit'; origin: string; slug: string }

function Views({ api, view, paths, refresh }: ViewsProps) {
  const { rules, evaluationEnabled, issues } = view
  const { units } = useUnits(paths)
  const [editor, setEditor] = useState<EditorTarget | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [pendingTab, setPendingTab] = useState<Tab | undefined>(undefined)
  // Shown until the list, refreshed after the save, has the rule.
  const [justSaved, setJustSaved] = useState<RuleEntry | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('rules')
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]
  const hash = useLocationHash()
  const ref = parseRuleFragment(hash)

  // A rule link opens the rule wherever the operator was.
  useEffect(() => {
    if (ref !== undefined) setTab('rules')
  }, [ref?.origin, ref?.slug])

  // Switching between the list and a rule replaces the view that held focus,
  // which would otherwise drop to the page body; focus moves to the new
  // view's heading instead. Not on first load, which must not steal focus
  // from the admin UI, and only once the rules tab shows, which a link from
  // another tab opens a render later.
  const heading = useRef<HTMLHeadingElement | null>(null)
  // An instance link focuses the instance's row instead, when the rule has it.
  const instanceRow = useRef<HTMLTableRowElement | null>(null)
  // The authoring form focuses its own heading once it shows, which for an
  // edit is only after the rule has loaded; leaving it returns focus here.
  const viewKey =
    editor !== undefined
      ? editor.kind === 'new'
        ? 'new'
        : `edit ${editor.origin}/${editor.slug}`
      : ref === undefined
        ? ''
        : `${ref.origin}/${ref.slug}#${ref.instance ?? ''}`
  const focusedKey = useRef(viewKey)
  const focusPending = useRef(false)
  useEffect(() => {
    if (focusedKey.current !== viewKey) {
      focusedKey.current = viewKey
      focusPending.current = true
    }
    if (focusPending.current && tab === 'rules') {
      focusPending.current = false
      ;(instanceRow.current ?? heading.current)?.focus()
    }
  })

  const [clearedAll, setClearedAll] = useState(false)

  const closeEditor = () => {
    setEditor(undefined)
    setDirty(false)
  }

  const selectTab = (next: Tab) => {
    if (editor !== undefined && dirty) {
      setPendingTab(next)
      return
    }
    closeEditor()
    setTab(next)
  }

  const saved = (entry: RuleEntry) => {
    closeEditor()
    setJustSaved(entry)
    refresh()
    window.location.hash = hashWithRule(hash, { origin: entry.origin, slug: entry.slug })
  }

  const editorView = (target: EditorTarget) => {
    if (target.kind === 'new') {
      return (
        <RuleEditor
          api={api}
          paths={paths}
          onSaved={saved}
          onClose={closeEditor}
          onDirtyChange={setDirty}
        />
      )
    }
    const entry = rules.find((r) => r.origin === target.origin && r.slug === target.slug)
    if (entry === undefined) {
      return <RuleNotFound ruleRef={target} backHref={hashWithRule(hash)} headingRef={heading} />
    }
    return (
      <EditRule
        api={api}
        paths={paths}
        entry={entry}
        onSaved={saved}
        onClose={closeEditor}
        onDirtyChange={setDirty}
      />
    )
  }

  const setEvaluation = async (enabled: boolean) => {
    await api.setEvaluation(enabled)
    refresh()
  }

  const rulesTab = () => {
    if (editor !== undefined) return editorView(editor)
    if (ref !== undefined) {
      const entry =
        rules.find((r) => r.origin === ref.origin && r.slug === ref.slug) ??
        (justSaved?.origin === ref.origin && justSaved.slug === ref.slug ? justSaved : undefined)
      const backHref = hashWithRule(hash)
      if (entry === undefined) {
        return <RuleNotFound ruleRef={ref} backHref={backHref} headingRef={heading} />
      }
      return (
        <RuleDetail
          entry={entry}
          backHref={backHref}
          headingRef={heading}
          units={units}
          instance={ref.instance}
          instanceRef={instanceRow}
          edit={
            entry.origin === USER_ORIGIN
              ? () => {
                  setEditor({ kind: 'edit', origin: entry.origin, slug: entry.slug })
                }
              : undefined
          }
          reset={async () => {
            await api.resetAccumulator(entry.origin, entry.slug)
            refresh()
          }}
          setEnabled={async (enabled) => {
            await api.setEnabled(entry.origin, entry.slug, enabled)
            refresh()
          }}
          setNote={async (note) => {
            await api.setNote(entry.origin, entry.slug, note)
            refresh()
          }}
        />
      )
    }
    // The tab already names the list for sighted users; this heading is where focus lands.
    const listHeading = (
      <h3 ref={heading} tabIndex={-1} className="visually-hidden">
        All rules
      </h3>
    )
    if (rules.length === 0) {
      return (
        <>
          {listHeading}
          <LoadIssues issues={issues} />
          <NoRules
            someNotLoaded={issues.length > 0}
            onNew={() => {
              setEditor({ kind: 'new' })
            }}
            browseRulesets={() => {
              setTab('rulesets')
            }}
          />
        </>
      )
    }
    return (
      <>
        {listHeading}
        <LoadIssues issues={issues} />
        <RulesView
          rules={rules}
          ruleHref={(origin, slug) => hashWithRule(hash, { origin, slug })}
          onNew={() => {
            setEditor({ kind: 'new' })
          }}
        />
        {evaluationEnabled && (
          <section className="skar-danger-zone" aria-label="All SKAR alerts">
            <ClearAllAlerts
              activeAlerts={activeAlerts(rules)}
              turnOff={async () => {
                await setEvaluation(false)
                setClearedAll(true)
              }}
            />
          </section>
        )}
      </>
    )
  }

  return (
    <>
      {!evaluationEnabled && (
        <EvaluationOffBanner
          takeFocus={clearedAll}
          turnOn={async () => {
            await setEvaluation(true)
            setClearedAll(false)
          }}
        />
      )}
      <ul className="nav nav-tabs" role="tablist">
        {TABS.map((t) => (
          <li className="nav-item" key={t.id} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              className={t.id === tab ? 'nav-link active' : 'nav-link'}
              onClick={() => {
                selectTab(t.id)
              }}
            >
              {t.label}
            </button>
          </li>
        ))}
      </ul>
      {pendingTab !== undefined && (
        <Confirm
          title="Leave the rule form?"
          confirmLabel="Discard changes"
          onConfirm={() => {
            closeEditor()
            setTab(pendingTab)
            setPendingTab(undefined)
            return Promise.resolve()
          }}
          onCancel={() => {
            setPendingTab(undefined)
          }}
        >
          <p className="mb-0">The changes to the rule have not been saved.</p>
        </Confirm>
      )}
      <div role="tabpanel" aria-label={current.label} className="skar-view">
        {tab === 'rules' && rulesTab()}
      </div>
    </>
  )
}

export function Shell({ api, paths }: ShellProps) {
  const [snapshot, ready, checkAgain] = useSnapshot(api)
  const { view, securityEnabled } = snapshot

  return (
    <div className="skar-panel">
      {securityEnabled === false && <SecurityWarning />}
      <Condition
        view={view}
        stale={ready !== undefined && view.kind !== 'ready'}
        checkAgain={checkAgain}
      />
      {ready !== undefined && <Views api={api} view={ready} paths={paths} refresh={checkAgain} />}
    </div>
  )
}
