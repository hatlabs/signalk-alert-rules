import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import './Combobox.css'

export interface ComboboxOption {
  /** What picking the option puts in the input; unique among the options. */
  value: string
  primary: string
  secondary?: ReactNode
  /** Kept at the option's end, after the texts. */
  trailing: string
  attributes?: Readonly<Record<`data-${string}`, string>>
}

/** The options once they are known; until then, why there are none. */
export type ComboboxSource<O extends ComboboxOption> =
  | { status: 'loading'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'ready'; options: readonly O[] }

export interface ComboboxProps<O extends ComboboxOption> {
  label: string
  /** The text as typed or picked; it need not be an option's value. */
  value: string
  source: ComboboxSource<O>
  /** Whether an option stays listed for the text typed. */
  filter: (option: O, query: string) => boolean
  /**
   * The status while the list is open, given how many options it lists and
   * whether the text typed narrowed them.
   */
  matchStatus: (matching: number, filtered: boolean) => string
  onChange: (value: string) => void
  /**
   * The text is settled: an option was picked, Enter was pressed or focus
   * left for elsewhere in the page. Each keystroke reaches only `onChange`,
   * as a value typed passes through partial values on its way.
   */
  onCommit?: (value: string) => void
  /** What the value goes into, shown between the label and the input and announced with it. */
  context?: ReactNode
  /** What the value means, announced with the input. */
  hint?: ReactNode
  /** Why the value is not accepted, announced with the input. */
  errors?: readonly string[]
  inputRef?: Ref<HTMLInputElement>
  placeholder?: string
  /**
   * `inline` runs an option's texts on one line, wrapping as they must;
   * `stacked` puts the primary above the secondary, an empty primary leaving
   * the secondary alone, and keeps the trailing text on one line at the end.
   */
  optionLayout?: 'inline' | 'stacked'
  /**
   * Makes the field read as a picker: a click in it or on its chevron opens
   * the list with every option, the current one active.
   */
  opener?: boolean
  /** Off where the page already says the options are loading or could not be loaded. */
  progressStatus?: boolean
}

function statusText<O extends ComboboxOption>(
  source: ComboboxSource<O>,
  open: boolean,
  matching: number,
  filtered: boolean,
  matchStatus: (matching: number, filtered: boolean) => string,
  progressStatus: boolean
): string {
  switch (source.status) {
    case 'loading':
    case 'failed':
      return progressStatus ? source.message : ''
    case 'ready':
      return open ? matchStatus(matching, filtered) : ''
  }
}

/**
 * An editable combobox with list autocomplete (WAI-ARIA Authoring Practices,
 * combobox pattern): typing filters the options, the arrow keys move through
 * them, Enter picks one and Escape closes the list. Focus stays in the input
 * throughout, and the active option is conveyed by aria-activedescendant. A
 * typed value is kept as is, because it may name something that does not
 * report yet.
 */
