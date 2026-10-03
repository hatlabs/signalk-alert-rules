import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'
import { UNAUTHENTICATED_ACTOR, type RuleEntry, type RuleInfo } from '../api'
import { failureMessage } from '../failure'
import { chipOf } from '../list/attention'
import { elapsed, MINUTE } from '../list/fact'
import { capitalised, PriorityBadge } from '../list/PriorityBadge'
import { StateChip } from '../list/StateChip'
import { ConfirmSheet, useConfirmation, type Confirmation } from '../rules/Confirm'
import {
  activeCount,
  ANGULAR_LABEL,
  alertsWhen,
  clearsWhen,
  discardedTotals,
  formatTime,
  gateCondition,
  hasInstances,
  combinatorLabel,
  MAX_NOTE_LENGTH,
  plural,
  ruleDisplay,
  type RuleDisplay
} from '../rules/describe'
import { HistoryChart } from '../history/HistoryChart'
import type { HistorySource } from '../history/historySource'
import { detailChart } from '../history/ruleChart'
import { NO_UNITS, type UnitLookup } from '../signalUnits'
import { explain, type Sentence } from './explain'
import { BackIcon, EditIcon, PowerIcon } from './icons'
import { Instances, isLinked } from './Instances'
import { Steps } from './Steps'

export interface RuleDetailProps {
  entry: RuleEntry
  /** The link back to the rule list. */
  backHref: string
  /** The time the facts' ages are counted to, in ms since the epoch. */
  now: number
  /** The rule's heading, which takes focus when the operator navigates to it. */
  headingRef?: Ref<HTMLHeadingElement>
  /** The units of the rule's paths; without them values are shown in SI. */
  units?: UnitLookup
  /** The server's recorded values, for the path's chart; absent, there is none. */
  history?: HistorySource
  /** The instance a link names, to mark, or to say it is not there. */
  instance?: string
  /** The linked instance's row, which takes focus when the operator follows the link. */
  instanceRef?: Ref<HTMLLIElement>
  /** Opens the rule in the editor; absent where the rule cannot be edited. */
  edit?: () => void
  /** Disables the rule with a note, an empty one meaning none; absent where it cannot be changed. */
  disable?: (note: string) => Promise<void>
  /** Enables the rule; absent where it cannot be changed. */
  enable?: () => Promise<void>
  /** Deletes the rule; absent where it cannot be deleted. */
  remove?: () => Promise<void>
  /** Resets an accumulator's totals; absent where they cannot be reset. */
  reset?: () => Promise<void>
}

/** How long ago, "just now" while the seconds would only count up. */
function ageOf(ms: number): string {
  return ms < MINUTE ? 'just now' : `${elapsed(ms)} ago`
}

const ALERT_CONSOLE_HINT = 'To acknowledge or silence the alert itself, use the alert console.'

function Explanation({ sentence }: { sentence: Sentence }) {
  return (
    <p className="skar-card skar-explain">
      {sentence.map((part, i) =>
        typeof part === 'string' ? part : <strong key={i}>{part.strong}</strong>
      )}
    </p>
  )
}

