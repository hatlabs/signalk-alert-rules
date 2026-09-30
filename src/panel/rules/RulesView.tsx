import { useId, useState } from 'react'
import { BADGES, type Badge, type RuleEntry } from '../api'
import {
  describeDetector,
  describeInput,
  describePriority,
  instanceSummary,
  isWildcard,
  markers,
  USER_ORIGIN
} from './describe'
import { SuppressDialog, type SuppressContext } from '../suppression/SuppressDialog'
import { useConfirmation } from './Confirm'
import { BADGE_LOOK, StatusBadge } from './StatusBadge'

export interface RulesViewProps {
  rules: RuleEntry[]
  /** The link that opens a rule's detail view. */
  ruleHref: (origin: string, slug: string) => string
  /** Opens the authoring form on a new rule. */
  onNew?: () => void
  /** Suppresses a rule from its row; absent where suppression is not offered. */
  suppression?: SuppressContext
}

const COLUMNS = 5

function matches(entry: RuleEntry, text: string, badge: Badge | ''): boolean {
  if (badge !== '' && entry.status.badge !== badge) return false
  const needle = text.trim().toLowerCase()
  if (needle === '') return true
  return [entry.rule.name, entry.slug, ...entry.rule.signal.paths].some((field) =>
    field.toLowerCase().includes(needle)
  )
}

/** User rules first, then each ruleset's, by package name. */
function byOrigin(rules: RuleEntry[]): [string, RuleEntry[]][] {
  const groups = new Map<string, RuleEntry[]>()
  for (const entry of rules) {
    groups.set(entry.origin, [...(groups.get(entry.origin) ?? []), entry])
  }
  return [...groups].sort(([a], [b]) =>
    a === USER_ORIGIN ? -1 : b === USER_ORIGIN ? 1 : a.localeCompare(b)
  )
}

function RuleRow({
  entry,
  href,
  suppression
}: {
  entry: RuleEntry
  href: string
  suppression?: SuppressContext
}) {
  const shownMarkers = markers(entry)
  const dialog = useConfirmation()
  return (
    <>
      <tr>
        <td>
          <a href={href}>{entry.rule.name}</a>
          {shownMarkers.map((marker) => (
            <span key={marker} className="badge text-bg-light skar-marker">
              {marker}
            </span>
          ))}
        </td>
        <td>
          <StatusBadge status={entry.status} />
          {isWildcard(entry.rule) && (
            <div className="skar-instance-summary">{instanceSummary(entry)}</div>
          )}
        </td>
        <td>{describeDetector(entry.rule.detector)}</td>
        <td className="skar-path">{describeInput(entry.rule.signal)}</td>
        <td>{describePriority(entry.rule)}</td>
        {suppression !== undefined && (
          <td>
            <button
              ref={dialog.trigger}
              type="button"
              className="btn btn-outline-secondary btn-sm"
              aria-label={`Suppress ${entry.rule.name}`}
              disabled={dialog.open}
              onClick={dialog.show}
            >
              Suppress…
            </button>
          </td>
        )}
      </tr>
      {suppression !== undefined && dialog.open && (
        // The dialog gets a row of its own, right under the rule it suppresses.
        <tr>
          <td colSpan={COLUMNS + 1}>
            <SuppressDialog
              target={{ kind: 'rule', entry }}
              context={suppression}
              onClose={dialog.close}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function RuleTable({ rules, ruleHref, suppression }: Omit<RulesViewProps, 'onNew'>) {
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
            {suppression !== undefined && (
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rules.map((entry) => (
            <RuleRow
              key={entry.slug}
              entry={entry}
              href={ruleHref(entry.origin, entry.slug)}
              suppression={suppression}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The rule list: filters, then the rules grouped by origin. */
export function RulesView({ rules, ruleHref, onNew, suppression }: RulesViewProps) {
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
        byOrigin(shown).map(([origin, entries]) =>
          origin === USER_ORIGIN ? (
            <div key={origin} role="group" aria-label="Your rules">
              <h3 className="h6">Your rules</h3>
              <RuleTable rules={entries} ruleHref={ruleHref} suppression={suppression} />
            </div>
          ) : (
            <details key={origin} open aria-label={`Ruleset ${origin}`}>
              <summary className="h6">Ruleset {origin}</summary>
              <RuleTable rules={entries} ruleHref={ruleHref} suppression={suppression} />
            </details>
          )
        )
      )}
    </div>
  )
}
