import { useEffect, useState } from 'react'
import type { Rule } from '../../model/rule'
import type { RuleEntry } from '../api'
import { RuleEditor, type RuleEditorProps } from './RuleEditor'

export interface EditRuleProps extends Omit<RuleEditorProps, 'editing' | 'invalid' | 'start'> {
  /** The rule's current entry; the rule list abbreviates the rule, so it is read in full. */
  entry: RuleEntry
}

type Loaded =
  { status: 'loading' } | { status: 'ready'; rule: Rule } | { status: 'failed'; error: string }

/** The editor on a stored rule, once the whole rule has been read. */
export function EditRule({ api, entry, onClose, ...rest }: EditRuleProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const { slug } = entry

  useEffect(() => {
    let cancelled = false
    api.ruleDefinition(slug).then(
      (rule) => {
        if (!cancelled) setLoaded({ status: 'ready', rule })
      },
      (err: unknown) => {
        if (!cancelled) {
          setLoaded({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, slug])

  switch (loaded.status) {
    case 'loading':
      return <div role="status">Loading the rule…</div>
    case 'failed':
      return (
        <div className="skar-banner" role="alert">
          <span>The rule could not be read: {loaded.error}</span>
          <button
            type="button"
            className="skar-btn skar-btn-ghost skar-btn-small"
            onClick={onClose}
          >
            Back
          </button>
        </div>
      )
    case 'ready':
      return (
        <RuleEditor api={api} editing={{ entry, rule: loaded.rule }} onClose={onClose} {...rest} />
      )
  }
}
