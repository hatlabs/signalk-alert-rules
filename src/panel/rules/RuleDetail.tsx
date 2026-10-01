import { useId, type ReactNode, type Ref } from 'react'
import type { RuleEntry } from '../api'
import { NO_UNITS, type UnitLookup } from '../signalUnits'
import { Confirm, useConfirmation } from './Confirm'
import {
  describeDetector,
  describeInput,
  describePriority,
  discardedTotals,
  formatTime,
  ruleDisplay,
  type RuleDisplay
} from './describe'
import { InstanceTable, isLinked } from './InstanceTable'
import { DisableToggle } from './RuleControls'
import { StatusBadge } from './StatusBadge'

export interface RuleDetailProps {
  entry: RuleEntry
  /** The link back to the rule list. */
  backHref: string
  /** Resets the rule's accumulator; a rejection is shown in the confirmation. */
  reset: () => Promise<void>
  /** The rule's heading, which takes focus when the operator navigates to it. */
  headingRef?: Ref<HTMLHeadingElement>
  /** The units of the rule's paths; without them values are shown in SI. */
  units?: UnitLookup
  /** Opens the rule in the authoring form; absent where the rule cannot be edited. */
  edit?: () => void
  /** The instance a link names, to highlight, or to say it is not there. */
  instance?: string
  /** The linked instance's row, which takes focus when the operator follows the link. */
  instanceRef?: Ref<HTMLTableRowElement>
  /** Disables the rule with a note, an empty one meaning none; absent where it cannot be changed. */
  disable?: (note: string) => Promise<void>
  /** Enables the rule; a rejection is shown. */
  enable?: () => Promise<void>
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
function DiscardedTotals({ entry, display }: { entry: RuleEntry; display: RuleDisplay }) {
  const totals = discardedTotals(entry, display.total)
  if (totals.length === 0) return <p>There is no accumulated total yet.</p>
  if (totals.length === 1 && totals[0].name === '') {
    return <p>This discards the total of {totals[0].total}.</p>
  }
  return (
    <>
      <p>This discards the totals:</p>
      <ul>
        {totals.map(({ name, total }) => (
          <li key={name}>
            {name}: {total}
          </li>
        ))}
      </ul>
    </>
  )
}

/** One rule with its status and per-instance rows: the target of an alert's link. */
export function RuleDetail({
  entry,
  backHref,
  reset,
  headingRef,
  units = NO_UNITS,
  edit,
  instance,
  instanceRef,
  disable,
  enable
}: RuleDetailProps) {
  const confirmation = useConfirmation()
  const { rule, status } = entry
  const errorsId = useId()
  const isAccumulator = rule.detector.type === 'accumulator'
  const display = ruleDisplay(rule, units)

  return (
    <div className="skar-rule-detail">
      <a href={backHref}>
        <span aria-hidden="true">←</span> All rules
      </a>
      <h3 ref={headingRef} tabIndex={-1} className="h5 mt-2">
        {rule.name}
      </h3>
      <p className="skar-path">{entry.slug}</p>
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
        <Fact term="Alert path">{`alerts.${rule.alertPath}`}</Fact>
        {rule.gates.length > 0 && (
          <Fact term="Gates">
            {rule.gates.map((g, n) => (
              <div key={n}>{describeInput({ paths: g.paths })}</div>
            ))}
          </Fact>
        )}
        {entry.disabled !== undefined && (
          <Fact term="Disabled">
            since <time dateTime={entry.disabled.since}>{formatTime(entry.disabled.since)}</time> by{' '}
            {entry.disabled.actor}
            {entry.disabled.note === undefined ? '' : `: ${entry.disabled.note}`}
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
      {instance !== undefined && !status.instances.some((i) => isLinked(i, instance)) && (
        <div className="alert alert-warning" role="status">
          This rule has no instance {instance} now. It may not have reported since the plugin
          started, or it no longer reports.
        </div>
      )}
      <InstanceTable
        instances={status.instances}
        display={display}
        linked={instance}
        linkedRef={instanceRef}
      />
      {display.si && <p className="form-text">Values are in SI units.</p>}
      <div className="skar-actions">
        <button
          type="button"
          className="btn btn-outline-primary btn-sm me-2"
          disabled={edit === undefined}
          onClick={edit}
        >
          Edit
        </button>
        {disable !== undefined && enable !== undefined && (
          <DisableToggle entry={entry} disable={disable} enable={enable} />
        )}
        {isAccumulator && (
          <button
            ref={confirmation.trigger}
            type="button"
            className="btn btn-outline-danger btn-sm"
            disabled={confirmation.open}
            onClick={confirmation.show}
          >
            Reset accumulator…
          </button>
        )}
      </div>
      {confirmation.open && (
        <Confirm
          title={`Reset ${rule.name}?`}
          confirmLabel="Reset total"
          onConfirm={async () => {
            await reset()
            confirmation.close()
          }}
          onCancel={confirmation.close}
        >
          <DiscardedTotals entry={entry} display={display} />
          <p className="mb-0">
            The rule clears its active alerts and accumulates again from zero. This cannot be
            undone.
          </p>
        </Confirm>
      )}
    </div>
  )
}
