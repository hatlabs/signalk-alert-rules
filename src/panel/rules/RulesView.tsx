import { Fragment, useId, useState } from 'react'
import { BADGES, type Badge, type RuleEntry } from '../api'
import {
  describeDetector,
  describeInput,
  describePriority,
  instanceSummary,
  isWildcard
} from './describe'
import { BADGE_LOOK, StatusBadge } from './StatusBadge'

export interface RulesViewProps {
  rules: RuleEntry[]
  /** The link that opens a rule's detail view. */
  ruleHref: (slug: string) => string
  /** Opens the authoring form on a new rule. */
  onNew?: () => void
}

function matches(entry: RuleEntry, text: string, badge: Badge | ''): boolean {
  if (badge !== '' && entry.status.badge !== badge) return false
  const needle = text.trim().toLowerCase()
  if (needle === '') return true
  return [entry.rule.name, entry.slug, ...entry.rule.signal.paths].some((field) =>
    field.toLowerCase().includes(needle)
  )
}

/** Text with paths in it, which may wrap only after a path's dots, never inside a segment. */
function BreakAtDots({ text }: { text: string }) {
  return text.split('.').map((part, n, parts) => (
    <Fragment key={n}>
      {part}
      {n < parts.length - 1 && (
        <>
          .<wbr />
        </>
      )}
    </Fragment>
  ))
}

function RuleRow({ entry, href }: { entry: RuleEntry; href: string }) {
  return (
    <tr>
      <td>
        <a href={href}>{entry.rule.name}</a>
      </td>
      <td>
        <StatusBadge status={entry.status} />
        {isWildcard(entry.rule) && (
          <div className="skar-instance-summary">{instanceSummary(entry)}</div>
        )}
      </td>
      <td>{describeDetector(entry.rule.detector)}</td>
      <td className="skar-input">
        <BreakAtDots text={describeInput(entry.rule.signal)} />
      </td>
      <td>{describePriority(entry.rule)}</td>
    </tr>
  )
}

function RuleTable({ rules, ruleHref }: Omit<RulesViewProps, 'onNew'>) {
  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle skar-rules">
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Status</th>
            <th scope="col">Detector</th>
            <th scope="col">Input</th>
            <th scope="col">Priority</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((entry) => (
            <RuleRow key={entry.slug} entry={entry} href={ruleHref(entry.slug)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The rule list: filters, then the rules. */
export function RulesView({ rules, ruleHref, onNew }: RulesViewProps) {
  const [text, setText] = useState('')
  const [badge, setBadge] = useState<Badge | ''>('')
  const filterId = useId()
  const statusId = useId()
  const shown = rules.filter((entry) => matches(entry, text, badge))

  return (
    <div className="skar-rules-view">
      <div className="skar-toolbar">
        <div>
          <label htmlFor={filterId} className="form-label">
            Filter
          </label>
          <input
            id={filterId}
            type="search"
            className="form-control form-control-sm"
            placeholder="Name, slug or path"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
            }}
          />
        </div>
        <div>
          <label htmlFor={statusId} className="form-label">
            Status
          </label>
          <select
            id={statusId}
            className="form-select form-select-sm"
            value={badge}
            onChange={(e) => {
              setBadge(BADGES.find((b) => b === e.target.value) ?? '')
            }}
          >
            <option value="">Any status</option>
            {BADGES.map((b) => (
              <option key={b} value={b}>
                {BADGE_LOOK[b].label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={onNew === undefined}
          onClick={onNew}
        >
          New rule
        </button>
      </div>
      {shown.length === 0 ? (
        <p>No rules match the filters.</p>
      ) : (
        <RuleTable rules={shown} ruleHref={ruleHref} />
      )}
    </div>
  )
}
