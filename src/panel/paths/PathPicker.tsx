import { useEffect, useId, useMemo, useState, type KeyboardEvent, type Ref } from 'react'
import { unitLabel } from '../units'
import type { PathEntry, PathList } from './selfPaths'
import './PathPicker.css'

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
  /** Why the path is not accepted, announced with the input. */
  errors?: readonly string[]
  inputRef?: Ref<HTMLInputElement>
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

function statusText(paths: PathList, open: boolean, matching: number): string {
  switch (paths.status) {
    case 'loading':
      return 'Loading paths…'
    case 'failed':
      return `Could not load paths: ${paths.error}. A path can still be typed.`
    case 'ready':
      if (!open) return ''
      if (matching === 0) return 'No reported path matches; the typed path is used as is.'
      return matching === 1 ? '1 path matches' : `${String(matching)} paths match`
  }
}

/**
 * An editable combobox with list autocomplete (WAI-ARIA Authoring Practices,
 * combobox pattern): typing filters the reported paths, the arrow keys move
 * through them, Enter picks one and Escape closes the list. Focus stays in the
 * input throughout, and the active option is conveyed by
 * aria-activedescendant. A typed path is kept as is, because a rule may name
 * a path that has not reported yet.
 */
export function PathPicker({
  label,
  value,
  paths,
  onChange,
  onCommit,
  errors = [],
  inputRef
}: PathPickerProps) {
  const id = useId()
  const inputId = `${id}-input`
  const listboxId = `${id}-listbox`
  const statusId = `${id}-status`
  const errorId = `${id}-error`
  const optionId = (index: number) => `${id}-option-${String(index)}`

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<number | null>(null)

  const options = useMemo(
    () => (paths.status === 'ready' ? paths.paths.filter((entry) => matches(entry, value)) : []),
    [paths, value]
  )

  useEffect(() => {
    if (open && active !== null) {
      document
        .getElementById(`${id}-option-${String(active)}`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [id, open, active])

  const close = () => {
    setOpen(false)
    setActive(null)
  }

  const pick = (entry: PathEntry) => {
    onChange(entry.path)
    close()
    onCommit?.(entry.path)
  }

  const move = (step: 1 | -1) => {
    if (options.length === 0) {
      setOpen(true)
      return
    }
    const start = step === 1 ? -1 : options.length
    const from = open && active !== null ? active : start
    setOpen(true)
    setActive((from + step + options.length) % options.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (event.altKey) setOpen(true)
        else move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (event.altKey) close()
        else move(-1)
        break
      case 'Enter': {
        const entry = open && active !== null ? options[active] : undefined
        if (entry !== undefined) {
          event.preventDefault()
          pick(entry)
        } else {
          onCommit?.(value)
        }
        break
      }
      case 'Escape':
        if (open) {
          // Handled here, so an enclosing dialog does not close as well.
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        break
    }
  }

  const expanded = open && options.length > 0
  const status = statusText(paths, open, options.length)

  return (
    <div className="skar-path-picker">
      <label htmlFor={inputId} className="skar-label">
        {label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        className={`skar-input${errors.length === 0 ? '' : ' skar-input-invalid'}`}
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listboxId : undefined}
        aria-activedescendant={expanded && active !== null ? optionId(active) : undefined}
        aria-describedby={errors.length === 0 ? statusId : `${statusId} ${errorId}`}
        aria-invalid={errors.length === 0 ? undefined : true}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          setActive(null)
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          close()
          // A switch to another window or tab blurs the input but leaves it the active element,
          // the path perhaps half typed; the blur once the user is back and moves on commits it.
          const away = !document.hasFocus() && document.activeElement === event.currentTarget
          if (!away) onCommit?.(value)
        }}
      />
      {expanded && (
        <ul id={listboxId} role="listbox" aria-label={label} className="skar-path-picker-list">
          {options.map((entry, index) => (
            <li
              key={entry.path}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              data-path={entry.path}
              className={`skar-path-picker-option${index === active ? ' skar-path-picker-active' : ''}`}
              // Keeps focus in the input, which would otherwise blur and close the list first.
              onMouseDown={(event) => {
                event.preventDefault()
              }}
              onClick={() => {
                pick(entry)
              }}
            >
              <span className="skar-path-picker-path">{entry.path}</span>
              {entry.displayName !== undefined && (
                <span className="skar-path-picker-name">{entry.displayName}</span>
              )}
              <span className="skar-path-picker-unit">{shownUnit(entry)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Rendered even when empty, so screen readers track it as a live region from the start. */}
      <div id={statusId} role="status" className="skar-hint skar-path-picker-status">
        {status}
      </div>
      {errors.length > 0 && (
        <div id={errorId} className="skar-error">
          {errors.join('; ')}
        </div>
      )}
    </div>
  )
}
