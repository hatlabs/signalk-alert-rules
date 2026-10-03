/**
 * What the rule editor and the template's tabs share around their fields:
 * the wait for the paths, focus on a field in error, and the errors no field shows.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { FieldError } from '../api'
import { LIVE_POLL_MS, type PathList, type PathSource } from '../paths/selfPaths'
import { useUnits, type UnitLookup } from '../signalUnits'

/**
 * Renders the form once the paths have loaded: stored values are converted
 * to display units and a new rule's message is written from the path's
 * display name, so neither can be shown before.
 */
export function WithPaths(props: {
  source: PathSource
  children: (paths: PathList, live: UnitLookup) => ReactNode
}) {
  const { paths, units, ready } = useUnits(props.source, LIVE_POLL_MS)
  if (!ready) return <div role="status">Loading paths…</div>
  return props.children(paths, units)
}

/** The errors no field shows, as a list beside Save. */
export function UnattachedErrors({ errors }: { errors: readonly FieldError[] }) {
  if (errors.length === 0) return null
  return (
    <ul className="skar-error" role="alert">
      {errors.map((e) => (
        <li key={`${e.path} ${e.message}`}>
          {e.path === '' ? e.message : `${e.path}: ${e.message}`}
        </li>
      ))}
    </ul>
  )
}

/**
 * Moves focus to the first field in error once Save finds one. A field under
 * More options shows only once it opens, so focus waits for it to show.
 */
export function useFocusInvalid() {
  const formRef = useRef<HTMLFormElement>(null)
  const pending = useRef(false)
  useEffect(() => {
    if (!pending.current) return
    const invalidFields = [
      ...(formRef.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]') ?? [])
    ]
    const shown = invalidFields.find((el) => el.closest('details:not([open])') === null)
    if (shown === undefined && invalidFields.length > 0) return
    pending.current = false
    shown?.focus()
  })
  return {
    formRef,
    focusInvalid: () => {
      pending.current = true
    }
  }
}
