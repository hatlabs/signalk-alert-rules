import { useId, type ReactNode, type Ref } from 'react'
import type { ListedRule, Permissions } from '../api'
import type { Route } from '../route'
import type { UnitLookup } from '../signalUnits'
import { byAttention, needsAttention, summary } from './attention'
import { RuleRow } from './RuleRow'

export interface RuleListProps {
  rules: ListedRule[]
  permissions: Permissions
  units: UnitLookup
  /** The time the facts' ages are counted to, in ms since the epoch. */
  now: number
  routeHref: (route: Route) => string
  /** The view's heading, which takes focus when the operator navigates to the list. */
  headingRef?: Ref<HTMLHeadingElement>
  /** Notices shown under the summary line, such as the reconnecting banner. */
  notices?: ReactNode
  /** Stored rules exist that could not be read, so "none yet" would be untrue. */
  someNotLoaded?: boolean
}

function PlusIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 003.4 0" />
    </svg>
  )
}

function Group({
  title,
  rules,
  ...row
}: {
  title: string
  rules: ListedRule[]
} & Pick<RuleListProps, 'units' | 'now' | 'routeHref'>) {
  const id = useId()
  if (rules.length === 0) return null
  return (
    <section aria-labelledby={id} className="skar-group">
      <h3 id={id} className="skar-group-title">
        {title}
      </h3>
      <ul className="skar-rows">
        {rules.map((entry) => (
          <RuleRow
            key={entry.slug}
            entry={entry}
            href={row.routeHref({ kind: 'rule', slug: entry.slug })}
            units={row.units}
            now={row.now}
          />
        ))}
      </ul>
    </section>
  )
}

/** No rules: what rules are for and, for an administrator, how to add the first. */
function Empty({
  permissions,
  routeHref,
  headingRef,
  notices,
  someNotLoaded
}: Omit<RuleListProps, 'rules' | 'units' | 'now'>) {
  return (
    <div className="skar-empty">
      {notices}
      <div className="skar-empty-icon">
        <BellIcon />
      </div>
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        {someNotLoaded === true ? 'No alert rule is listed' : 'No alert rules yet'}
      </h2>
      <p className="skar-muted">
        Rules watch your boat&apos;s data and raise an alert when something needs attention, such as
        a low battery or a bilge pump running too long.
      </p>
      {permissions === 'admin' && (
        <div className="skar-empty-actions">
          <a
            className="skar-btn skar-btn-primary"
            href={routeHref({ kind: 'add', from: 'template' })}
          >
            Start from a template
          </a>
          <a className="skar-btn skar-btn-ghost" href={routeHref({ kind: 'add', from: 'path' })}>
            Start from a data path
          </a>
        </div>
      )}
    </div>
  )
}

/** The landing view: every rule, the ones needing attention first. */
export function RuleList(props: RuleListProps) {
  const { rules, permissions, routeHref, headingRef, notices, units, now } = props
  const row = { units, now, routeHref }
  if (rules.length === 0) return <Empty {...props} />
  const ordered = byAttention(rules)
  return (
    <div className="skar-list">
      <div className="skar-title-row">
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          Alert rules
        </h2>
        {permissions === 'admin' && (
          <a
            className="skar-btn skar-btn-primary skar-btn-compact"
            href={routeHref({ kind: 'add' })}
          >
            <PlusIcon />
            Add rule
          </a>
        )}
      </div>
      <p className="skar-summary">{summary(rules)}</p>
      {notices}
      <Group {...row} title="Needs attention" rules={ordered.filter(needsAttention)} />
      <Group {...row} title="Normal" rules={ordered.filter((r) => !needsAttention(r))} />
    </div>
  )
}
