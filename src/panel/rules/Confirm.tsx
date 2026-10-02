import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
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

/** Runs a confirmed action: busy while it runs, its failure kept to show. */
function useAction(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(failureMessage(err))
      setBusy(false)
    }
  }
  return { busy, error, run }
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]'

export interface ConfirmSheetProps extends ConfirmProps {
  /** Drawn before the confirm label. */
  confirmIcon?: ReactNode
  /** Dark for an action that can be undone, such as Disable; danger for one that cannot. */
  tone: 'dark' | 'danger'
}

/**
 * A confirmation that slides up from the bottom over a dimmed page, sized for
 * a thumb on a phone. Focus stays inside it while it is open, Escape and the
 * dimmed page cancel, and a failed action keeps it open with the error.
 * Cancel takes focus first, so a stray Enter does nothing, and a phone does
 * not raise its keyboard over the sheet unasked.
 */
export function ConfirmSheet({
  title,
  children,
  confirmLabel,
  confirmIcon,
  tone,
  onConfirm,
  onCancel
}: ConfirmSheetProps) {
  const { busy, error, run } = useAction(onConfirm)
  const titleId = useId()
  const bodyId = useId()
  const sheet = useRef<HTMLDivElement | null>(null)
  const cancel = () => {
    if (!busy) onCancel()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      cancel()
      return
    }
    if (e.key !== 'Tab' || sheet.current === null) return
    const focusable = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = focusable.at(0)
    const last = focusable.at(-1)
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="skar-sheet-layer">
      <div className="skar-sheet-backdrop" aria-hidden="true" onClick={cancel} />
      <div
        ref={sheet}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="skar-sheet"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="skar-sheet-title">
          {title}
        </h2>
        <div id={bodyId} className="skar-sheet-body">
          {children}
        </div>
        {error !== undefined && (
          <div className="skar-sheet-error" role="alert">
            {error}
          </div>
        )}
        <div className="skar-sheet-actions">
          <button
            type="button"
            className="skar-btn skar-btn-ghost"
            disabled={busy}
            onClick={cancel}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className={`skar-btn skar-btn-${tone}`}
            disabled={busy}
            onClick={() => void run()}
          >
            {confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * An inline confirmation for an action that cannot be undone. The admin UI
 * shows no modal of its own for a plugin panel, so this stays in the page
 * next to the action it confirms; Cancel takes focus so a stray Enter does
 * nothing destructive.
 */
export function Confirm({ title, children, confirmLabel, onConfirm, onCancel }: ConfirmProps) {
  const { busy, error, run: confirm } = useAction(onConfirm)
  const titleId = useId()
  const bodyId = useId()

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
