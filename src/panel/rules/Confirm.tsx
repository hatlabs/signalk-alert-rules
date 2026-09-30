import { useId, useState, type ReactNode } from 'react'

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
      setError(err instanceof Error ? err.message : String(err))
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
