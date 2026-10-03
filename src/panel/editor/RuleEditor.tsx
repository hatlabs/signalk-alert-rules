import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Rule } from '../../model/rule'
import { renderMessage } from '../../alerts/message'
import { RuleRejectedError, type FieldError, type PanelApi, type RuleEntry } from '../api'
import { BackIcon } from '../detail/icons'
import { failureMessage } from '../failure'
import { PathPicker } from '../paths/PathPicker'
import type { PathList, PathSource } from '../paths/selfPaths'
import { ConfirmSheet, useSheet } from '../rules/Confirm'
import { discardedTotals, ruleDisplay } from '../rules/describe'
import { signalMeasure, useUnits, type UnitLookup } from '../signalUnits'
import { withKind, type ConditionKind } from './conditionKinds'
import { ConditionFields, HoldField, KindField } from './ConditionFields'
import { editConsequences } from './consequences'
import { FieldErrors, Required, SelectField, TextField, valueKindOf } from './fields'
import {
  defaultFormCondition,
  emptyForm,
  formAlertPrefix,
  fromBody,
  fromRule,
  hasWildcard,
  isZoneLimited,
  signalShape,
  toRule,
  type RuleForm
} from './formModel'
import { strayBraces, withGenerated } from './message'
import { MoreOptions } from './MoreOptions'
import { attachErrors, fieldPointers, saveHint, underMoreOptions } from './sections'
import { sourceOptions, withPath } from './SignalFields'
import { StepFields } from './StepFields'
import { subjectOf } from './words'

/** How often the values shown next to the limits are read again. */
const LIVE_POLL_MS = 5000

/** The server's refusal of an alert path another rule holds (src/application.ts, alertPathOverlap). */
const OVERLAP = /^makes an alert path overlapping that of rule (\S+); each rule needs its own$/

export interface RuleEditorProps {
  api: PanelApi
  paths: PathSource
  /** The rule to edit, with its current entry; absent for a new rule. */
  editing?: { entry: RuleEntry; rule: Rule }
  /** A stored rule that does not run, to fix: its slug, name, body as stored and errors. */
  invalid?: { slug: string; name: string; body: unknown; errors: FieldError[] }
  /** A new rule's value and condition kind, as From a path chose them. */
  start?: { path: string; kind: ConditionKind }
  /** Where the back link goes, and what it says. */
  back: { href: string; label: string }
  /** A listed rule's name by its slug, for the rule whose alert path a save clashes with. */
  ruleName?: (slug: string) => string | undefined
  /** The link that opens a rule's editor. */
  editHref?: (slug: string) => string
  /** The rule was saved; the form is done. */
  onSaved: (entry: RuleEntry) => void
  /** The operator left the form, having confirmed any unsaved changes are lost. */
  onClose: () => void
}

/**
 * The rule editor: one form whose fields follow the choices made, with what
 * most rules leave alone under More options. Stored values are converted to
 * display units and a new rule's message is written from the path's display
 * name, so the form waits for the paths to load.
 */
export function RuleEditor(props: RuleEditorProps) {
  const { paths, units, ready } = useUnits(props.paths, LIVE_POLL_MS)
  if (!ready) return <div role="status">Loading paths…</div>
  return <EditorForm {...props} paths={paths} live={units} />
}

interface FormProps extends Omit<RuleEditorProps, 'paths'> {
  paths: PathList
  /** The paths as last read, for their values and sources now. */
  live: UnitLookup
}

function initialForm(props: FormProps, units: UnitLookup): RuleForm {
  const { editing, invalid, start } = props
  if (editing !== undefined) return fromRule(editing.rule, units)
  // Saved to the slug it is stored under, which the form does not show for an edit.
  if (invalid !== undefined) return { ...fromBody(invalid.body, units), slug: invalid.slug }
  if (start === undefined) return emptyForm()
  const form = withKind(emptyForm(), start.kind)
  form.signal.slots[0] = { path: start.path, source: '' }
  return withGenerated(form, units)
}

function hasMoreOptions(form: RuleForm): boolean {
  const d = form.detector
  return (
    d.hysteresis !== '' ||
    d.clearDuration.amount !== '' ||
    form.latching ||
    form.gates.length > 0 ||
    form.signal.mode === 'combine' ||
    hasWildcard(form.signal) ||
    isZoneLimited(d)
  )
}

/** An overlap refusal in the user's words, naming the rule that holds the alert path. */
function withNamedClash(
  errors: FieldError[],
  ruleName: (slug: string) => string | undefined
): { errors: FieldError[]; holder?: string } {
  let holder: string | undefined
  const named = errors.map((e) => {
    const overlap = e.path === '/condition' ? OVERLAP.exec(e.message) : null
    if (overlap === null) return e
    const slug = overlap[1]
    holder = slug
    const name = ruleName(slug) ?? slug
    return {
      ...e,
      message: `Another rule uses this alert path: ${name}. Give this condition its own name.`
    }
  })
  return { errors: named, ...(holder === undefined ? {} : { holder }) }
}

