import type { Ref } from 'react'
import type { TemplateSetEntry } from '../api'
import { BackIcon, ChevronIcon } from '../detail/icons'
import { templateTitle } from './templatePicks'
import { setLabel } from './templateSets'

export interface TemplateListProps {
  set: TemplateSetEntry
  backHref: string
  /** The link to a template's picker. */
  templateHref: (template: string) => string
  headingRef?: Ref<HTMLHeadingElement>
}

/** From a template, first step: a set's templates, the new ones marked. */
export function TemplateList({ set, backHref, templateHref, headingRef }: TemplateListProps) {
  const fresh = new Set(set.new)
  return (
    <div className="skar-page">
      <a className="skar-back" href={backHref}>
        <BackIcon />
        <span>Add rule</span>
      </a>
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          {setLabel(set)}
        </h2>
        {set.description !== undefined && <p className="skar-lead">{set.description}</p>}
      </div>
      <ul className="skar-rows" aria-label="Templates">
        {set.templates.map((template) => (
          <li key={template.id}>
            <a className="skar-row" href={templateHref(template.id)}>
              <span className="skar-row-main">
                <span className="skar-row-name">{templateTitle(template)}</span>
                {template.description !== undefined && (
                  <span className="skar-row-fact">{template.description}</span>
                )}
              </span>
              {fresh.has(template.id) && <span className="skar-chip skar-chip-new">New</span>}
              <span className="skar-muted">
                <ChevronIcon />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
