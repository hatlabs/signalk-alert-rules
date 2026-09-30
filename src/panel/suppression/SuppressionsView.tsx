import { useEffect, useRef, useState } from 'react'
import type { PanelApi, RuleEntry, Suppression } from '../api'
import { failureMessage } from '../failure'
import type { PathSource } from '../paths/selfPaths'
import { Confirm, useConfirmation } from '../rules/Confirm'
import { formatDuration, formatTime, plural, ruleName } from '../rules/describe'
import { SUB_LABEL_TEXT } from '../rules/StatusBadge'
import { SuppressButton } from './SuppressButton'

export type SuppressionsApi = Pick<
  PanelApi,
  | 'suppressions'
  | 'previewInputSuppression'
  | 'suppressRule'
  | 'suppressInput'
  | 'endRuleSuppression'
  | 'endInputSuppression'
>

export interface SuppressionsViewProps {
  api: SuppressionsApi
  /** The rules as last read; a new reading reloads the suppressions, which can end by themselves. */
  rules: RuleEntry[]
  paths: PathSource
  /** The link that opens a rule's detail view. */
  ruleHref: (origin: string, slug: string) => string
  /** Probes again at once, so the rules show the outcome of an action. */
  refresh: () => void
}

type Listing =
  | { status: 'loading' }
  | {
      status: 'ready'
      suppressions: Suppression[]
      affected: ReadonlyMap<string, number>
      /** Why the last reload failed; the list is as last read. */
      reloadError?: string
    }
  | { status: 'failed'; error: string }

/**
 * How many rules each input suppression affects: those it suppresses and
 * those with a gate it freezes. The list does not say; the preview does, from
 * the same comparison the engine applies. A count that cannot be read is left
 * out rather than hiding the list.
 */
async function affectedRules(
  api: SuppressionsApi,
  suppressions: Suppression[]
): Promise<ReadonlyMap<string, number>> {
  const paths = suppressions.flatMap((s) => (s.scope === 'input' ? [s.path] : []))
  const counts = await Promise.all(
    paths.map(async (path) => {
      try {
        const preview = await api.previewInputSuppression(path)
        const affected = [...preview.suppresses, ...preview.freezes].map((r) => r.rule)
        return [[path, new Set(affected).size] as const]
      } catch {
        return []
      }
    })
  )
  return new Map(counts.flat())
}

function scopeName(s: Suppression, rules: RuleEntry[]): string {
  return s.scope === 'rule' ? ruleName(rules, s.origin, s.slug) : `input ${s.path}`
}

const COLUMNS = ['Scope', 'Started', 'By', 'Note', 'Ends'] as const

function SuppressionRow({
  suppression: s,
  rules,
  affected,
  ruleHref,
  end
}: {
  suppression: Suppression
  rules: RuleEntry[]
  affected: number | undefined
  ruleHref: SuppressionsViewProps['ruleHref']
  end: () => Promise<void>
}) {
  const confirmation = useConfirmation()
  const name = scopeName(s, rules)
  return (
    <>
      <tr>
        <td>
          {s.scope === 'rule' ? (
            <a href={ruleHref(s.origin, s.slug)}>{name}</a>
          ) : (
            <>
              <div>
                Input <span className="skar-path">{s.path}</span>
              </div>
              {affected !== undefined && (
                <div className="skar-instance-summary">affects {plural(affected, 'rule')}</div>
              )}
            </>
          )}
        </td>
        <td>
          <time dateTime={s.since}>{formatTime(s.since)}</time>
        </td>
        <td>{s.actor}</td>
        <td>{s.note ?? ''}</td>
        <td>
          {s.autoEndAfter === undefined ? (
            'Manually'
          ) : (
            <>
              By itself after {formatDuration(s.autoEndAfter)} clear
              <div className="skar-instance-summary">{SUB_LABEL_TEXT.waitingForClear}</div>
            </>
          )}
        </td>
        <td>
          <button
            ref={confirmation.trigger}
            type="button"
            className="btn btn-outline-danger btn-sm"
            aria-label={`End the suppression of ${name}`}
            disabled={confirmation.open}
            onClick={confirmation.show}
          >
            End…
          </button>
        </td>
      </tr>
      {confirmation.open && (
        <tr>
          <td colSpan={COLUMNS.length + 1}>
            <Confirm
              title={`End the suppression of ${name}?`}
              confirmLabel="End suppression"
              onConfirm={async () => {
                await end()
                confirmation.close()
              }}
              onCancel={confirmation.close}
            >
              <p className="mb-0">
                The rules it suppresses raise alerts again. An alert whose condition still holds is
                raised again as a new alert.
              </p>
            </Confirm>
          </td>
        </tr>
      )}
    </>
  )
}

