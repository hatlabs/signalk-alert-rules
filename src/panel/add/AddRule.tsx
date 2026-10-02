import type { Ref } from 'react'
import { BackIcon } from '../detail/icons'

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

function ChevronIcon() {
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

export interface AddRuleProps {
  backHref: string
  pathHref: string
  headingRef?: Ref<HTMLHeadingElement>
}

/** Add rule: start from a data path, or, once template sets can be picked from, from a template. */
export function AddRule({ backHref, pathHref, headingRef }: AddRuleProps) {
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
      <p className="skar-hint">Adding a rule from a template is not available yet.</p>
    </div>
  )
}
