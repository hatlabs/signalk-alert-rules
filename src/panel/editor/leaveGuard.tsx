import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ConfirmSheet, useSheet } from '../rules/Confirm'

/**
 * Where the operator asked to go: out by the editor's Cancel, to a link, or
 * to where the location already is after a hash change from outside.
 */
type Destination = { kind: 'close' } | { kind: 'link'; href: string } | { kind: 'arrived' }

/** The open editor's hold on hash changes while it has unsaved changes; one editor is open at a time. */
let hold: ((hash: string) => void) | undefined

/**
 * Whether an editor with unsaved changes holds the view at a hash change, as
 * the browser's Back makes one. The shell then keeps showing the editor,
 * which asks first and lets the view follow only once the changes are
 * discarded.
 */
export function navigationHeld(hash: string): boolean {
  if (hold === undefined) return false
  hold(hash)
  return true
}

function leavingLink(event: MouseEvent): HTMLAnchorElement | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return undefined
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(link instanceof HTMLAnchorElement)) return undefined
  // A link opening another tab or window leaves the editor where it is.
  if (link.target !== '' && link.target !== '_self') return undefined
  return link.href === window.location.href ? undefined : link
}

export interface LeaveGuardOptions {
  /** Whether the editor has changes that leaving would drop. */
  dirty: boolean
  /** Leaves by the editor's own Cancel, the changes discarded. */
  onClose: () => void
  /** What the prompt says is lost. */
  unsaved: string
}

export interface LeaveGuard {
  /** The editor's Cancel: leaves at once without changes, else asks first. */
  leave: () => void
  /** Lets the editor go without asking, as once its changes are saved. */
  release: () => void
  /** The prompt asking to discard the changes, while it is open. */
  prompt: ReactNode
}

/**
 * Asks before unsaved changes are lost, however the operator leaves: the
 * editor's Cancel, any link on the page (the editor's own, the admin UI's
 * menu), a hash change from outside such as Back, or a reload or closed tab,
 * which the browser asks about itself.
 */
export function useLeaveGuard({ dirty, onClose, unsaved }: LeaveGuardOptions): LeaveGuard {
  const leaving = useSheet<Destination>()
  const { show } = leaving
  const [home] = useState(() => window.location.hash)
  // Set synchronously, as a save navigates on before the editor renders again.
  const released = useRef(false)

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent) => {
      if (!released.current) event.preventDefault()
    }
    // Captured on the document, before the admin UI's router or the editor's own links act.
    const onClick = (event: MouseEvent) => {
      const link = released.current ? undefined : leavingLink(event)
      if (link === undefined) return
      event.preventDefault()
      event.stopPropagation()
      show({ kind: 'link', href: link.href })
    }
    const held = (hash: string) => {
      if (hash !== home) show({ kind: 'arrived' })
    }
    hold = held
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', onClick, true)
    return () => {
      if (hold === held) hold = undefined
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, home, show])

  const release = () => {
    released.current = true
    hold = undefined
  }

  const discard = (to: Destination) => {
    release()
    if (to.kind === 'close') onClose()
    else if (to.kind === 'link') window.location.assign(to.href)
    // The location is already there; the shell held the view, so it is told again.
    else window.dispatchEvent(new HashChangeEvent('hashchange'))
  }

  const keepEditing = () => {
    if (leaving.value?.kind === 'arrived')
      window.history.replaceState(window.history.state, '', home)
    leaving.close()
  }

  const to = leaving.value
  return {
    leave: () => {
      if (dirty) show({ kind: 'close' })
      else onClose()
    },
    release,
    prompt: to !== undefined && (
      <ConfirmSheet
        title="Discard your changes?"
        confirmLabel="Discard changes"
        tone="danger"
        onConfirm={() => {
          discard(to)
          return Promise.resolve()
        }}
        onCancel={keepEditing}
      >
        <p>{unsaved}</p>
      </ConfirmSheet>
    )
  }
}