/** Who disabled the rule, how long ago, and their note. */
function DisabledBy({ entry, now }: { entry: RuleEntry; now: number }) {
  const { disabled } = entry
  if (disabled === undefined) return null
  // Only a server with security off lets a request without a login disable a rule.
  const actor = disabled.actor === UNAUTHENTICATED_ACTOR ? 'someone' : disabled.actor
  return (
    <div className="skar-card skar-card-dark">
      <p className="skar-disabled-by" title={formatTime(disabled.since)}>
        {`Disabled by ${actor}, ${ageOf(now - Date.parse(disabled.since))}`}
      </p>
      {disabled.note !== undefined && <p className="skar-disabled-note">{`“${disabled.note}”`}</p>}
    </div>
  )
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

/** A signal's paths, after the editor's name for a combined signal's combinator. */
function SignalWords({ signal }: { signal: RuleInfo['signal'] }) {
  const paths = <span className="skar-mono">{signal.paths.join(', ')}</span>
  const label = combinatorLabel(signal)
  return label === undefined ? (
    paths
  ) : (
    <>
      {label} ({paths})
    </>
  )
}

/** What the rule watches, when it alerts and what it sends, as its author set it. */
function Facts({
  entry,
  display,
  units
}: {
  entry: RuleEntry
  display: RuleDisplay
  units: UnitLookup
}) {
  const { rule, status } = entry
  const combined = rule.signal.combinator !== undefined
  const clears = clearsWhen(rule, display)
  return (
    <dl className="skar-card skar-facts">
      <Fact term="Watches">
        <div>
          <SignalWords signal={rule.signal} />
        </div>
        {rule.signal.angular === true && <div className="skar-hint">{ANGULAR_LABEL}</div>}
      </Fact>
      {!combined && <Fact term="Source">{rule.source ?? 'Preferred source'}</Fact>}
      <Fact term="Alerts when">{alertsWhen(rule, display)}</Fact>
      {clears !== undefined && <Fact term="Clears">{clears}</Fact>}
      {rule.steps.length < 2 && (
        <Fact term="Priority">
          {rule.priority === undefined ? "From the path's zones" : capitalised(rule.priority)}
        </Fact>
      )}
      {rule.latching === true && <Fact term="Latching">Keeps the alert until acknowledged</Fact>}
      {rule.gates.length > 0 && (
        <Fact term="Only while">
          {rule.gates.map((g, n) => (
            <div key={n} className="skar-gate-fact">
              <div>
                <SignalWords signal={g} /> {gateCondition(g, units)}
              </div>
              {g.angular === true && <div className="skar-hint">{ANGULAR_LABEL}</div>}
            </div>
          ))}
        </Fact>
      )}
      <Fact term="Alert path">
        <span className="skar-mono">{`alerts.${rule.alertPath}`}</span>
      </Fact>
      <Fact term="Message">{status.message ?? rule.message}</Fact>
      {rule.template !== undefined && (
        <Fact term="From template">{`${rule.template.id} (${rule.template.set})`}</Fact>
      )}
    </dl>
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

function DisableSheet({
  entry,
  disable,
  onClose
}: {
  entry: RuleEntry
  disable: (note: string) => Promise<void>
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const noteId = useId()
  const alerts = activeCount(entry)
  const cleared =
    alerts === 0
      ? '.'
      : alerts === 1
        ? ', and its current alert is cleared now.'
        : `, and its ${plural(alerts, 'current alert')} are cleared now.`
  return (
    <ConfirmSheet
      title={`Disable the rule “${entry.rule.name}”?`}
      confirmLabel="Disable rule"
      confirmIcon={<PowerIcon />}
      tone="dark"
      onConfirm={async () => {
        await disable(note.trim())
        onClose()
      }}
      onCancel={onClose}
    >
      <p>{`This disables the rule. It raises no alerts until someone enables it again${cleared}`}</p>
      {alerts > 0 && (
        <p className="skar-muted">
          To acknowledge or silence the alert instead, use the alert console.
        </p>
      )}
      <div className="skar-sheet-field">
        <label htmlFor={noteId} className="skar-label">
          Why? <span className="skar-optional">(optional)</span>
        </label>
        <input
          id={noteId}
          className="skar-input"
          placeholder="e.g. paddlewheel fouled"
          maxLength={MAX_NOTE_LENGTH}
          value={note}
          onChange={(e) => {
            setNote(e.target.value)
          }}
        />
      </div>
    </ConfirmSheet>
  )
}

/** Enables at once: enabling raises nothing that disabling had not held back. */
function EnableButton({
  enable,
  button
}: {
  enable: () => Promise<void>
  button: RefObject<HTMLButtonElement | null>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const wasBusy = useRef(false)

  // A browser drops focus to the page from a button as it is disabled. The
  // button can take it back only after the render that enables it, and only
  // if the operator has not moved on meanwhile.
  useEffect(() => {
    if (wasBusy.current && !busy && document.activeElement === document.body) {
      button.current?.focus()
    }
    wasBusy.current = busy
  }, [busy])

  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await enable()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="skar-btn skar-btn-primary skar-btn-wide"
        disabled={busy}
        onClick={() => void run()}
      >
        <PowerIcon />
        Enable rule
      </button>
      {error !== undefined && (
        <div className="skar-sheet-error" role="alert">
          {error}
        </div>
      )}
    </>
  )
}

function SheetTrigger({
  confirmation,
  className,
  children
}: {
  confirmation: Confirmation
  className: string
  children: ReactNode
}) {
  return (
    <button
      ref={confirmation.trigger}
      type="button"
      className={`skar-btn ${className}`}
      disabled={confirmation.open}
      onClick={confirmation.show}
    >
      {children}
    </button>
  )
}

/**
 * Disabling or enabling replaces the control that did it, which held focus,
 * so focus would drop to the page body. Once the operator's own action shows
 * in the rule, focus moves to the control that replaced it, unless they have
 * moved on; a change someone else made moves nothing. Returns a wrapper that
 * marks an action as the operator's own.
 */
function useToggleFocus(
  disabled: boolean,
  disableButton: RefObject<HTMLButtonElement | null>,
  enableButton: RefObject<HTMLButtonElement | null>
) {
  const own = useRef(false)
  const wasDisabled = useRef(disabled)
  useEffect(() => {
    if (wasDisabled.current === disabled) return
    wasDisabled.current = disabled
    if (own.current && document.activeElement === document.body) {
      ;(disabled ? enableButton : disableButton).current?.focus()
    }
    own.current = false
  }, [disabled, disableButton, enableButton])
  return <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      // Marked before the request, as a poll can show the change before it answers.
      own.current = true
      try {
        await action(...args)
      } catch (err) {
        own.current = false
        throw err
      }
    }
}

/** The rule's own controls, each present only for a level that can use it. */
function Controls({
  entry,
  display,
  edit,
  disable,
  enable,
  remove,
  reset
}: Pick<RuleDetailProps, 'entry' | 'edit' | 'disable' | 'enable' | 'remove' | 'reset'> & {
  display: RuleDisplay
}) {
  const headingId = useId()
  const disabling = useConfirmation()
  const deleting = useConfirmation()
  const resetting = useConfirmation()
  const enabling = useRef<HTMLButtonElement | null>(null)
  const { rule } = entry
  const disabled = entry.disabled !== undefined
  const toggled = useToggleFocus(disabled, disabling.trigger, enabling)
  // A poll can show the rule disabled by someone else while the sheet is open;
  // confirming then would overwrite their note.
  if (disabled && disabling.open) disabling.close()
  const canReset = reset !== undefined && rule.detector.type === 'accumulator'

  const editButton = edit !== undefined && (
    <button key="edit" type="button" className="skar-btn skar-btn-ghost" onClick={edit}>
      <EditIcon />
      Edit
    </button>
  )
  const disableButton = !disabled && disable !== undefined && (
    <SheetTrigger key="disable" confirmation={disabling} className="skar-btn-ghost">
      <PowerIcon />
      Disable
    </SheetTrigger>
  )
  const deleteButton = remove !== undefined && (
    <SheetTrigger key="delete" confirmation={deleting} className="skar-btn-danger-ghost">
      Delete
    </SheetTrigger>
  )
  const grid = [editButton, disableButton, deleteButton].filter((b) => b !== false)
  const enableButton = disabled && enable !== undefined
  if (grid.length === 0 && !enableButton && !canReset) return null

  return (
    <div
      role="group"
      className="skar-controls"
      {...(disabled ? { 'aria-label': 'Rule' } : { 'aria-labelledby': headingId })}
    >
      {!disabled && (
        <h3 id={headingId} className="skar-group-title">
          Rule
        </h3>
      )}
      {enableButton && <EnableButton enable={toggled(enable)} button={enabling} />}
      {grid.length > 0 && (
        <div
          className="skar-control-grid"
          style={{ gridTemplateColumns: `repeat(${String(grid.length)}, minmax(0, 1fr))` }}
        >
          {grid}
        </div>
      )}
      {canReset && (
        <SheetTrigger confirmation={resetting} className="skar-btn-ghost">
          Reset total…
        </SheetTrigger>
      )}
      {disabling.open && disable !== undefined && (
        <DisableSheet entry={entry} disable={toggled(disable)} onClose={disabling.close} />
      )}
      {deleting.open && remove !== undefined && (
        <ConfirmSheet
          title={`Delete the rule “${rule.name}”?`}
          confirmLabel="Delete rule"
          tone="danger"
          onConfirm={remove}
          onCancel={deleting.close}
        >
          <p>This deletes the rule and clears its alerts. It cannot be undone.</p>
        </ConfirmSheet>
      )}
      {resetting.open && reset !== undefined && (
        <ConfirmSheet
          title={`Reset the total of “${rule.name}”?`}
          confirmLabel="Reset total"
          tone="danger"
          onConfirm={async () => {
            await reset()
            resetting.close()
          }}
          onCancel={resetting.close}
        >
          <DiscardedTotals entry={entry} display={display} />
          <p>
            The rule clears its active alerts and counts again from zero. This cannot be undone.
          </p>
        </ConfirmSheet>
      )}
    </div>
  )
}

/**
 * One rule: its state in a sentence, its steps, instances and facts, and the
 * controls the caller's level allows. The target of an alert's link.
 */
export function RuleDetail({
  entry,
  backHref,
  now,
  headingRef,
  units = NO_UNITS,
  history,
  instance,
  instanceRef,
  ...controls
}: RuleDetailProps) {
  const errorsId = useId()
  const { rule, status } = entry
  const display = ruleDisplay(rule, units)
  const chip = chipOf(entry)
  const wildcard = hasInstances(entry)
  const chart = history && detailChart(rule, units)

  return (
    <div className="skar-detail">
      <a className="skar-back" href={backHref}>
        <BackIcon />
        Alert rules
      </a>
      <div className="skar-detail-head">
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          {rule.name}
        </h2>
        <div role="group" aria-label="State" className="skar-state">
          <StateChip kind={chip} />
          {chip === 'alerting' && status.priority !== undefined && (
            <PriorityBadge priority={status.priority} />
          )}
        </div>
      </div>
      <Explanation sentence={explain(entry, units, now)} />
      <DisabledBy entry={entry} now={now} />
      {status.errors.length > 0 && (
        <section className="skar-card" aria-labelledby={errorsId}>
          <h3 id={errorsId} className="skar-card-title">
            Errors
          </h3>
          <ul aria-labelledby={errorsId} className="skar-plain-list">
            {status.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      )}
      {status.issues.length > 0 && (
        <ul className="skar-plain-list skar-muted">
          {status.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {instance !== undefined && !status.instances.some((i) => isLinked(i, instance)) && (
        <div className="skar-banner" role="status">
          <span>
            This rule has no instance {instance} now. It may not have reported since the plugin
            started, or it no longer reports.
          </span>
        </div>
      )}
      <Steps entry={entry} display={display} />
      {history !== undefined && chart !== undefined && (
        <HistoryChart
          history={history}
          spec={chart}
          // The path's own name heads its chart; without one the chart names its span.
          title={units.entry(chart.path)?.displayName}
        />
      )}
      {wildcard && (
        <Instances
          instances={status.instances}
          rule={rule}
          display={display}
          now={now}
          linked={instance}
          linkedRef={instanceRef}
        />
      )}
      <Facts entry={entry} display={display} units={units} />
      {display.si && <p className="skar-hint">Values are in SI units.</p>}
      <Controls entry={entry} display={display} {...controls} />
      {chip === 'alerting' && <p className="skar-hint">{ALERT_CONSOLE_HINT}</p>}
    </div>
  )
}
