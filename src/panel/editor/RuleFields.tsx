import { useEffect, useRef, useState } from 'react'
import { renderMessage } from '../../alerts/message'
import type { FieldError } from '../api'
import { PathPicker } from '../paths/PathPicker'
import type { PathList } from '../paths/selfPaths'
import { signalMeasure, type UnitLookup } from '../signalUnits'
import { ConditionFields, HoldField, KindField } from './ConditionFields'
import { FieldErrors, Required, SelectField, TextField, valueKindOf } from './fields'
import {
  defaultFormCondition,
  formAlertPrefix,
  hasWildcard,
  isZoneLimited,
  signalShape,
  toRule,
  type RuleForm
} from './formModel'
import { strayBraces, withGenerated } from './message'
import { MoreOptions } from './MoreOptions'
import { attachErrors, fieldPointers, underMoreOptions, type AttachedErrors } from './sections'
import { sourceOptions, withPath } from './SignalFields'
import { StepFields } from './StepFields'
import { subjectOf } from './words'

/** The server's refusal of an alert path another rule holds (src/application.ts, alertPathOverlap). */
const OVERLAP = /^makes an alert path overlapping that of rule (\S+); each rule needs its own$/

/** A form's errors, an alert path clash in the user's words, each on the field it names. */
export interface CheckedErrors {
  /** The errors as set, which change identity only when they are set again. */
  set: readonly FieldError[]
  /** The errors, the clash named. */
  errors: FieldError[]
  /** The slug of the rule holding the alert path a save clashed with. */
  holder?: string
  attached: AttachedErrors
}

/** A form's errors on their fields, an overlap refusal naming the rule that holds the alert path. */
export function checkedErrors(
  form: RuleForm,
  errors: readonly FieldError[],
  isNew: boolean,
  ruleName: (slug: string) => string | undefined
): CheckedErrors {
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
  return {
    set: errors,
    errors: named,
    ...(holder === undefined ? {} : { holder }),
    attached: attachErrors(named, fieldPointers(form, isNew))
  }
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

function sourceHint(reporting: number): string {
  if (reporting === 0) return 'Nothing reports this value yet.'
  if (reporting === 1) return 'One device reports this value.'
  return `${String(reporting)} devices report this value.`
}

export interface RuleFieldsProps {
  form: RuleForm
  /** The form changed; the generated message, name and slug already follow. */
  onChange: (form: RuleForm) => void
  /** Steps were added or removed, which shifts the index a step's errors are held by. */
  onStepsShifted: () => void
  paths: PathList
  /** The units the form opened with, which every conversion keeps. */
  units: UnitLookup
  /** The paths as last read, for their values and sources now. */
  live: UnitLookup
  isNew: boolean
  checked: CheckedErrors
  /** A listed rule's name by its slug. */
  ruleName: (slug: string) => string | undefined
  /** The link that opens a rule's editor. */
  editHref?: (slug: string) => string
}

/**
 * The editor's fields for one rule: those its choices call for, with what
 * most rules leave alone under More options, and each error on its field.
 */
export function RuleFields(props: RuleFieldsProps) {
  const { form, paths, units, live, isNew, checked: clash, ruleName, editHref } = props
  const { attached } = clash
  // Open from the start on a rule with no value yet, so the first keystroke does not close it.
  const [changingPath, setChangingPath] = useState(() => form.signal.slots[0]?.path === '')
  const [moreOpen, setMoreOpen] = useState(() => hasMoreOptions(form))
  const searchRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  // Where focus goes once the path search opens or closes, which replaces the control that had it.
  const pathFocus = useRef<'search' | 'change' | undefined>(undefined)

  useEffect(() => {
    if (pathFocus.current === 'search') searchRef.current?.focus()
    if (pathFocus.current === 'change') changeRef.current?.focus()
    pathFocus.current = undefined
  }, [changingPath])

  useEffect(() => {
    if ([...attached.byField.keys()].some((p) => underMoreOptions(form, isNew, p))) {
      setMoreOpen(true)
    }
  }, [clash.set])

  const update = (next: RuleForm) => {
    props.onChange(withGenerated(next, units))
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

  return (
    <FieldErrors.Provider value={attached.byField}>
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
              if (steps.length !== form.steps.length) props.onStepsShifted()
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
            {clash.holder !== undefined && editHref !== undefined && (
              <span className="skar-preview">
                To raise the same alert at a higher priority, add a step to{' '}
                <a href={editHref(clash.holder)}>{ruleName(clash.holder) ?? clash.holder}</a>{' '}
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
    </FieldErrors.Provider>
  )
}
