import { useEffect, useId, useRef, useState } from 'react'
import type { RuleEntry } from '../api'
import { StatusBadge } from '../rules/StatusBadge'
import type { DisplayUnit } from '../units'
import type { Parameter, RulesetEntry, RulesetsApi } from './api'
import { ParametersForm } from './ParametersForm'

export interface RulesetCardProps {
  api: RulesetsApi
  ruleset: RulesetEntry
  /** The rule entries of this ruleset, for their status. */
  rules: RuleEntry[]
  ruleHref: (origin: string, slug: string) => string
  /** Absent while the paths that decide the display units are still loading. */
  unitOf: ((p: Parameter) => DisplayUnit) | undefined
  /** Takes the entry an action answered, or undefined to read the listing again. */
  changed: (entry?: RulesetEntry) => void
  /** Says something to a screen reader, in the view's one live region. */
  announce: (message: string) => void
  /** The heading takes focus once shown, as when a rule links here. */
  takeFocus: boolean
}

function Origin({ ruleset }: { ruleset: RulesetEntry }) {
  const pkg = ruleset.package
  return (
    <p className="skar-ruleset-origin">
      <span className="skar-path">{ruleset.slug}</span>, version {ruleset.version},{' '}
      {pkg === undefined ? (
        <>from {ruleset.source}</>
      ) : (
        <>
          from package {pkg.name} {pkg.version}
        </>
      )}
    </p>
  )
}

function Notices({ ruleset, dismiss }: { ruleset: RulesetEntry; dismiss: () => Promise<void> }) {
  const headingId = useId()
  const [busy, setBusy] = useState(false)
  return (
    <section className="alert alert-info" aria-labelledby={headingId}>
      <h5 id={headingId} className="h6">
        Changes from an upgrade
      </h5>
      <ul>
        {ruleset.notices.map((n) => (
          <li key={`${n.at} ${n.message}`}>{n.message}</li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-outline-secondary btn-sm"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void dismiss().finally(() => {
            setBusy(false)
          })
        }}
      >
        Dismiss
      </button>
    </section>
  )
}

function RuleList({
  ruleset,
  rules,
  ruleHref
}: Pick<RulesetCardProps, 'ruleset' | 'rules' | 'ruleHref'>) {
  const bySlug = new Map(rules.map((r) => [r.slug, r]))
  const headingId = useId()
  return (
    <>
      <h5 id={headingId} className="skar-section-heading skar-ruleset-rules-heading">
        Rules
      </h5>
      <ul className="list-unstyled skar-ruleset-rules" aria-labelledby={headingId}>
        {ruleset.rules.map((slug) => {
          const entry = bySlug.get(slug)
          const missing =
            entry?.status.badge === 'inactive' && entry.status.issues.length > 0
              ? entry.status.issues
              : []
          return (
            <li key={slug}>
              <a href={ruleHref(ruleset.slug, slug)}>{entry?.rule.name ?? slug}</a>
              {entry !== undefined && <StatusBadge status={entry.status} />}
              {missing.length > 0 && (
                <div className="skar-path skar-status-detail">Missing: {missing.join(', ')}</div>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** One ruleset: where it comes from, its switch, notices, rules and parameters. */
export function RulesetCard({
  api,
  ruleset,
  rules,
  ruleHref,
  unitOf,
  changed,
  announce,
  takeFocus
}: RulesetCardProps) {
  const headingId = useId()
  const switchId = useId()
  const missingId = useId()
  const heading = useRef<HTMLHeadingElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (takeFocus) heading.current?.focus()
  }, [takeFocus])

  const act = async (action: () => Promise<void>) => {
    setFailure(undefined)
    try {
      await action()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
  }

  const toggle = () => {
    setBusy(true)
    void act(async () => {
      const entry = await api.setEnabled(ruleset.slug, !ruleset.enabled)
      changed(entry)
      announce(`${ruleset.name} ${entry.enabled ? 'enabled' : 'disabled'}.`)
    }).finally(() => {
      setBusy(false)
    })
  }

  const dismiss = () =>
    act(async () => {
      await api.dismissNotices(ruleset.slug)
      changed({ ...ruleset, notices: [] })
      // The notices held focus and are gone; the ruleset's heading keeps the operator's place.
      heading.current?.focus()
    })

  return (
    <section className="card skar-ruleset" aria-labelledby={headingId}>
      <div className="card-body">
        <h4 id={headingId} ref={heading} tabIndex={-1} className="h5 card-title">
          {ruleset.name}
        </h4>
        <Origin ruleset={ruleset} />
        {ruleset.description !== undefined && <p>{ruleset.description}</p>}
        <div className="form-check form-switch">
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            className="form-check-input"
            checked={ruleset.enabled}
            aria-checked={ruleset.enabled}
            disabled={busy}
            onChange={toggle}
          />
          <label htmlFor={switchId} className="form-check-label">
            Enabled
          </label>
        </div>
        {failure !== undefined && (
          <div className="alert alert-danger mt-2" role="alert">
            {failure}
          </div>
        )}
        {ruleset.notices.length > 0 && <Notices ruleset={ruleset} dismiss={dismiss} />}
        {!ruleset.enabled && ruleset.missingPaths.length > 0 && (
          <>
            <p id={missingId} className="mt-2 mb-1">
              Its rules read paths the server has not had data on; they stay inactive until the data
              appears:
            </p>
            <ul aria-labelledby={missingId} className="skar-path">
              {ruleset.missingPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        )}
        <RuleList ruleset={ruleset} rules={rules} ruleHref={ruleHref} />
        {ruleset.parameters.length > 0 &&
          (unitOf === undefined ? (
            <p>Loading the parameters…</p>
          ) : (
            <ParametersForm
              key={JSON.stringify(ruleset.values)}
              ruleset={ruleset}
              unitOf={unitOf}
              save={async (values) => {
                const entry = await api.setParameters(ruleset.slug, values)
                changed(entry)
                announce(`Parameters of ${ruleset.name} saved.`)
              }}
            />
          ))}
      </div>
    </section>
  )
}
