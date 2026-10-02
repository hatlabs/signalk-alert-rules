import type { Ref } from 'react'
import { BackIcon } from '../detail/icons'
import { setLabel, setSummary, type TemplatesState } from './templateSets'

function PathIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h10M4 12h16M4 18h7" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="15" cy="18" r="2" />
    </svg>
  )
}

export function ChevronIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

/** How many of a set's templates are new, as Add rule and the notice show it. */
export function NewChip({ count }: { count: number }) {
  if (count === 0) return null
  return <span className="skar-chip skar-chip-new">{`${String(count)} new`}</span>
}

export interface AddRuleProps {
  backHref: string
  pathHref: string
  templates: TemplatesState
  /** The link to a template set's templates. */
  setHref: (set: string) => string
  headingRef?: Ref<HTMLHeadingElement>
}

function TemplateSets({ templates, setHref }: Pick<AddRuleProps, 'templates' | 'setHref'>) {
  switch (templates.status) {
    case 'loading':
      return <p role="status">Loading templates…</p>
    case 'failed':
      return (
        <p className="skar-banner" role="alert">
          <span>{`The templates could not be read: ${templates.error}`}</span>
        </p>
      )
    case 'ready': {
      const { sets, problems } = templates.listing
      return (
        <>
          {sets.length === 0 ? (
            <p className="skar-hint">No template set is installed.</p>
          ) : (
            <ul className="skar-rows" aria-label="Template sets">
              {sets.map((set) => (
                <li key={set.id}>
                  <a className="skar-row" href={setHref(set.id)}>
                    <span className="skar-row-main">
                      <span className="skar-row-name">{setLabel(set)}</span>
                      <span className="skar-row-fact">{setSummary(set)}</span>
                    </span>
                    <NewChip count={set.new.length} />
                    <span className="skar-muted">
                      <ChevronIcon />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {problems.length > 0 && (
            <ul className="skar-hint skar-plain-list">
              {problems.map((p) => (
                <li key={p.source}>{`${p.source} could not be loaded: ${p.message}`}</li>
              ))}
            </ul>
          )}
        </>
      )
    }
  }
}

/** Add rule: start from a data path, or from a template of an installed set. */
export function AddRule({ backHref, pathHref, templates, setHref, headingRef }: AddRuleProps) {
  return (
    <div className="skar-page">
      <a className="skar-back" href={backHref}>
        <BackIcon />
        <span>Alert rules</span>
      </a>
      <h2 ref={headingRef} tabIndex={-1} className="skar-title">
        Add rule
      </h2>
      <ul className="skar-rows">
        <li>
          <a className="skar-row" href={pathHref}>
            <PathIcon />
            <span className="skar-row-main">
              <span className="skar-row-name">From a data path</span>
              <span className="skar-row-fact">Pick any path and choose what should alert</span>
            </span>
            <span className="skar-muted">
              <ChevronIcon />
            </span>
          </a>
        </li>
      </ul>
      <h3 className="skar-group-title">From a template</h3>
      <TemplateSets templates={templates} setHref={setHref} />
    </div>
  )
}
