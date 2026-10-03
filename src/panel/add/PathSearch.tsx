import { useId, useState, type Ref } from 'react'
import { BackIcon } from '../detail/icons'
import { matches } from '../paths/PathPicker'
import { LIVE_POLL_MS, useSelfPaths, type PathEntry, type PathSource } from '../paths/selfPaths'
import { formatValue } from '../rules/describe'

/** Rows shown at once; more words narrow the list. */
const SHOWN = 30

function SearchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  )
}

function shownValue(entry: PathEntry): string {
  return entry.value === undefined
    ? ''
    : formatValue(entry.value, { kind: 'absolute', unit: entry.unit })
}

/** A path the server has not reported, typed in full: a rule may watch it before it reports. */
function typedPath(query: string, paths: readonly PathEntry[]): string | undefined {
  const typed = query.trim()
  if (!/^[^\s.]+(\.[^\s.]+)+$/.test(typed) || paths.some((p) => p.path === typed)) return undefined
  return typed
}

export interface PathSearchProps {
  paths: PathSource
  backHref: string
  /** The link to go on with a value. */
  pathHref: (path: string) => string
  headingRef?: Ref<HTMLHeadingElement>
}

/** From a path, first step: which value the rule watches, found by its name or path. */
export function PathSearch({ paths: source, backHref, pathHref, headingRef }: PathSearchProps) {
  const id = useId()
  const [query, setQuery] = useState('')
  const list = useSelfPaths(source, LIVE_POLL_MS)
  const all = list.status === 'ready' ? list.paths : []
  const found = all.filter((entry) => matches(entry, query))
  const typed = typedPath(query, all)
  return (
    <div className="skar-page">
      <a className="skar-back" href={backHref}>
        <BackIcon />
        <span>Add rule</span>
      </a>
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        Which value?
      </h2>
      <label className="skar-label" htmlFor={`${id}-q`}>
        Search by name or path
      </label>
      <div className="skar-search">
        <SearchIcon />
        <input
          id={`${id}-q`}
          className="skar-input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint ${id}-count`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
        />
      </div>
      {list.status === 'loading' && <p role="status">Loading paths…</p>}
      {list.status === 'failed' && (
        <p className="skar-banner" role="alert">
          <span>{`Could not load paths: ${list.error}. A path can still be typed in full.`}</span>
        </p>
      )}
      {(found.length > 0 || typed !== undefined) && (
        <ul className="skar-rows" aria-label="Values">
          {found.slice(0, SHOWN).map((entry) => (
            <li key={entry.path}>
              <a className="skar-row" href={pathHref(entry.path)}>
                <span className="skar-row-main">
                  <span className="skar-row-name">{entry.displayName ?? entry.path}</span>
                  {entry.displayName !== undefined && (
                    <span className="skar-mono">{entry.path}</span>
                  )}
                </span>
                <span className="skar-row-value">{shownValue(entry)}</span>
              </a>
            </li>
          ))}
          {typed !== undefined && (
            <li>
              <a className="skar-row" href={pathHref(typed)}>
                <span className="skar-row-main">
                  <span className="skar-row-name">Use the path as typed</span>
                  <span className="skar-mono">{typed}</span>
                </span>
                <span className="skar-row-value skar-muted">not reporting yet</span>
              </a>
            </li>
          )}
        </ul>
      )}
      <p id={`${id}-count`} className="skar-hint" role="status">
        {list.status !== 'ready'
          ? ''
          : found.length === 0
            ? 'No reported value matches.'
            : found.length > SHOWN
              ? `${String(found.length)} values match; the first ${String(SHOWN)} are shown. Type more words to narrow them.`
              : ''}
      </p>
      <p id={`${id}-hint`} className="skar-hint">
        Every word must match the display name or the path, in any order. Values are live.
      </p>
    </div>
  )
}
