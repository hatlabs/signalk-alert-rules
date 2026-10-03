import { useEffect, useState } from 'react'
import type { PanelApi, TemplateListing, TemplateSetEntry } from '../api'
import { failureMessage } from '../failure'
import { templateTitle } from './templatePicks'

export type TemplatesState =
  | { status: 'loading' }
  | { status: 'ready'; listing: TemplateListing }
  | { status: 'failed'; error: string }

/** The built-in set is named for where it comes from, as the others are by their own name. */
export function setLabel(set: TemplateSetEntry): string {
  return set.source === 'built-in' ? 'Built in' : set.name
}

/** A set's templates in a line: how many, and their titles. */
export function setSummary(set: TemplateSetEntry): string {
  const n = set.templates.length
  const count = n === 1 ? '1 template' : `${String(n)} templates`
  return n === 0 ? count : `${count}: ${set.templates.map(templateTitle).join(', ')}`
}

/**
 * The template sets, read when `enabled` and again each time `key` changes,
 * so a view opened after another browser dismissed the notice no longer
 * shows it. A read that fails after one succeeded keeps the listing.
 */
export function useTemplates(
  api: PanelApi,
  enabled: boolean,
  key: string
): [TemplatesState, (listing: TemplateListing) => void] {
  const [state, setState] = useState<TemplatesState>({ status: 'loading' })
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    api.templates().then(
      (listing) => {
        if (!cancelled) setState({ status: 'ready', listing })
      },
      (err: unknown) => {
        if (cancelled) return
        setState((last) =>
          last.status === 'ready' ? last : { status: 'failed', error: failureMessage(err) }
        )
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, enabled, key])
  const replace = (listing: TemplateListing) => {
    setState({ status: 'ready', listing })
  }
  return [state, replace]
}
