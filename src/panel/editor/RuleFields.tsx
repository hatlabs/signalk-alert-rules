import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { renderMessage } from '../../alerts/message'
import type { FieldError } from '../api'
import { PathPicker } from '../paths/PathPicker'
import type { PathList } from '../paths/selfPaths'
import { matchedInstances, signalMeasure, type UnitLookup } from '../signalUnits'
import { ConditionFields, HoldField, KindField } from './ConditionFields'
import { FieldErrors, Required, SelectField, TextField, valueKindOf } from './fields'
import {
  defaultFormCondition,
  forgetEdited,
  formAlertPrefix,
  hasWildcard,
  isZoneLimited,
  signalShape,
  toRule,
  withNumbersInUnit,
  type RuleForm
} from './formModel'
import { strayBraces, withGenerated } from './message'
import { MoreOptions } from './MoreOptions'
import { attachErrors, fieldPointers, underMoreOptions, type AttachedErrors } from './sections'
import { PathTyping, sourceOptions, withPath } from './SignalFields'
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
  /** Condition `index` was removed, which shifts the index the later conditions' errors are held by. */
  onGateRemoved: (index: number) => void
  /** A change of display unit emptied these shown numbers, each an error at its field. */
  onUnitChange: (emptied: FieldError[]) => void
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
  const { form, paths, units, live, isNew, checked, ruleName, editHref } = props
  const { attached } = checked
  // Open from the start on a rule with no value yet, so the first keystroke does not close it.
  const [changingPath, setChangingPath] = useState(() => form.signal.slots[0]?.path === '')
  const [moreOpen, setMoreOpen] = useState(() => hasMoreOptions(form))
  const searchRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  // Where focus goes once the path search opens or closes, which replaces the control that had it.
  const pathFocus = useRef<'search' | 'change' | undefined>(undefined)

  useEffect(() => {
    if (pathFocus.current === undefined) return
    const target = pathFocus.current === 'search' ? searchRef.current : changeRef.current
    // A click before the form's first effects ran finds no target yet; its own changingPath
    // render runs this effect again once the target is in the page.
    if (target === null) return
    target.focus()
    pathFocus.current = undefined
  }, [changingPath])

  useEffect(() => {
    if ([...attached.byField.keys()].some((p) => underMoreOptions(form, isNew, p))) {
      setMoreOpen(true)
    }
  }, [checked.set])

  // The form as last settled, whose units a change is compared with; the form as last changed,
  // which a commit in the same event as a change has not rendered; and whether the change on its
  // way is a keystroke in a path search, which passes through partial paths and settles nothing.
  // Any other change is made with focus out of the search, which committed the path typed there.
  const settled = useRef(form)
  const latest = useRef(form)
  const typing = useRef(false)
  useLayoutEffect(() => {
    latest.current = form
  }, [form])

  /** `next` with the numbers of a signal now in another unit emptied, the emptied reported. */
  const settle = (next: RuleForm): RuleForm => {
    const { form: kept, emptied } = withNumbersInUnit(settled.current, next, units)
    settled.current = kept
    if (emptied.length > 0) {
      const shown = new Set(fieldPointers(kept, isNew))
      props.onUnitChange(emptied.filter((e) => shown.has(e.path)))
    }
    return kept
  }
  const update = (next: RuleForm) => {
    const edited = forgetEdited(next)
    latest.current = withGenerated(typing.current ? edited : settle(edited), units)
    typing.current = false
    props.onChange(latest.current)
  }
  const pathTyping: PathTyping = {
    typing: () => {
      typing.current = true
    },
    committed: () => {
      const kept = settle(latest.current)
      if (kept === latest.current) return
      latest.current = withGenerated(kept, units)
      props.onChange(latest.current)
    }
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
  // The first instance in the order the toggle and the template picker list them, among
  // those the pinned source reports, as only those alert; until one reports, the
  // placeholder shows as written rather than vanishing.
  const reporting =
    paths.status !== 'ready'
      ? []
      : slot.source === ''
        ? paths.paths
        : paths.paths.filter((p) => p.sources?.includes(slot.source) === true)
  const previewInstance = wildcard
    ? (matchedInstances(slot.path, reporting).at(0) ?? '{instance}')
    : undefined
  const preview = (() => {
    const result = toRule(form, units)
    if (!result.ok || form.message === '') return undefined
    return renderMessage(result.rule, {
      step: 0,
      ...(previewInstance === undefined ? {} : { instance: previewInstance }),
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
                  pathTyping.typing()
                  update({
                    ...form,
                    signal: { ...form.signal, slots: [withPath(slot, path, live)] }
                  })
                }}
                onCommit={pathTyping.committed}
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
            {/* One line, held while there is nothing to preview: a path committed by a click
                rewrites or empties the preview, which would move the click's target. */}
            {preview === undefined ? (
              <span className="skar-preview-line" aria-hidden="true" />
            ) : (
              <span className="skar-preview-line" title={`Sends now: “${preview}”`}>
                {`Sends now: “${preview}”`}
              </span>
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
            {checked.holder !== undefined && editHref !== undefined && (
              <span className="skar-preview">
                To raise the same alert at a higher priority, add a step to{' '}
                <a href={editHref(checked.holder)}>{ruleName(checked.holder) ?? checked.holder}</a>{' '}
                instead.
              </span>
            )}
          </>
        }
        onChange={(condition) => {
          update({ ...form, condition })
        }}
      />

      {/* The combined inputs' and the conditions' path searches. */}
      <PathTyping.Provider value={pathTyping}>
        <MoreOptions
          form={form}
          onChange={update}
          onGateRemoved={props.onGateRemoved}
          measure={measure}
          paths={paths}
          units={units}
          isNew={isNew}
          open={moreOpen}
          onToggle={setMoreOpen}
        />
      </PathTyping.Provider>
    </FieldErrors.Provider>
  )
}
