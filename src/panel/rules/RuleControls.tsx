import { useEffect, useId, useRef, useState } from 'react'
import type { RuleEntry } from '../api'
import { failureMessage } from '../failure'
import { Confirm, useConfirmation } from './Confirm'
import { activeCount, MAX_NOTE_LENGTH, plural } from './describe'

/**
 * Enables a disabled rule at once, and disables one after a confirmation that
 * asks for an optional note: disabling clears its alerts.
 */
export function DisableToggle({
  entry,
  disable,
  enable
}: {
  entry: RuleEntry
  disable: (note: string) => Promise<void>
  enable: () => Promise<void>
}) {
  const confirmation = useConfirmation()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const alerts = activeCount(entry)
  const enableButton = useRef<HTMLButtonElement | null>(null)
  const wasBusy = useRef(false)
  const noteId = useId()

  // A browser drops focus to the page from a button as it is disabled. The
  // button can take it back only after the render that enables it, and only
  // if the operator has not moved on meanwhile.
  useEffect(() => {
    if (wasBusy.current && !busy && document.activeElement === document.body) {
      enableButton.current?.focus()
    }
    wasBusy.current = busy
  }, [busy])

  const runEnable = async () => {
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

  if (entry.disabled !== undefined) {
    return (
      <>
        <button
          ref={enableButton}
          type="button"
          className="btn btn-outline-primary btn-sm me-2"
          disabled={busy}
          onClick={() => void runEnable()}
        >
          Enable
        </button>
        {error !== undefined && (
          <div className="alert alert-danger mt-2" role="alert">
            {error}
          </div>
        )}
      </>
    )
  }
  return (
    <>
      <button
        ref={confirmation.trigger}
        type="button"
        className="btn btn-outline-secondary btn-sm me-2"
        disabled={confirmation.open}
        onClick={() => {
          setNote('')
          confirmation.show()
        }}
      >
        Disable…
      </button>
      {confirmation.open && (
        <Confirm
          title={`Disable ${entry.rule.name}?`}
          confirmLabel="Disable"
          onConfirm={async () => {
            await disable(note.trim())
            confirmation.close()
          }}
          onCancel={confirmation.close}
        >
          <p>
            A disabled rule raises no alert until someone enables it again. It keeps evaluating, so
            enabling it while its condition holds raises the alert at once.
            {alerts > 0 && ` Disabling it clears its ${plural(alerts, 'active alert')}.`}
          </p>
          <label htmlFor={noteId} className="form-label">
            Note (optional)
          </label>
          <textarea
            id={noteId}
            className="form-control"
            rows={2}
            maxLength={MAX_NOTE_LENGTH}
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
            }}
          />
        </Confirm>
      )}
    </>
  )
}
