import { useState } from 'react'
import type { TemplateListing } from '../api'
import { failureMessage } from '../failure'

export interface TemplatesNoticeProps {
  listing: TemplateListing
  /** The link to a set's templates, or to Add rule for several sets. */
  setHref: (set: string) => string
  addHref: string
  /** Dismisses the templates shown, for everyone; answers the listing after. */
  dismiss: (shown: Record<string, string[]>) => Promise<TemplateListing>
}

function templatesWord(n: number): string {
  return n === 1 ? '1 new template' : `${String(n)} new templates`
}

/**
 * Template sets with templates nobody has dismissed yet. Dismissing names the
 * templates shown, so one installed since is announced in turn.
 */
export function TemplatesNotice({ listing, setHref, addHref, dismiss }: TemplatesNoticeProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const fresh = listing.sets.filter((s) => s.new.length > 0)
  const only = fresh.at(0)
  if (only === undefined) return null
  const count = fresh.reduce((n, s) => n + s.new.length, 0)
  const shown = Object.fromEntries(fresh.map((s) => [s.id, s.new]))
  return (
    <div className="skar-banner skar-banner-info" role="status">
      <span>
        {fresh.length === 1 ? (
          <>
            {`${only.name} offers `}
            <strong>{templatesWord(count)}</strong>. <a href={setHref(only.id)}>See them</a>
          </>
        ) : (
          <>
            {`${String(fresh.length)} template sets offer `}
            <strong>{templatesWord(count)}</strong>. <a href={addHref}>See them</a>
          </>
        )}
        {error !== undefined && <span className="skar-error">{` ${error}`}</span>}
      </span>
      <button
        type="button"
        className="skar-btn skar-btn-ghost skar-btn-small"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          dismiss(shown).then(
            () => {
              setBusy(false)
            },
            (err: unknown) => {
              setBusy(false)
              setError(`The notice could not be dismissed: ${failureMessage(err)}`)
            }
          )
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