/** The suppressions in force, with the action to end each and to suppress an input. */
export function SuppressionsView({ api, rules, paths, ruleHref, refresh }: SuppressionsViewProps) {
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [reloads, setReloads] = useState(0)
  const [ended, setEnded] = useState<{ name: string } | undefined>(undefined)
  const suppressInput = useRef<HTMLButtonElement | null>(null)

  // The ended suppression's row held focus; without a place to go it would drop to the page.
  useEffect(() => {
    if (ended !== undefined) suppressInput.current?.focus()
  }, [ended])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const suppressions = await api.suppressions()
        const affected = await affectedRules(api, suppressions)
        if (!cancelled) setListing({ status: 'ready', suppressions, affected })
      } catch (err) {
        if (cancelled) return
        const error = failureMessage(err)
        // One dropped poll must not take the list, or an open confirmation, away.
        setListing((last) =>
          last.status === 'ready' ? { ...last, reloadError: error } : { status: 'failed', error }
        )
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [api, rules, reloads])

  const changed = () => {
    setReloads((n) => n + 1)
    refresh()
  }

  const end = async (s: Suppression) => {
    if (s.scope === 'rule') await api.endRuleSuppression(s.origin, s.slug)
    else await api.endInputSuppression(s.path)
    // The server has ended it, so its row goes now rather than after the reload.
    setListing((last) =>
      last.status === 'ready'
        ? { ...last, suppressions: last.suppressions.filter((x) => x !== s) }
        : last
    )
    setEnded({ name: scopeName(s, rules) })
    changed()
  }

  return (
    <div className="skar-suppressions-view">
      <p>
        A suppression silences rules temporarily, for a known fault: they keep evaluating but raise
        no alert until it ends. A disabled rule is off until someone enables it again, and is not
        listed here.
      </p>
      <div className="skar-toolbar">
        <SuppressButton
          target={{ kind: 'input' }}
          context={{ api, rules, paths, done: changed }}
          text="Suppress input…"
          buttonRef={suppressInput}
        />
      </div>
      <div role="status" className="visually-hidden">
        {ended === undefined ? '' : `Ended the suppression of ${ended.name}.`}
      </div>
      {listing.status === 'loading' && <p role="status">Loading…</p>}
      {listing.status === 'failed' && (
        <div className="alert alert-danger" role="alert">
          The suppressions could not be read: {listing.error}
        </div>
      )}
      {listing.status === 'ready' && listing.reloadError !== undefined && (
        <div className="alert alert-warning" role="status">
          The suppressions could not be read again: {listing.reloadError}. They are shown as last
          read.
        </div>
      )}
      {listing.status === 'ready' &&
        (listing.suppressions.length === 0 ? (
          <p>No suppression is in force.</p>
        ) : (
          <div className="table-responsive">
            <table className="table table-sm align-middle skar-suppressions">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listing.suppressions.map((s) => (
                  <SuppressionRow
                    key={s.scope === 'rule' ? `rule ${s.rule}` : `input ${s.path}`}
                    suppression={s}
                    rules={rules}
                    affected={s.scope === 'input' ? listing.affected.get(s.path) : undefined}
                    ruleHref={ruleHref}
                    end={() => end(s)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  )
}
