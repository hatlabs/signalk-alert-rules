import { useEffect, useId, useRef, useState } from 'react'
import type { RuleEntry } from '../api'
import { failureMessage } from '../failure'
import { Confirm, useConfirmation } from './Confirm'
import { activeCount, MAX_NOTE_LENGTH, plural } from './describe'

/**
 * Enables a disabled rule at once, and disables one after a confirmation:
 * disabling clears its alerts, and an operator after a temporary silence
 * wants a suppression instead.
 */
export function EnableToggle({
  entry,
  setEnabled
}: {
  entry: RuleEntry
  setEnabled: (enabled: boolean) => Promise<void>
}) {
  const confirmation = useConfirmation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const alerts = activeCount(entry)
  const enableButton = useRef<HTMLButtonElement | null>(null)
  const wasBusy = useRef(false)

  // A browser drops focus to the page from a button as it is disabled. The
  // button can take it back only after the render that enables it, and only
  // if the operator has not moved on meanwhile.
  useEffect(() => {
    if (wasBusy.current && !busy && document.activeElement === document.body) {
      enableButton.current?.focus()
    }
    wasBusy.current = busy
  }, [busy])

  const enable = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await setEnabled(true)
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!entry.enabled) {
    return (
      <>
        <button
          ref={enableButton}
          type="button"
          className="btn btn-outline-primary btn-sm me-2"
          disabled={busy}
          onClick={() => void enable()}
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
        onClick={confirmation.show}
      >
        Disable…
      </button>
      {confirmation.open && (
        <Confirm
          title={`Disable ${entry.rule.name}?`}
          confirmLabel="Disable"
          onConfirm={async () => {
            await setEnabled(false)
            confirmation.close()
          }}
          onCancel={confirmation.close}
        >
          <p>
            A disabled rule is off until someone enables it again: it is not evaluated and raises no
            alert.
            {alerts > 0 && ` Disabling it clears its ${plural(alerts, 'active alert')}.`}
          </p>
          <p className="mb-0">
            To silence it only while a known fault lasts, suppress it instead; a suppressed rule
            keeps evaluating.
          </p>
        </Confirm>
      )}
    </>
  )
}

/** Edits a rule's note in place; an empty note removes it. */
export function NoteEditor({
  entry,
  setNote
}: {
  entry: RuleEntry
  setNote: (note: string) => Promise<void>
}) {
  const editing = useConfirmation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const id = useId()

  const open = () => {
    setText(entry.note ?? '')
    setError(undefined)
    editing.show()
  }

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await setNote(text.trim())
      editing.close()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={editing.trigger}
        type="button"
        className="btn btn-outline-secondary btn-sm me-2"
        disabled={editing.open}
        onClick={open}
      >
        {entry.note === undefined ? 'Add note…' : 'Edit note…'}
      </button>
      {editing.open && (
        <form
          className="card skar-inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="card-body">
            <label htmlFor={id} className="form-label">
              Note
            </label>
            <textarea
              id={id}
              className="form-control"
              rows={2}
              maxLength={MAX_NOTE_LENGTH}
              aria-describedby={`${id}-hint`}
              value={text}
              autoFocus
              onChange={(e) => {
                setText(e.target.value)
              }}
            />
            <div id={`${id}-hint`} className="form-text">
              For whoever looks at this rule next. Leave it empty to remove the note.
            </div>
            {error !== undefined && (
              <div className="alert alert-danger mt-2 mb-0" role="alert">
                {error}
              </div>
            )}
            <div className="mt-2">
              <button type="submit" className="btn btn-primary btn-sm me-2" disabled={busy}>
                Save note
              </button>
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                disabled={busy}
                onClick={editing.close}
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}
    </>
  )
}
