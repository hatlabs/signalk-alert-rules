/**
 * What the rule editor and the template's tabs share around their fields:
 * the wait for the paths, and the errors no field shows.
 */
import type { ReactNode } from 'react'
import type { FieldError } from '../api'
import type { PathList, PathSource } from '../paths/selfPaths'
import { useUnits, type UnitLookup } from '../signalUnits'

/** How often the values shown next to the limits are read again. */
const LIVE_POLL_MS = 5000

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
