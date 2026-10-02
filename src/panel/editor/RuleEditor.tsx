import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Rule } from '../../model/rule'
import { RuleRejectedError, type FieldError, type PanelApi, type RuleEntry } from '../api'
import { failureMessage } from '../failure'
import type { PathList, PathSource } from '../paths/selfPaths'
import { Confirm } from '../rules/Confirm'
import { discardedTotals, ruleDisplay } from '../rules/describe'
import { signalMeasure, useUnits, type UnitLookup } from '../signalUnits'
import { editConsequences } from './consequences'
import {
  AdvancedFields,
  DetectFields,
  LaterStepsNotice,
  LimitSectionFields,
  TimingFields
} from './DetectorFields'
import { Field, FieldErrors, SelectField, TextField } from './fields'
import {
  defaultFormCondition,
  emptyForm,
  emptyGate,
  FIRST_STEP,
  formAlertPrefix,
  fromRule,
  hasWildcard,
  isZoneLimited,
  keptLaterSteps,
  MAX_GATES,
  PRIORITY_LEVELS,
  signalShape,
  slugify,
  toRule,
  type DetectorForm,
  type RuleForm
} from './formModel'
import { GateFields } from './GateFields'
import {
  attachErrors,
  fieldPointers,
  revealedSections,
  sectionApplies,
  SECTIONS,
  type SectionId
} from './sections'
import { SignalFields } from './SignalFields'

const INSTANCE_PLACEHOLDER = '{instance}'
const ADVANCED_POINTERS = ['/detector/hysteresis', '/detector/clearDuration', '/latching']

const PRIORITIES = PRIORITY_LEVELS.map((value) => ({ value, label: value }))

const HEADINGS: Readonly<Record<SectionId, string>> = {
  inputs: 'Inputs',
  detect: 'What to detect',
  limit: 'Limit',
  timing: 'Timing',
  advanced: 'Advanced',
  message: 'Priority and message',
  gates: 'Gates',
  name: 'Name'
}

export interface RuleEditorProps {
  api: PanelApi
  paths: PathSource
  /** The rule to edit, with its current entry; absent for a new rule. */
  editing?: { entry: RuleEntry; rule: Rule }
  /** The rule was saved; the form is done. */
  onSaved: (entry: RuleEntry) => void
  /** The operator left the form, having confirmed any unsaved changes are lost. */
  onClose: () => void
}

/**
 * The rule authoring form: one scrolling form whose sections a new rule
 * reveals in order and an edited rule shows at once. Stored values are
 * converted to display units, so an edit waits for the units to load.
 */
export function RuleEditor(props: RuleEditorProps) {
  const { paths, units, ready } = useUnits(props.paths)
  if (props.editing !== undefined && !ready) return <div role="status">Loading paths…</div>
  return <EditorForm {...props} paths={paths} units={units} />
}

interface FormProps extends Omit<RuleEditorProps, 'paths'> {
  paths: PathList
  units: UnitLookup
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const headingId = useId()
  // The name section holds a single field labelled Name; a heading of the
  // same word straight above it would read as a stray label.
  if (id === 'name') {
    return (
      <section className="skar-form-section" aria-label={HEADINGS[id]}>
        {children}
      </section>
    )
  }
  return (
    <section className="skar-form-section" aria-labelledby={headingId}>
      <h4 id={headingId} className="skar-section-heading">
        {HEADINGS[id]}
      </h4>
      {children}
    </section>
  )
}

/** Remembers the furthest section reached, so a later edit never hides a section again. */
function useRevealed(form: RuleForm, units: UnitLookup, all: boolean): Set<SectionId> {
  const reached = SECTIONS.indexOf(revealedSections(form, units).at(-1) ?? 'inputs')
  const [furthest, setFurthest] = useState(all ? SECTIONS.length - 1 : reached)
  if (reached > furthest) setFurthest(reached)
  return new Set(
    SECTIONS.filter((id, i) => i <= Math.max(furthest, reached) && sectionApplies(form, id))
  )
}

function hasAdvancedValues(d: DetectorForm, latching: boolean): boolean {
  return d.hysteresis !== '' || d.clearDuration.amount !== '' || latching
}

