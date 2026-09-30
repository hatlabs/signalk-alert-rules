import { useId, useState, type ReactNode } from 'react'
import type { RuleEntry } from '../api'
import { Confirm } from './Confirm'
import { describeDetector, describeInput, describePriority, formatValue, markers } from './describe'
import { InstanceTable, instanceName } from './InstanceTable'
import { StatusBadge } from './StatusBadge'

export interface RuleDetailProps {
  entry: RuleEntry
  /** The link back to the rule list. */
  backHref: string
  /** Resets the rule's accumulator; resolves once the list shows the result. */
  reset: () => Promise<void>
}

/** An accumulator measuring time totals seconds; an integral's unit depends on its input. */
function totalUnit(entry: RuleEntry): string | undefined {
  return entry.rule.detector.measure === 'time' ? 's' : undefined
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  const id = useId()
  return (
    <>
      <dt id={id}>{term}</dt>
      <dd aria-labelledby={id}>{children}</dd>
    </>
  )
}

/** What a reset discards: each instance's total, or the one total of a plain rule. */
function DiscardedTotals({ entry }: { entry: RuleEntry }) {
  const unit = totalUnit(entry)
  const totals = entry.status.instances.flatMap((i) =>
    i.progress?.kind === 'total' ? [{ name: instanceName(i), total: i.progress.total }] : []
  )
  if (totals.length === 0) return <p>There is no accumulated total yet.</p>
  if (totals.length === 1 && totals[0].name === '') {
    return <p>This discards the total of {formatValue(totals[0].total, unit)}.</p>
  }
  return (
    <>
      <p>This discards the totals:</p>
      <ul>
        {totals.map(({ name, total }) => (
          <li key={name}>
            {name}: {formatValue(total, unit)}
          </li>
        ))}
      </ul>
    </>
  )
}

/** One rule with its status and per-instance rows: the target of an alert's link. */
export function RuleDetail({ entry, backHref, reset }: RuleDetailProps) {
  const [confirming, setConfirming] = useState(false)
  const { rule, status } = entry
  const errorsId = useId()
  const isAccumulator = rule.detector.type === 'accumulator'

  return (
    <div className="skar-rule-detail">
      <a href={backHref}>
        <span aria-hidden="true">←</span> All rules
      </a>
      <h3 className="h5 mt-2">{rule.name}</h3>
      <p className="skar-path">
        {entry.origin}/{entry.slug}
        {markers(entry).map((marker) => (
          <span key={marker} className="badge text-bg-light skar-marker">
            {marker}
          </span>
        ))}
      </p>
      <StatusBadge status={status} />
      {status.errors.length > 0 && (
        <>
          <h4 id={errorsId} className="h6 mt-3">
            Errors
          </h4>
          <ul aria-labelledby={errorsId}>
            {status.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
      <dl className="skar-facts mt-3">
        <Fact term="Detector">{describeDetector(rule.detector)}</Fact>
        <Fact term="Input">{describeInput(rule.signal)}</Fact>
        <Fact term="Priority">{describePriority(rule)}</Fact>
        {rule.gates.length > 0 && (
          <Fact term="Gates">
            {rule.gates.map((g, n) => (
              <div key={n}>{describeInput({ paths: g.paths })}</div>
            ))}
          </Fact>
        )}
        {entry.note !== undefined && <Fact term="Note">{entry.note}</Fact>}
        {entry.suppression !== undefined && (
          <Fact term="Suppressed">
            since {entry.suppression.since} by {entry.suppression.actor}
            {entry.suppression.note === undefined ? '' : `: ${entry.suppression.note}`}
          </Fact>
        )}
      </dl>
      {status.issues.length > 0 && (
        <ul className="skar-issues">
          {status.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <InstanceTable instances={status.instances} totalUnit={totalUnit(entry)} />
      <p className="form-text">Values are in SI units.</p>
      <div className="skar-actions">
        {/* The authoring form comes later; the entry point is visible but inert until then. */}
        <button type="button" className="btn btn-outline-primary btn-sm me-2" disabled>
          Edit
        </button>
        {isAccumulator && (
          <button
            type="button"
            className="btn btn-outline-danger btn-sm"
            disabled={confirming}
            onClick={() => {
              setConfirming(true)
            }}
          >
            Reset accumulator…
          </button>
        )}
      </div>
      {confirming && (
        <Confirm
          title={`Reset ${rule.name}?`}
          confirmLabel="Reset total"
          onConfirm={async () => {
            await reset()
            setConfirming(false)
          }}
          onCancel={() => {
            setConfirming(false)
          }}
        >
          <DiscardedTotals entry={entry} />
          <p className="mb-0">
            The rule clears its active alerts and accumulates again from zero. This cannot be
            undone.
          </p>
        </Confirm>
      )}
    </div>
  )
}