/** Where the operator asked to go: a location hash, or out of the form. */
type Destination = { hash: string } | 'close'

function EditorForm(props: FormProps) {
  const { api, paths, live, editing, invalid, back, onSaved, onClose } = props
  const ruleName = props.ruleName ?? (() => undefined)
  const isNew = editing === undefined && invalid === undefined
  // The form's numbers are text in the units it opened with, so every
  // conversion keeps those units; a unit reported later would rescale them.
  const [units] = useState(live)
  const [initial] = useState<RuleForm>(() => initialForm(props, units))
  const [form, setForm] = useState<RuleForm>(initial)
  const [errors, setErrors] = useState<FieldError[]>(invalid?.errors ?? [])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Held with the form it was previewed for: a field changed under the
  // confirmation would otherwise be dropped from the rule it stores.
  const confirming = useSheet<{ form: RuleForm; rule: Rule; lines: string[] }>()
  const pending = confirming.value
  // Where the user asked to go while the form had unsaved changes.
  const leaving = useSheet<Destination>()
  // Open from the start on a rule with no value yet, so the first keystroke does not close it.
  const [changingPath, setChangingPath] = useState(() => initial.signal.slots[0]?.path === '')
  const [moreOpen, setMoreOpen] = useState(() => hasMoreOptions(initial))
  const headingRef = useRef<HTMLHeadingElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  // Where focus goes once the path search opens or closes, which replaces the control that had it.
  const pathFocus = useRef<'search' | 'change' | undefined>(undefined)
  // Set by a failed save; the field in error may only show once More options opens.
  const focusInvalid = useRef(false)

  // The form only ever opens on the operator's action and replaces the view
  // that held focus, so focus moves to its heading.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial])
  useEffect(() => {
    if (!dirty) return undefined
    // The browser asks before a reload or closing the tab drops the changes.
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty])

  useEffect(() => {
    if (pathFocus.current === 'search') searchRef.current?.focus()
    if (pathFocus.current === 'change') changeRef.current?.focus()
    pathFocus.current = undefined
  }, [changingPath])

  useEffect(() => {
    if (!focusInvalid.current) return
    const invalidFields = [
      ...(formRef.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]') ?? [])
    ]
    const shown = invalidFields.find((el) => el.closest('details:not([open])') === null)
    if (shown === undefined && invalidFields.length > 0) return
    focusInvalid.current = false
    shown?.focus()
  })
  const showErrors = (next: FieldError[]) => {
    setErrors(next)
    focusInvalid.current = true
  }

  const clash = withNamedClash(errors, ruleName)
  const attached = attachErrors(clash.errors, fieldPointers(form, isNew))
  useEffect(() => {
    if ([...attached.byField.keys()].some((p) => underMoreOptions(form, isNew, p))) {
      setMoreOpen(true)
    }
  }, [errors])

  const update = (next: RuleForm) => {
    setForm(withGenerated(next, units))
  }
  const measure = signalMeasure(signalShape(form.signal), units)
  const single = form.signal.mode === 'single'
  const slot = form.signal.slots[0] ?? { path: '', source: '' }
  const entry = single ? live.entry(slot.path) : undefined
  const wildcard = hasWildcard(form.signal)
  // A wildcard's first instance is not the rule's value, nor one input a combination's.
  const liveValue = single && !wildcard ? entry?.value : undefined
  const valueKind = single ? valueKindOf(entry?.value) : 'number'
  const pathErrors = attached.byField.get('/signal/path') ?? []

  const refused = (err: unknown) => {
    if (err instanceof RuleRejectedError && err.errors.length > 0) showErrors(err.errors)
    else setFailure(failureMessage(err))
  }

  const store = async (rule: Rule) => {
    const saved =
      editing !== undefined
        ? await api.updateRule(editing.entry.slug, rule)
        : invalid !== undefined
          ? await api.updateRule(invalid.slug, rule)
          : await api.createRule(rule)
    onSaved(saved)
  }

  const save = async () => {
    setFailure(undefined)
    const result = toRule(form, units)
    if (!result.ok) {
      showErrors(result.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      if (editing !== undefined) {
        const preview = await api.previewRule(editing.entry.slug, result.rule)
        const totals = discardedTotals(
          editing.entry,
          ruleDisplay(editing.entry.rule, units).total
        ).map(({ name, total }) => (name === '' ? total : `${name}: ${total}`))
        const lines = editConsequences(preview, totals)
        if (lines.length > 0) {
          confirming.show({ form, rule: result.rule, lines })
          return
        }
      }
      await store(result.rule)
    } catch (err) {
      refused(err)
    } finally {
      setBusy(false)
    }
  }

  /** Leaves at once without changes, else asks first. */
  const leave = (to: Destination) => {
    if (dirty) leaving.show(to)
    else if (to === 'close') onClose()
    else window.location.hash = to.hash
  }
  const guarded = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!dirty) return
    event.preventDefault()
    leaving.show({ hash: href })
  }

  const title =
    editing !== undefined
      ? `Edit “${editing.entry.rule.name}”`
      : invalid !== undefined
        ? `Fix “${invalid.name}”`
        : 'New rule'
  const defaultCondition = defaultFormCondition(form)
  const stray = strayBraces(form.message)
  const preview = (() => {
    const result = toRule(form, units)
    if (!result.ok || form.message === '') return undefined
    return renderMessage(result.rule, {
      step: 0,
      ...(liveValue === undefined ? {} : { value: liveValue }),
      ...(entry?.units === undefined ? {} : { units: entry.units })
    })
  })()
  const hint = saveHint(clash.errors, form)

  return (
    <FieldErrors.Provider value={attached.byField}>
      <div className="skar-editor">
        <a className="skar-back" href={back.href} onClick={guarded(back.href)}>
          <BackIcon />
          <span>{back.label}</span>
        </a>
        <h2 ref={headingRef} tabIndex={-1} className="skar-title">
          {title}
        </h2>
        {invalid !== undefined && (
          <p className="skar-hint">
            The stored rule is not valid, so it does not run. Fix the fields marked below and save.
          </p>
        )}
        <div className="skar-editor-grid">
          <form
            ref={formRef}
            className="skar-card skar-editor-form"
            aria-label={title}
            noValidate
            // Enter in a field, or a tablet keyboard's Go, submits a form; a
            // rule half edited would be saved, so only the button saves.
            onSubmit={(event) => {
              event.preventDefault()
            }}
          >
            <TextField
              label="Name"
              pointer="/name"
              required
              value={form.name}
              onChange={(name) => {
                update({ ...form, name, nameFollows: false })
              }}
            />

            {single ? (
              <div className="skar-field">
                <span className="skar-label">
                  Watches
                  <Required />
                </span>
                {changingPath || slot.path === '' || pathErrors.length > 0 ? (
                  <div className="skar-watch-change">
                    <PathPicker
                      label="Search by name or path"
                      value={slot.path}
                      paths={paths}
                      errors={pathErrors}
                      inputRef={searchRef}
                      onChange={(path) => {
                        update({
                          ...form,
                          signal: { ...form.signal, slots: [withPath(slot, path, live)] }
                        })
                      }}
                    />
                    {slot.path !== '' && (
                      <div>
                        <button
                          type="button"
                          className="skar-btn skar-btn-ghost skar-btn-small"
                          onClick={() => {
                            pathFocus.current = 'change'
                            setChangingPath(false)
                          }}
                        >
                          Done
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="skar-watch">
                    <div className="skar-row-main">
                      <span>{subjectOf(form.signal, units)}</span>
                      <span className="skar-mono">{slot.path}</span>
                    </div>
                    <button
                      ref={changeRef}
                      type="button"
                      className="skar-link-btn skar-link-small"
                      aria-label="Change the value to watch"
                      onClick={() => {
                        pathFocus.current = 'search'
                        setChangingPath(true)
                      }}
                    >
                      Change
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="skar-field">
                <span className="skar-label">Watches</span>
                <div className="skar-watch">
                  <div className="skar-row-main">
                    <span>{subjectOf(form.signal, units)}</span>
                    <span className="skar-hint">Set under More options.</span>
                  </div>
                </div>
              </div>
            )}

            {single && (
              <SelectField
                label="Source"
                pointer="/signal/source"
                value={slot.source}
                options={sourceOptions(slot, live)}
                hint={sourceHint(entry?.sources?.length ?? 0)}
                onChange={(source) => {
                  update({ ...form, signal: { ...form.signal, slots: [{ ...slot, source }] } })
                }}
              />
            )}

            <KindField
              form={form}
              onChange={update}
              measure={measure}
              valueKind={valueKind}
              value={liveValue}
            />
            <ConditionFields
              form={form}
              onChange={update}
              measure={measure}
              valueKind={valueKind}
              value={liveValue}
            />
            {form.detector.type !== '' &&
              (isZoneLimited(form.detector) ? (
                <div className="skar-field">
                  <span className="skar-label">Priority and limit</span>
                  <p className="skar-hint">Set by the value&apos;s zones, under More options.</p>
                </div>
              ) : (
                <StepFields
                  form={form}
                  onChange={(steps) => {
                    // A step's errors are held by its index, which a removed or added step shifts.
                    if (steps.length !== form.steps.length) {
                      setErrors(errors.filter((e) => !e.path.startsWith('/detector/steps/')))
                    }
                    update({ ...form, steps })
                  }}
                  measure={measure}
                  units={units}
                  valueKind={valueKind}
                  value={liveValue}
                />
              ))}
            <HoldField form={form} onChange={update} />

            <TextField
              label="Message"
              pointer="/message"
              required
              value={form.message}
              hint={
                <>
                  {form.messageFollows && 'Written from the rule until you edit it. '}
                  {
                    '{value} is the value when it alerts, {limit} the limit reached, {duration} how long it held'
                  }
                  {wildcard ? ' and {instance} the instance.' : '.'}
                  {stray.length > 0 && (
                    <span className="skar-warning">
                      {` ${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} sent as written.`}
                    </span>
                  )}
                  {preview !== undefined && (
                    <span className="skar-preview">{`Sends now: “${preview}”`}</span>
                  )}
                </>
              }
              onChange={(message) => {
                update({ ...form, message, messageFollows: false })
              }}
            />

            <TextField
              label="Condition name"
              pointer="/condition"
              required={defaultCondition === undefined}
              prefix={formAlertPrefix(form)}
              value={form.condition}
              // Shown, never filled in: a keystroke after a cleared name would extend the default.
              placeholder={defaultCondition}
              hint={
                <>
                  {form.condition !== ''
                    ? 'Kept as written. Clear it to follow the value and the condition again.'
                    : defaultCondition === undefined
                      ? 'There is no default name here; type one.'
                      : 'Follows the value and the condition until you type a name.'}
                  {clash.holder !== undefined && props.editHref !== undefined && (
                    <span className="skar-preview">
                      To raise the same alert at a higher priority, add a step to{' '}
                      <a
                        href={props.editHref(clash.holder)}
                        onClick={guarded(props.editHref(clash.holder))}
                      >
                        {ruleName(clash.holder) ?? clash.holder}
                      </a>{' '}
                      instead.
                    </span>
                  )}
                </>
              }
              onChange={(condition) => {
                update({ ...form, condition })
              }}
            />

            <MoreOptions
              form={form}
              onChange={update}
              measure={measure}
              paths={paths}
              units={units}
              isNew={isNew}
              open={moreOpen}
              onToggle={setMoreOpen}
            />
          </form>
          {/* The history chart's place, beside the form on a tablet. */}
        </div>

        <div className="skar-editor-actions">
          <div className="skar-editor-status">
            {attached.unattached.length > 0 && (
              <ul className="skar-error" role="alert">
                {attached.unattached.map((e) => (
                  <li key={`${e.path} ${e.message}`}>
                    {e.path === '' ? e.message : `${e.path}: ${e.message}`}
                  </li>
                ))}
              </ul>
            )}
            {failure !== undefined && (
              <p className="skar-error" role="alert">
                {failure}
              </p>
            )}
            {hint !== undefined && (
              <p className="skar-hint" role="status">
                {hint}
              </p>
            )}
          </div>
          <div className="skar-editor-buttons">
            <button
              type="button"
              className="skar-btn skar-btn-ghost"
              disabled={busy}
              onClick={() => {
                leave('close')
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="skar-btn skar-btn-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {isNew ? 'Create rule' : 'Save'}
            </button>
          </div>
        </div>

        {pending?.form === form && (
          <ConfirmSheet
            title={`Save “${form.name}”?`}
            confirmLabel="Save"
            tone="dark"
            onConfirm={async () => {
              try {
                await store(pending.rule)
              } catch (err) {
                if (!(err instanceof RuleRejectedError) || err.errors.length === 0) throw err
                confirming.close(false)
                showErrors(err.errors)
              }
            }}
            onCancel={() => {
              confirming.close()
            }}
          >
            {pending.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </ConfirmSheet>
        )}
        {leaving.value !== undefined && (
          <ConfirmSheet
            title="Discard your changes?"
            confirmLabel="Discard changes"
            tone="danger"
            onConfirm={() => {
              const to = leaving.value
              if (to === 'close') onClose()
              else if (to !== undefined) window.location.hash = to.hash
              return Promise.resolve()
            }}
            onCancel={() => {
              leaving.close()
            }}
          >
            <p>The changes to this rule have not been saved.</p>
          </ConfirmSheet>
        )}
      </div>
    </FieldErrors.Provider>
  )
}

function sourceHint(reporting: number): string {
  if (reporting === 0) return 'Nothing reports this value yet.'
  if (reporting === 1) return 'One device reports this value.'
  return `${String(reporting)} devices report this value.`
}
