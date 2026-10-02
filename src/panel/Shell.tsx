import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref
} from 'react'
import {
  isInvalid,
  type InvalidRuleEntry,
  type LevelRefusedError,
  type PanelApi,
  type RuleEntry
} from './api'
import { EditRule } from './editor/EditRule'
import { RuleEditor } from './editor/RuleEditor'
import { failureMessage, fieldErrorText, NEEDS_ADMINISTRATOR } from './failure'
import { RuleList } from './list/RuleList'
import { withRefusals } from './refusal'
import type { PathSource } from './paths/selfPaths'
import { hashWithRoute, parseRoute, type Route } from './route'
import { RuleDetail } from './rules/RuleDetail'
import {
  pollDelay,
  probe,
  shownReady,
  viewMessage,
  type ReadyView,
  type ShellSnapshot,
  type ShellView
} from './shellState'
import { useUnits } from './signalUnits'

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

  const again = useCallback(() => {
    setRequests((n) => n + 1)
  }, [])
  return [snapshot, ready, again]
}

function SecurityWarning() {
  return (
    <div className="alert alert-warning" role="alert">
      <strong>Server security is disabled.</strong> Anyone who can reach this server can create,
      change, disable and delete alert rules. Enable security in the server settings.
    </div>
  )
}

function CheckAgain({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="skar-btn skar-btn-ghost skar-btn-small" onClick={onClick}>
      Check again
    </button>
  )
}

/** The plugin's status while there are no rules to show. */
function PluginStatus({ view, checkAgain }: { view: ShellView; checkAgain: () => void }) {
  const message = viewMessage(view)
  switch (view.kind) {
    case 'ready':
      return null
    case 'loading':
      return <div role="status">{message}</div>
    case 'sessionExpired':
      return (
        <div className="alert alert-warning" role="alert">
          <p>{message}</p>
          <CheckAgain onClick={checkAgain} />
        </div>
      )
    case 'failed':
      return (
        <div className="alert alert-danger" role="alert">
          <p className="mb-0">{message}</p>
        </div>
      )
    default:
      return (
        <div className="alert alert-info" role="alert">
          {message}
        </div>
      )
  }
}

function WifiOffIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 8.8a15 15 0 014.2-2.6M10.7 5.1A15 15 0 0122 8.8M5 12.5a10 10 0 015.2-2.8M16.9 10.7A10 10 0 0119 12.5M8.5 16a5 5 0 017 0M12 20h.01M3 3l18 18" />
    </svg>
  )
}

/**
 * Over the last rules read while they cannot be read again: what went wrong
 * and how old the shown states are. Polling goes on underneath, so the list
 * stays mounted, scrolled where it was, and recovers by itself.
 */
