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

export interface Sheet<T> {
  /** What the sheet is open for; undefined while it is closed. */
  value: T | undefined
  show: (value: T) => void
  /** Closes it, returning focus to what had it when it opened unless told otherwise. */
  close: (returnFocus?: boolean) => void
}

/**
 * A sheet opened for a value, such as where the operator asked to go.
 * Closing it returns focus to whatever had focus when it opened, as
 * `useConfirmation` does for a sheet with a single trigger.
 */
export function useSheet<T>(): Sheet<T> {
  const [value, setValue] = useState<T | undefined>(undefined)
  const opener = useRef<HTMLElement | null>(null)
  const refocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    refocus.current?.focus()
    refocus.current = null
  }, [value])
  return {
    value,
    show: (next) => {
      // Taken before the sheet renders: its Cancel takes focus as it appears.
      if (value === undefined && document.activeElement instanceof HTMLElement)
        opener.current = document.activeElement
      setValue(next)
    },
    close: (returnFocus = true) => {
      refocus.current = returnFocus ? opener.current : null
      opener.current = null
      setValue(undefined)
    }
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
