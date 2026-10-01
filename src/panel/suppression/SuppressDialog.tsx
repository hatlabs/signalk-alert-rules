import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  RuleRejectedError,
  type InputSuppressionPreview,
  type PanelApi,
  type RuleEntry,
  type SuppressionRequest
} from '../api'
import { DurationInput, FieldErrors } from '../editor/fields'
import { DURATION_FACTORS, durationFrom, type DurationField } from '../editor/formModel'
import { failureMessage } from '../failure'
import { PathPicker } from '../paths/PathPicker'
import { useSelfPaths, type PathSource } from '../paths/selfPaths'
import { activeCount, MAX_NOTE_LENGTH, plural, ruleName } from '../rules/describe'

/** What a suppression is for: a rule, or an input path given or still to be picked. */
export type SuppressTarget = { kind: 'rule'; entry: RuleEntry } | { kind: 'input'; path?: string }

export type SuppressionApi = Pick<
  PanelApi,
  'suppressRule' | 'suppressInput' | 'previewInputSuppression'
>

/** What a suppression entry point needs; views without it offer no suppression. */
export interface SuppressContext {
  api: SuppressionApi
  /** The rules, to name those an input preview lists. */
  rules: RuleEntry[]
  /** The server's paths, for picking an input path. */
  paths: PathSource
  /** Called once a suppression is in force, to show its effect. */
  done: () => void
}

export interface SuppressDialogProps {
  target: SuppressTarget
  context: SuppressContext
  /** Called when the dialog closes, whether cancelled or done. */
  onClose: () => void
}

/** The longest auto-end the server accepts, in seconds. */
const MAX_AUTO_END_S = 24 * 3600
const AUTO_END = '/autoEndAfter'

type PreviewState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; preview: InputSuppressionPreview }
  | { status: 'failed'; error: string }

function frozenText(states: { instance?: string; holds: boolean }[]): string {
  const state = (holds: boolean) => (holds ? 'holding' : 'not holding')
  if (states.length === 0) return 'with no state yet'
  if (states.length === 1 && states[0].instance === undefined) {
    return `frozen as ${state(states[0].holds)}`
  }
  return `frozen as ${states.map((s) => `${s.instance ?? ''}: ${state(s.holds)}`).join(', ')}`
}