function StaleNotice({
  view,
  readAt,
  checkAgain
}: {
  view: ShellView
  readAt: number
  checkAgain: () => void
}) {
  const message = viewMessage(view)
  if (message === undefined) return null
  const time = new Date(readAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const text = `${message} Showing states from ${time}.`
  if (view.kind === 'sessionExpired') {
    return (
      <div className="skar-banner" role="alert">
        <span>{text}</span>
        <CheckAgain onClick={checkAgain} />
      </div>
    )
  }
  return (
    <div className="skar-banner" role="status">
      <WifiOffIcon />
      <span>{text}</span>
    </div>
  )
}

/**
 * What went wrong while loading the data directory: a stored rule file that
 * could not be read is not listed at all, so without this it would vanish.
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

/** A link to a rule that is not listed, such as a deleted one: shown over the list. */
function RuleNotFound({ slug, noticeRef }: { slug: string; noticeRef: Ref<HTMLDivElement> }) {
  return (
    <div ref={noticeRef} tabIndex={-1} className="skar-banner skar-banner-info" role="alert">
      <span>
        <strong>Rule not found.</strong> There is no rule {slug}; it may have been deleted.
      </span>
    </div>
  )
}

function BackLink({ href }: { href: string }) {
  return (
    <a href={href}>
      <span aria-hidden="true">←</span> All rules
    </a>
  )
}

/** A view the caller's level cannot use, reached through a link. */
function NeedsAdministrator({
  title,
  backHref,
  headingRef
}: {
  title: string
  backHref: string
  headingRef: Ref<HTMLHeadingElement>
}) {
  return (
    <div className="skar-placeholder">
      <BackLink href={backHref} />
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        {title}
      </h2>
      <p>{NEEDS_ADMINISTRATOR}</p>
    </div>
  )
}

/** Add rule, until template sets can be picked from: only the data path flow works. */
function AddRule({
  routeHref,
  headingRef
}: {
  routeHref: (route: Route) => string
  headingRef: Ref<HTMLHeadingElement>
}) {
  return (
    <div className="skar-placeholder">
      <BackLink href={routeHref({ kind: 'list' })} />
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        Add rule
      </h2>
      <p>Adding a rule from a template is not available yet.</p>
      <a className="skar-btn skar-btn-primary" href={routeHref({ kind: 'add', from: 'path' })}>
        Start from a data path
      </a>
    </div>
  )
}

/** A stored rule that does not run, until it can be opened in the editor to fix. */
function InvalidRule({
  entry,
  backHref,
  headingRef
}: {
  entry: InvalidRuleEntry
  backHref: string
  headingRef: Ref<HTMLHeadingElement>
}) {
  return (
    <div className="skar-placeholder">
      <BackLink href={backHref} />
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        {entry.name}
      </h2>
      <p>The stored rule is not valid, so it does not run:</p>
      <ul>
        {entry.invalid.errors.map((e) => (
          <li key={`${e.path} ${e.message}`}>{fieldErrorText(e)}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The location hash, kept current. The admin UI's router owns the hash, and
 * the panel reads its own fragment after it (see route.ts).
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
  /** Shown over the views while they show the rules as last read. */
  stale: ReactNode
}

function Views({ api: serverApi, view, paths, refresh, stale }: ViewsProps) {
  const { rules, issues, permissions, readAt } = view
  const { units } = useUnits(paths)
  // Shown until the list, refreshed after the save, has the rule.
  const [justSaved, setJustSaved] = useState<RuleEntry | undefined>(undefined)
  const hash = useLocationHash()
  const route = parseRoute(hash)
  const routeHref = (to: Route) => hashWithRoute(hash, to)
  const go = (to: Route) => {
    window.location.hash = routeHref(to)
  }
  const listHref = routeHref({ kind: 'list' })
  const admin = permissions === 'admin'
  const canDisable = admin || permissions === 'readwrite'

  // Switching views replaces the one that held focus, which would otherwise
  // drop to the page body; focus moves to the new view's heading instead.
  // Not on first load, which must not steal focus from the admin UI.
  const heading = useRef<HTMLHeadingElement | null>(null)
  // An instance link focuses the instance's row instead, when the rule has it,
  // and a link to a rule that is not there the notice saying so.
  const instanceRow = useRef<HTMLTableRowElement | null>(null)
  const notFound = useRef<HTMLDivElement | null>(null)
  const viewKey = JSON.stringify(route)
  const focusedKey = useRef(viewKey)
  const focusPending = useRef(false)
  useEffect(() => {
    if (focusedKey.current !== viewKey) {
      focusedKey.current = viewKey
      focusPending.current = true
    }
    if (focusPending.current) {
      focusPending.current = false
      ;(instanceRow.current ?? notFound.current ?? heading.current)?.focus()
    }
  })

  // A write refused for its level re-reads the level, which can take away the
  // control and its dialog that would have said so; this notice says it
  // instead, until the operator moves on. A refusal that answers after they
  // moved on belongs to a view no longer shown, so it sets nothing.
  const [refusal, setRefusal] = useState<LevelRefusedError | undefined>(undefined)
  const [refusalView, setRefusalView] = useState(viewKey)
  if (refusalView !== viewKey) {
    setRefusalView(viewKey)
    setRefusal(undefined)
  }
  const shownView = useRef(viewKey)
  useEffect(() => {
    shownView.current = viewKey
  })
  const api = useMemo(
    () =>
      withRefusals(serverApi, (refused) => {
        if (shownView.current === viewKey) setRefusal(refused)
        refresh()
      }),
    [serverApi, refresh, viewKey]
  )

  const find = (slug: string) =>
    rules.find((r) => r.slug === slug) ?? (justSaved?.slug === slug ? justSaved : undefined)

  const saved = (entry: RuleEntry) => {
    setJustSaved(entry)
    refresh()
    go({ kind: 'rule', slug: entry.slug })
  }

  // A rule's own view and its editor both need the rule; a link to one that
  // is not listed shows the list, saying so.
  const ruleRoute = route.kind === 'rule' || (route.kind === 'edit' && admin) ? route : undefined
  const entry = ruleRoute && find(ruleRoute.slug)
  const missing = ruleRoute !== undefined && entry === undefined ? ruleRoute.slug : undefined
  const showsList = route.kind === 'list' || missing !== undefined
  // Adding and editing say so themselves to anyone below an administrator.
  const shownRefusal = admin || route.kind === 'rule' ? refusal : undefined

  const list = () => (
    <RuleList
      rules={rules}
      permissions={permissions}
      units={units}
      now={readAt}
      routeHref={routeHref}
      headingRef={heading}
      someNotLoaded={issues.length > 0}
      notices={
        <>
          {stale}
          {missing !== undefined && <RuleNotFound slug={missing} noticeRef={notFound} />}
          <LoadIssues issues={issues} />
        </>
      }
    />
  )

  const content = () => {
    if (showsList) return list()
    if (entry !== undefined && isInvalid(entry)) {
      return <InvalidRule entry={entry} backHref={listHref} headingRef={heading} />
    }
    switch (route.kind) {
      case 'rule': {
        if (entry === undefined) return list()
        return (
          <RuleDetail
            entry={entry}
            backHref={listHref}
            headingRef={heading}
            units={units}
            instance={route.instance}
            instanceRef={instanceRow}
            {...(admin
              ? {
                  edit: () => {
                    go({ kind: 'edit', slug: entry.slug })
                  },
                  reset: async () => {
                    await api.resetAccumulator(entry.slug)
                    refresh()
                  }
                }
              : {})}
            {...(canDisable
              ? {
                  disable: async (note: string) => {
                    await api.disableRule(entry.slug, note)
                    refresh()
                  },
                  enable: async () => {
                    await api.enableRule(entry.slug)
                    refresh()
                  }
                }
              : {})}
          />
        )
      }
      case 'edit': {
        if (!admin) {
          return <NeedsAdministrator title="Edit rule" backHref={listHref} headingRef={heading} />
        }
        if (entry === undefined) return list()
        return (
          <EditRule
            api={api}
            paths={paths}
            entry={entry}
            onSaved={saved}
            onClose={() => {
              go({ kind: 'rule', slug: entry.slug })
            }}
          />
        )
      }
      case 'add':
        if (!admin) {
          return <NeedsAdministrator title="Add rule" backHref={listHref} headingRef={heading} />
        }
        if (route.from === 'path') {
          return (
            <RuleEditor
              api={api}
              paths={paths}
              onSaved={saved}
              onClose={() => {
                go({ kind: 'list' })
              }}
            />
          )
        }
        return <AddRule routeHref={routeHref} headingRef={heading} />
    }
  }

  // The list carries the stale notice under its summary line; the other views on top.
  return (
    <div className="skar-view">
      {!showsList && stale}
      {shownRefusal !== undefined && (
        <div className="skar-banner" role="alert">
          <span>{failureMessage(shownRefusal)}</span>
        </div>
      )}
      {content()}
    </div>
  )
}

export function Shell({ api, paths }: ShellProps) {
  const [snapshot, ready, checkAgain] = useSnapshot(api)
  const { view, securityEnabled } = snapshot

  return (
    <div className="skar-panel">
      {securityEnabled === false && <SecurityWarning />}
      {ready === undefined ? (
        <PluginStatus view={view} checkAgain={checkAgain} />
      ) : (
        <Views
          api={api}
          view={ready}
          paths={paths}
          refresh={checkAgain}
          stale={<StaleNotice view={view} readAt={ready.readAt} checkAgain={checkAgain} />}
        />
      )}
    </div>
  )
}