export function Combobox<O extends ComboboxOption>({
  label,
  value,
  source,
  filter,
  matchStatus,
  onChange,
  onCommit,
  context,
  hint,
  errors = [],
  inputRef,
  placeholder,
  optionLayout = 'inline',
  opener = false,
  progressStatus = true
}: ComboboxProps<O>) {
  const id = useId()
  const inputId = `${id}-input`
  const listboxId = `${id}-listbox`
  const statusId = `${id}-status`
  const contextId = `${id}-context`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const optionId = (index: number) => `${id}-option-${String(index)}`

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  // Opened without typing, the list offers every option rather than those the text matches.
  const [browsing, setBrowsing] = useState(false)

  const all = useMemo(() => (source.status === 'ready' ? source.options : []), [source])
  const options = useMemo(
    () => (browsing ? all : all.filter((option) => filter(option, value))),
    [all, browsing, filter, value]
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
    setBrowsing(false)
  }

  const browse = (step?: 1 | -1) => {
    const current = all.findIndex((option) => option.value === value)
    const first = step === 1 ? 0 : all.length - 1
    setOpen(true)
    setBrowsing(true)
    setActive(current !== -1 ? current : step === undefined || all.length === 0 ? null : first)
  }

  const pick = (option: O) => {
    onChange(option.value)
    close()
    onCommit?.(option.value)
  }

  const move = (step: 1 | -1) => {
    if (opener && !open) {
      browse(step)
      return
    }
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
        if (!event.altKey) move(1)
        else if (opener && !open) browse()
        else setOpen(true)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (event.altKey) close()
        else move(-1)
        break
      case 'Enter': {
        const option = open && active !== null ? options[active] : undefined
        if (option !== undefined) {
          event.preventDefault()
          pick(option)
        } else {
          close()
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
  const status = statusText(source, open, options.length, !browsing, matchStatus, progressStatus)
  // Once the options are known the status speaks only while the list is open, so it floats with
  // the list: closing on blur then moves nothing below, and the click that blurred the input
  // lands where it was aimed. Loading or failed, its text is the same open or closed.
  const floating = source.status === 'ready' || !progressStatus
  const popupClass = [
    'skar-path-picker-popup',
    floating ? 'skar-path-picker-floating' : '',
    status === '' ? '' : 'skar-path-picker-popup-shown',
    // A status line alone floats over the control below, whose click would be lost to it.
    expanded ? '' : 'skar-path-picker-passive'
  ]
    .filter((c) => c !== '')
    .join(' ')

  const input = (
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
      aria-describedby={[
        context === undefined ? undefined : contextId,
        hint === undefined ? undefined : hintId,
        statusId,
        errors.length === 0 ? undefined : errorId
      ]
        .filter((d) => d !== undefined)
        .join(' ')}
      aria-invalid={errors.length === 0 ? undefined : true}
      placeholder={placeholder}
      value={value}
      onChange={(event) => {
        onChange(event.target.value)
        setOpen(true)
        setActive(null)
        setBrowsing(false)
      }}
      onClick={() => {
        if (opener && !open) browse()
      }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        close()
        // A switch to another window or tab blurs the input but leaves it the active element,
        // the value perhaps half typed; the blur once the user is back and moves on commits it.
        const away = !document.hasFocus() && document.activeElement === event.currentTarget
        if (!away) onCommit?.(value)
      }}
    />
  )

  // Outside the tab order, as in the APG example: the keyboard opens the list from the input.
  const chevron = (
    <button
      type="button"
      tabIndex={-1}
      className="skar-path-picker-chevron"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded ? listboxId : undefined}
      // Keeps focus in the input, whose blur would close the list and commit the text.
      onMouseDown={(event) => {
        event.preventDefault()
      }}
      onClick={() => {
        document.getElementById(inputId)?.focus()
        if (open) close()
        else browse()
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  )

  const labelElement = (
    <label htmlFor={inputId} className="skar-label">
      {label}
    </label>
  )

  return (
    <div className="skar-path-picker">
      {context === undefined ? (
        labelElement
      ) : (
        <div className="skar-combo-head">
          {labelElement}
          <div id={contextId}>{context}</div>
        </div>
      )}
      <div className="skar-path-picker-field">
        {opener ? (
          <div className="skar-path-picker-control">
            {input}
            {chevron}
          </div>
        ) : (
          input
        )}
        <div className={popupClass}>
          {/* Rendered even when empty, so screen readers track it as a live region from the start. */}
          <div id={statusId} role="status" className="skar-hint skar-path-picker-status">
            {status}
          </div>
          {expanded && (
            <ul id={listboxId} role="listbox" aria-label={label} className="skar-path-picker-list">
              {options.map((option, index) => (
                <li
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  {...option.attributes}
                  className={[
                    'skar-path-picker-option',
                    optionLayout === 'stacked' ? 'skar-combo-option-stacked' : '',
                    index === active ? 'skar-path-picker-active' : ''
                  ]
                    .filter((c) => c !== '')
                    .join(' ')}
                  // Keeps focus in the input, which would otherwise blur and close the list first.
                  onMouseDown={(event) => {
                    event.preventDefault()
                  }}
                  onClick={() => {
                    pick(option)
                  }}
                >
                  {optionLayout === 'stacked' ? (
                    <span className="skar-combo-option-main">
                      {option.primary !== '' && (
                        <span className="skar-combo-option-name">{option.primary}</span>
                      )}
                      {option.secondary !== undefined && (
                        <span className="skar-combo-option-detail">{option.secondary}</span>
                      )}
                    </span>
                  ) : (
                    <>
                      <span className="skar-path-picker-path">{option.primary}</span>
                      {option.secondary !== undefined && (
                        <span className="skar-path-picker-name">{option.secondary}</span>
                      )}
                    </>
                  )}
                  <span className="skar-path-picker-unit">{option.trailing}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {hint !== undefined && (
        <div id={hintId} className="skar-hint">
          {hint}
        </div>
      )}
      {errors.length > 0 && (
        <div id={errorId} className="skar-error">
          {errors.join('; ')}
        </div>
      )}
    </div>
  )
}