function PreviewLists({
  preview,
  rules
}: {
  preview: InputSuppressionPreview
  rules: RuleEntry[]
}) {
  const suppressesId = useId()
  const freezesId = useId()
  return (
    <>
      <h5 id={suppressesId} className="h6 mt-3">
        Rules it suppresses
      </h5>
      {preview.suppresses.length === 0 ? (
        <p>No rule reads this path as its signal.</p>
      ) : (
        <ul aria-labelledby={suppressesId}>
          {preview.suppresses.map((s) => (
            <li key={`${s.rule} ${s.instance ?? ''}`}>
              {ruleName(rules, s.origin, s.slug)}
              {s.instance === undefined ? '' : `: instance ${s.instance}`}
            </li>
          ))}
        </ul>
      )}
      <h5 id={freezesId} className="h6">
        Gated rules it freezes at their current state
      </h5>
      {preview.freezes.length === 0 ? (
        <p>No gate reads this path.</p>
      ) : (
        <ul aria-labelledby={freezesId}>
          {preview.freezes.map((f) => (
            <li key={`${f.rule} ${String(f.gate)}`}>
              {ruleName(rules, f.origin, f.slug)}: gate {f.gate + 1} {frozenText(f.states)}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The picker loads the server's paths, so it mounts only where a path is to be picked. */
function LoadedPathPicker(props: {
  source: PathSource
  value: string
  onChange: (path: string) => void
}) {
  const list = useSelfPaths(props.source)
  return (
    <PathPicker label="Input path" value={props.value} paths={list} onChange={props.onChange} />
  )
}

/** Seconds for an auto-end, or why the amount is not accepted. */
function autoEndSeconds(field: DurationField): number | string {
  const amount = Number(field.amount.trim().replace(',', '.'))
  if (field.amount.trim() === '' || !Number.isFinite(amount) || amount <= 0) {
    return 'must be a number above 0'
  }
  const seconds = Number((amount * DURATION_FACTORS[field.unit]).toPrecision(12))
  return seconds > MAX_AUTO_END_S ? 'must be at most 24 hours' : seconds
}

/**
 * Suppresses a rule or an input path, with a note and how it ends. It shows
 * what an input suppression would do, from the server's preview, before it
 * is made. It sits in the page next to its trigger, as the confirmations do:
 * the admin UI has no modal for an embedded webapp.
 */
export function SuppressDialog({ target, context, onClose }: SuppressDialogProps) {
  const { api, rules, paths } = context
  const titleId = useId()
  const noteId = useId()
  const heading = useRef<HTMLHeadingElement | null>(null)
  const fixedPath = target.kind === 'input' ? target.path : undefined
  const [path, setPath] = useState(fixedPath ?? '')
  const [preview, setPreview] = useState<PreviewState>({ status: 'none' })
  // Replacing a suppression keeps what it said unless the operator changes it.
  const replaced = target.kind === 'rule' ? target.entry.suppression : undefined
  const [note, setNote] = useState(replaced?.note ?? '')
  const [autoEnd, setAutoEnd] = useState(replaced?.autoEndAfter !== undefined)
  const [duration, setDuration] = useState<DurationField>(() =>
    replaced?.autoEndAfter === undefined
      ? { amount: '', unit: 'min' }
      : durationFrom(replaced.autoEndAfter)
  )
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string[]>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // An answer for a path edited away since, on a slow link, must not stand for the new one.
  const requested = useRef<string | undefined>(undefined)
  const loadPreview = async (of: string) => {
    requested.current = of
    setPreview({ status: 'loading' })
    try {
      const answer = await api.previewInputSuppression(of)
      if (requested.current === of) setPreview({ status: 'ready', preview: answer })
    } catch (err) {
      if (requested.current === of) setPreview({ status: 'failed', error: failureMessage(err) })
    }
  }

  useEffect(() => {
    heading.current?.focus()
    if (fixedPath !== undefined) void loadPreview(fixedPath)
    // Only on opening: a later render must neither steal focus nor ask again.
  }, [])

  const submit = async () => {
    setError(undefined)
    const seconds = autoEnd ? autoEndSeconds(duration) : undefined
    if (typeof seconds === 'string') {
      setFieldErrors(new Map([[AUTO_END, [seconds]]]))
      return
    }
    setFieldErrors(new Map())
    const request: SuppressionRequest = {
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      ...(seconds === undefined ? {} : { autoEndAfter: seconds })
    }
    setBusy(true)
    try {
      if (target.kind === 'rule') {
        await api.suppressRule(target.entry.origin, target.entry.slug, request)
      } else {
        await api.suppressInput(path.trim(), request)
      }
      onClose()
      context.done()
    } catch (err) {
      if (err instanceof RuleRejectedError) {
        setFieldErrors(new Map(err.errors.map((e) => [e.path, [e.message]])))
      }
      setError(failureMessage(err))
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation()
      onClose()
    }
  }

  const title =
    target.kind === 'rule'
      ? `Suppress ${target.entry.rule.name}`
      : fixedPath === undefined
        ? 'Suppress an input'
        : `Suppress input ${fixedPath}`
  const alerts = target.kind === 'rule' ? activeCount(target.entry) : 0
  const ready =
    target.kind === 'rule' || (preview.status === 'ready' && preview.preview.path === path.trim())

  return (
    <section
      role="dialog"
      aria-labelledby={titleId}
      className="card skar-suppress"
      onKeyDown={onKeyDown}
    >
      <form
        className="card-body"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h4 id={titleId} ref={heading} tabIndex={-1} className="h6 card-title">
          {title}
        </h4>
        {target.kind === 'rule' ? (
          <>
            <p>
              Suppressing silences this rule temporarily, for a known fault: it keeps evaluating but
              raises no alert until the suppression ends.
              {alerts > 0 && ` Suppressing it clears its ${plural(alerts, 'active alert')}.`}
              {replaced !== undefined && ' This replaces the suppression the rule has now.'}
            </p>
            <p>To turn the rule off until someone turns it on again, disable it instead.</p>
          </>
        ) : (
          <>
            <p>
              Suppressing an input silences the rules that read it temporarily, for a known fault
              such as a failed sender: they keep evaluating but raise no alert, and their active
              alerts clear. Gates that read it keep their current state.
            </p>
            <p>To turn a rule off until someone turns it on again, disable it instead.</p>
          </>
        )}
        {target.kind === 'input' && fixedPath === undefined && (
          <div className="skar-field">
            <LoadedPathPicker
              source={paths}
              value={path}
              onChange={(next) => {
                requested.current = undefined
                setPath(next)
                setPreview({ status: 'none' })
              }}
            />
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm mt-2"
              disabled={path.trim() === '' || preview.status === 'loading'}
              onClick={() => void loadPreview(path.trim())}
            >
              Show what it suppresses
            </button>
          </div>
        )}
        {target.kind === 'input' && (
          <div aria-live="polite">
            {preview.status === 'loading' && <p>Finding the rules that read this path…</p>}
            {preview.status === 'ready' && <PreviewLists preview={preview.preview} rules={rules} />}
          </div>
        )}
        {preview.status === 'failed' && (
          <div className="alert alert-danger" role="alert">
            {preview.error}
            {fixedPath !== undefined && (
              // A picked path is asked again from its own button; a given one has no other way.
              <div className="mt-2">
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={() => {
                    // The button goes while the preview loads, which would drop focus to the page.
                    heading.current?.focus()
                    void loadPreview(fixedPath)
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
        <div className="skar-field">
          <label htmlFor={noteId} className="form-label">
            Note
          </label>
          <textarea
            id={noteId}
            className="form-control"
            rows={2}
            maxLength={MAX_NOTE_LENGTH}
            aria-describedby={`${noteId}-hint`}
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
            }}
          />
          <div id={`${noteId}-hint`} className="form-text">
            The known fault, for whoever sees the suppression next.
          </div>
        </div>
        <fieldset className="skar-field">
          <legend className="form-label fs-6">Ends</legend>
          <div className="form-check">
            <input
              id={`${titleId}-manual`}
              type="radio"
              className="form-check-input"
              name={`${titleId}-end`}
              checked={!autoEnd}
              onChange={() => {
                setAutoEnd(false)
              }}
            />
            <label htmlFor={`${titleId}-manual`} className="form-check-label">
              Manually, when someone ends it
            </label>
          </div>
          <div className="form-check">
            <input
              id={`${titleId}-auto`}
              type="radio"
              className="form-check-input"
              name={`${titleId}-end`}
              checked={autoEnd}
              onChange={() => {
                setAutoEnd(true)
              }}
            />
            <label htmlFor={`${titleId}-auto`} className="form-check-label">
              By itself, once the condition has stayed clear for a while
            </label>
          </div>
          {autoEnd && (
            <FieldErrors.Provider value={fieldErrors}>
              <DurationInput
                label="Clear for"
                pointer={AUTO_END}
                value={duration}
                onChange={setDuration}
                hint={
                  target.kind === 'rule'
                    ? 'Until then the rule shows waiting for clear.'
                    : 'Every instance it suppresses must stay clear this long; until then they show waiting for clear.'
                }
              />
            </FieldErrors.Provider>
          )}
        </fieldset>
        {error !== undefined && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-sm me-2" disabled={busy || !ready}>
          Suppress
        </button>
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
      </form>
    </section>
  )
}
