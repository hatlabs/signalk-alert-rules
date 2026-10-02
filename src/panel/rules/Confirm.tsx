import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { failureMessage } from '../failure'

export interface Confirmation {
  open: boolean
  show: () => void
  close: () => void
  /** For the button that opens the confirmation. */
  trigger: RefObject<HTMLButtonElement | null>
}

/**
 * Whether a confirmation is open. Closing it returns focus to its trigger:
 * the confirmation held focus, and removing it would otherwise drop focus to
 * the page body, losing a keyboard or screen reader user's place.
 */
export function useConfirmation(): Confirmation {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    // The trigger is disabled while open, so it can take focus only after this render.
    if (wasOpen.current && !open) trigger.current?.focus()
    wasOpen.current = open
  }, [open])
  return {
    open,
    show: () => {
      setOpen(true)
    },
    close: () => {
      setOpen(false)
    },
    trigger
  }
}

export interface ConfirmProps {
  title: string
  /** What confirming does, naming the consequence. */
  children: ReactNode
  confirmLabel: string
  /** Resolves once the action is done; a rejection is shown and the dialog stays open. */
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/**
 * An inline confirmation for an action that cannot be undone. The admin UI
 * shows no modal of its own for a plugin panel, so this stays in the page
 * next to the action it confirms; Cancel takes focus so a stray Enter does
 * nothing destructive.
 */
export function Confirm({ title, children, confirmLabel, onConfirm, onCancel }: ConfirmProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const titleId = useId()
  const bodyId = useId()

  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
    } catch (err) {
      setError(failureMessage(err))
      setBusy(false)
    }
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="card border-danger skar-confirm"
    >
      <div className="card-body">
        <h4 id={titleId} className="h6 card-title">
          {title}
        </h4>
        <div id={bodyId}>{children}</div>
        {error !== undefined && (
          <div className="alert alert-danger mt-2 mb-0" role="alert">
            {error}
          </div>
        )}
        <div className="mt-2">
          <button
            type="button"
            className="btn btn-danger btn-sm me-2"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            disabled={busy}
            onClick={onCancel}
            autoFocus
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
