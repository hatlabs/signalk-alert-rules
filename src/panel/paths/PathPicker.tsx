import { useMemo, type ReactNode, type Ref } from 'react'
import { unitLabel } from '../units'
import { Combobox, type ComboboxOption, type ComboboxSource } from './Combobox'
import type { PathEntry, PathList } from './selfPaths'

export interface PathPickerProps {
  label: string
  /** The path as typed or picked; it need not be one the server reports yet. */
  value: string
  paths: PathList
  onChange: (path: string) => void
  /**
   * The path is settled: an option was picked, Enter was pressed or focus
   * left for elsewhere in the page. Each keystroke reaches only `onChange`,
   * as a path typed passes through partial paths on its way.
   */
  onCommit?: (path: string) => void
  /** What the path means, announced with the input. */
  hint?: ReactNode
  /** Why the path is not accepted, announced with the input. */
  errors?: readonly string[]
  inputRef?: Ref<HTMLInputElement>
}

interface PathOption extends ComboboxOption {
  entry: PathEntry
}

/** Every whitespace-separated word occurs in the path or the display name. */
export function matches(entry: PathEntry, query: string): boolean {
  const haystack = `${entry.path} ${entry.displayName ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word))
}

/** A unit is worth showing when meta declares one or a display preference applies. */
function shownUnit(entry: PathEntry): string {
  return entry.units === undefined && entry.unit.si ? '' : unitLabel('absolute', entry.unit)
}

function option(entry: PathEntry): PathOption {
  return {
    value: entry.path,
    primary: entry.path,
    secondary: entry.displayName,
    trailing: shownUnit(entry),
    attributes: { 'data-path': entry.path },
    entry
  }
}

function source(paths: PathList): ComboboxSource<PathOption> {
  switch (paths.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading paths…' }
    case 'failed':
      return {
        status: 'failed',
        message: `Could not load paths: ${paths.error}. A path can still be typed.`
      }
    case 'ready':
      return { status: 'ready', options: paths.paths.map(option) }
  }
}

const filter = (option: PathOption, query: string) => matches(option.entry, query)

function matchStatus(matching: number): string {
  if (matching === 0) return 'No reported path matches; the typed path is used as is.'
  return matching === 1 ? '1 path matches' : `${String(matching)} paths match`
}

/**
 * A combobox over the reported paths. A typed path is kept as is, because a
 * rule may name a path that has not reported yet.
 */
export function PathPicker({ paths, ...props }: PathPickerProps) {
  const options = useMemo(() => source(paths), [paths])
  return <Combobox {...props} source={options} filter={filter} matchStatus={matchStatus} />
}