function EditorForm({ api, paths, units, editing, onSaved, onClose }: FormProps) {
  const [initial] = useState<RuleForm>(() =>
    editing === undefined ? emptyForm() : fromRule(editing.rule, units)
  )
  const [form, setForm] = useState<RuleForm>(initial)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Held with the form it was previewed for: a field changed under the
  // confirmation would otherwise be dropped from the rule it stores.
  const [pending, setPending] = useState<
    { form: RuleForm; rule: Rule; lines: string[] } | undefined
  >(undefined)
  const [leaving, setLeaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(
    editing !== undefined && hasAdvancedValues(initial.detector, initial.latching)
  )
  const messageRef = useRef<HTMLTextAreaElement>(null)
  // Each gate keeps what it remembers, such as the instance its wildcard
  // replaced, only while its key stays with it through a removal.
  const gateCount = useRef(initial.gates.length)
  const [gateKeys, setGateKeys] = useState(() => initial.gates.map((_, i) => i))
  const headingRef = useRef<HTMLHeadingElement>(null)

  // The form only ever opens on the operator's action and replaces the view
  // that held focus, so focus moves to its heading; an edit gets here only
  // once its rule has loaded.
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

  const shown = useRevealed(form, units, editing !== undefined)
  const attached = attachErrors(errors, fieldPointers(form))
  useEffect(() => {
    if (ADVANCED_POINTERS.some((p) => attached.byField.has(p))) setAdvancedOpen(true)
  }, [errors])

  const update = (patch: Partial<RuleForm>) => {
    setForm((f) => ({ ...f, ...patch }))
  }
  const updateDetector = (patch: Partial<DetectorForm>) => {
    setForm((f) => ({ ...f, detector: { ...f.detector, ...patch } }))
  }
  const measure = signalMeasure(signalShape(form.signal), units)
  const singlePath = form.signal.mode === 'single' ? form.signal.slots[0]?.path : undefined
  const wildcard = hasWildcard(form.signal)

  const refused = (err: unknown) => {
    if (err instanceof RuleRejectedError && err.errors.length > 0) setErrors(err.errors)
    else setFailure(failureMessage(err))
  }

  const store = async (rule: Rule) => {
    const entry =
      editing === undefined
        ? await api.createRule(rule)
        : await api.updateRule(editing.entry.slug, rule)
    onSaved(entry)
  }

  const save = async () => {
    setFailure(undefined)
    const result = toRule(form, units)
    if (!result.ok) {
      setErrors(result.errors)
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
          setPending({ form, rule: result.rule, lines })
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

  const insertInstance = () => {
    const area = messageRef.current
    const start = area?.selectionStart ?? form.message.length
    const end = area?.selectionEnd ?? start
    update({
      message: form.message.slice(0, start) + INSTANCE_PLACEHOLDER + form.message.slice(end)
    })
  }

  return (
    <FieldErrors.Provider value={attached.byField}>
      <form
        className="skar-rule-form"
        aria-label={editing === undefined ? 'New rule' : `Edit ${editing.entry.rule.name}`}
        noValidate
        // Enter in a field, or a tablet keyboard's Go, submits a form; a rule
        // half edited would be saved and the form closed, so only the button saves.
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <h3 ref={headingRef} tabIndex={-1} className="h5">
          {editing === undefined ? 'New rule' : `Edit ${editing.entry.rule.name}`}
        </h3>

        <Section id="inputs">
          <SignalFields
            label="Input"
            at="/signal"
            signal={form.signal}
            paths={paths}
            units={units}
            onChange={(signal) => {
              update({ signal })
            }}
          />
        </Section>

        {shown.has('detect') && (
          <Section id="detect">
            <DetectFields detector={form.detector} update={updateDetector} measure={measure} />
          </Section>
        )}

        {shown.has('limit') && (
          <Section id="limit">
            <LimitSectionFields
              detector={form.detector}
              update={updateDetector}
              measure={measure}
              signalPath={singlePath}
              paths={paths}
              units={units}
            />
          </Section>
        )}

        {shown.has('timing') && (
          <Section id="timing">
            <TimingFields detector={form.detector} update={updateDetector} measure={measure} />
          </Section>
        )}

        {shown.has('advanced') && (
          <details
            className="skar-form-section"
            open={advancedOpen}
            onToggle={(event) => {
              setAdvancedOpen(event.currentTarget.open)
            }}
          >
            <summary className="skar-section-heading">{HEADINGS.advanced}</summary>
            <AdvancedFields
              detector={form.detector}
              update={updateDetector}
              measure={measure}
              latching={form.latching}
              setLatching={(latching) => {
                update({ latching })
              }}
            />
          </details>
        )}

        {shown.has('message') && (
          <Section id="message">
            {isZoneLimited(form.detector) ? (
              <p className="form-text">
                The priority follows the zone level the input is in: alert is caution, warn is
                warning, alarm is alarm and emergency is emergency.
              </p>
            ) : (
              <SelectField
                label="Priority"
                pointer={`${FIRST_STEP}/priority`}
                value={form.priority}
                options={PRIORITIES}
                onChange={(priority) => {
                  update({ priority })
                }}
              />
            )}
            <LaterStepsNotice
              detector={form.detector}
              steps={keptLaterSteps(form)}
              measure={measure}
            />
            <Field
              label="Message"
              pointer="/message"
              hint={
                wildcard
                  ? `${INSTANCE_PLACEHOLDER} is replaced with the instance's name.`
                  : undefined
              }
            >
              {(control) => (
                <textarea
                  {...control}
                  ref={messageRef}
                  className="form-control form-control-sm"
                  rows={2}
                  value={form.message}
                  onChange={(e) => {
                    update({ message: e.target.value })
                  }}
                />
              )}
            </Field>
            {wildcard && (
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                onClick={insertInstance}
              >
                Insert {INSTANCE_PLACEHOLDER}
              </button>
            )}
          </Section>
        )}

        {shown.has('gates') && (
          <Section id="gates">
            <p className="form-text">
              Optional. The rule is in use only while every gate holds; a gate that stops holding
              clears the rule&apos;s alert.
            </p>
            {form.gates.map((gate, i) => (
              <GateFields
                key={gateKeys[i]}
                index={i}
                gate={gate}
                paths={paths}
                units={units}
                onChange={(next) => {
                  update({ gates: form.gates.map((g, n) => (n === i ? next : g)) })
                }}
                onRemove={() => {
                  update({ gates: form.gates.filter((_, n) => n !== i) })
                  setGateKeys((keys) => keys.filter((_, n) => n !== i))
                }}
              />
            ))}
            {form.gates.length < MAX_GATES && (
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                onClick={() => {
                  update({ gates: [...form.gates, emptyGate()] })
                  const key = gateCount.current
                  gateCount.current = key + 1
                  setGateKeys((keys) => [...keys, key])
                }}
              >
                Add gate
              </button>
            )}
          </Section>
        )}

        {shown.has('name') && (
          <Section id="name">
            <TextField
              label="Name"
              pointer="/name"
              value={form.name}
              onChange={(name) => {
                update(
                  form.slugFollowsName && editing === undefined
                    ? { name, slug: slugify(name) }
                    : { name }
                )
              }}
            />
            <TextField
              label="Slug"
              pointer="/slug"
              value={form.slug}
              readOnly={editing !== undefined}
              hint={
                editing === undefined
                  ? 'Identifies the rule in links. Fixed once the rule is saved.'
                  : 'Fixed.'
              }
              onChange={(slug) => {
                update({ slug, slugFollowsName: false })
              }}
            />
            <TextField
              label="Alert path"
              pointer="/condition"
              prefix={formAlertPrefix(form)}
              value={form.condition}
              // Shown, never filled in: a keystroke after a cleared name would extend the default.
              placeholder={defaultFormCondition(form)}
              hint={`The input gives the path; the last segment names the condition.${
                wildcard ? ' * stands for each instance.' : ''
              } ${
                form.condition !== ''
                  ? 'Kept as written. Clear it to follow the input and detector again.'
                  : defaultFormCondition(form) === undefined
                    ? 'There is no default name here; type one.'
                    : 'Follows the input and detector until you type a name.'
              } A new name on a saved rule clears the alert at the old path.`}
              onChange={(condition) => {
                update({ condition })
              }}
            />
          </Section>
        )}

        {attached.unattached.length > 0 && (
          <div className="alert alert-danger" role="alert">
            <ul className="mb-0">
              {attached.unattached.map((e) => (
                <li key={`${e.path} ${e.message}`}>
                  {e.path === '' ? e.message : `${e.path}: ${e.message}`}
                </li>
              ))}
            </ul>
          </div>
        )}
        {errors.length > 0 && attached.unattached.length === 0 && (
          <div className="alert alert-danger" role="alert">
            The rule was not saved; the fields marked above need attention.
          </div>
        )}
        {failure !== undefined && (
          <div className="alert alert-danger" role="alert">
            {failure}
          </div>
        )}

        {pending?.form === form && (
          <Confirm
            title={`Save ${form.name}?`}
            confirmLabel="Save"
            onConfirm={async () => {
              try {
                await store(pending.rule)
              } catch (err) {
                if (!(err instanceof RuleRejectedError) || err.errors.length === 0) throw err
                setPending(undefined)
                setErrors(err.errors)
              }
            }}
            onCancel={() => {
              setPending(undefined)
            }}
          >
            {pending.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Confirm>
        )}
        {leaving && (
          <Confirm
            title="Discard your changes?"
            confirmLabel="Discard changes"
            onConfirm={() => {
              onClose()
              return Promise.resolve()
            }}
            onCancel={() => {
              setLeaving(false)
            }}
          >
            <p className="mb-0">The changes to this rule have not been saved.</p>
          </Confirm>
        )}

        <div className="skar-actions">
          {shown.has('name') && (
            <button
              type="button"
              className="btn btn-primary btn-sm me-2"
              disabled={busy}
              onClick={() => void save()}
            >
              {editing === undefined ? 'Create rule' : 'Save changes'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            disabled={busy}
            onClick={() => {
              if (dirty) setLeaving(true)
              else onClose()
            }}
          >
            Cancel
          </button>
          {editing === undefined && shown.has('name') && (
            <div className="form-text">The rule starts enabled once created.</div>
          )}
        </div>
      </form>
    </FieldErrors.Provider>
  )
}
