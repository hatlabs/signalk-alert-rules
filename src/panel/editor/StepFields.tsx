import { useContext, useId, useState } from 'react'
import type { Priority } from '../../model/rule'
import type { SignalValue } from '../api'
import { capitalised } from '../list/PriorityBadge'
import { article } from '../rules/describe'
import type { Measure, UnitLookup } from '../signalUnits'
import {
  DurationControl,
  FieldErrors,
  Required,
  SelectControl,
  ValueControl,
  type ValueKind
} from './fields'
import {
  emptyStep,
  maxSteps,
  PRIORITY_LEVELS,
  stepLimitFields,
  type StepLimitField,
  stepPointer,
  stepQuantity,
  type RuleForm,
  type StepForm
} from './formModel'
import { ladderText, nowText, priorityMeaning } from './live'
import { rangeLimitText, stepLimitText, stepWord, unitLabels } from './words'

/** Least severe first, as a climb reads. */
const CLIMB: readonly Priority[] = [...PRIORITY_LEVELS].reverse()
const PRIORITY_OPTIONS = CLIMB.map((value) => ({ value, label: capitalised(value) }))

function nextPriority(steps: readonly StepForm[]): Priority {
  const last = steps.at(-1)?.priority
  const at = last === undefined || last === '' ? -1 : CLIMB.indexOf(last)
  return CLIMB[Math.min(at + 1, CLIMB.length - 1)] ?? 'emergency'
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

const ORDER = /^must be (above|below) the previous step's limit$/

const RANGE_ORDER = "must not be inside the previous step's range"
const RANGE_INVERTED = 'must be above the low limit'

interface StepError {
  index: number
  pointer: string
  message: string
}

/** A range step's error in words, naming the side and the previous step's limit it must pass. */
function rangeError(
  form: RuleForm,
  { index, pointer, message }: StepError,
  measure: Measure
): string | undefined {
  if (message === RANGE_INVERTED) return 'the high limit must be above the low limit.'
  const step = form.steps.at(index)
  const previous = index > 0 ? form.steps.at(index - 1) : undefined
  if (message !== RANGE_ORDER || step === undefined || previous === undefined) return undefined
  if (step.priority === '' || previous.priority === '') return undefined
  const whose = `${article(step.priority)} ${step.priority}'s`
  const same = step.low.trim() === previous.low.trim() && step.high.trim() === previous.high.trim()
  if (same) {
    const range = stepLimitText(previous, 'range', measure)
    return range === undefined
      ? undefined
      : `${whose} range must be wider than ${range}, the ${previous.priority}'s range.`
  }
  const side = pointer.endsWith('/low') ? 'low' : 'high'
  const limit = rangeLimitText(previous, side, measure)
  const beyond = side === 'low' ? 'above' : 'below'
  return limit === undefined
    ? undefined
    : `${whose} ${side} limit must not be ${beyond} ${limit}, the ${previous.priority}'s ${side} limit.`
}

/** A range's limits by their side; every other limit by what the step compares. */
const LIMIT_LABELS: Readonly<Partial<Record<string, string>>> = {
  low: 'low limit',
  high: 'high limit'
}

/**
 * A step's error in words: a missing field is asked for by what it is, and
 * an out-of-order limit names the limit it must pass and whose it is, as
 * the user sees them.
 */
function stepError(form: RuleForm, error: StepError, limitLabel: string, measure: Measure): string {
  const { index, pointer, message } = error
  const step = form.steps.at(index)
  const previous = index > 0 ? form.steps.at(index - 1) : undefined
  const order = ORDER.exec(message)
  const prefix = form.steps.length > 1 ? `Step ${String(index + 1)}: ` : ''
  if (order !== null && step !== undefined && previous !== undefined) {
    const limit = stepLimitText(previous, stepQuantity(form.detector), measure)
    if (limit !== undefined && step.priority !== '' && previous.priority !== '') {
      return `${prefix}${article(step.priority)} ${step.priority} must be ${order[1]} ${limit}, the ${previous.priority}'s limit.`
    }
  }
  const range =
    stepQuantity(form.detector) === 'range' ? rangeError(form, error, measure) : undefined
  if (range !== undefined) return capitalised(`${prefix}${range}`)
  const missing = pointer.endsWith('/priority')
    ? 'choose a priority'
    : `fill in the ${LIMIT_LABELS[pointer.split('/').at(-1) ?? ''] ?? limitLabel}`
  return capitalised(`${prefix}${message === 'is required' ? missing : message}`)
}

interface StepFieldsProps {
  form: RuleForm
  onChange: (steps: StepForm[]) => void
  measure: Measure
  units: UnitLookup
  /** What the watched path reports, for a match's values. */
  valueKind: ValueKind | undefined
  /** The value now, for "would alert"; absent for a combination or a wildcard. */
  value: SignalValue | undefined
}

/**
 * Priority and limit: one row per step of the climb, with Escalate to add a
 * further one, each step's errors under the rows, how the climb reads, the
 * value now, and what the priority last chosen means.
 */
export function StepFields({ form, onChange, measure, units, valueKind, value }: StepFieldsProps) {
  const id = useId()
  const errors = useContext(FieldErrors)
  const [chosen, setChosen] = useState<number | undefined>(undefined)
  const { steps } = form
  const quantity = stepQuantity(form.detector)
  const word = stepWord(form.detector)
  const labels = unitLabels(measure)
  const unit = { value: labels.value, slope: labels.slope, integral: labels.integral }[
    quantity === 'value' || quantity === 'slope' || quantity === 'integral' ? quantity : 'value'
  ]
  const limitFields = stepLimitFields(quantity)
  const limitPointer = (i: number, field: StepLimitField | undefined = limitFields.at(0)) =>
    `${stepPointer(i)}/${field ?? ''}`
  const stepErrors = steps.flatMap((_, i) =>
    [`${stepPointer(i)}/priority`, ...limitFields.map((f) => limitPointer(i, f))].flatMap((p) =>
      (errors.get(p) ?? []).map((message) => ({ index: i, pointer: p, message }))
    )
  )
  const errorId = `${id}-errors`
  const invalid = (pointer: string) =>
    stepErrors.some((e) => e.pointer === pointer)
      ? { 'aria-invalid': true as const, 'aria-describedby': errorId }
      : {}
  const setStep = (index: number, patch: Partial<StepForm>) => {
    onChange(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }
  const shownPriority = steps[chosen ?? steps.length - 1]?.priority ?? ''
  const ladder = ladderText(form, units)
  const now = nowText(form, value, units)
  const canEscalate =
    steps.length < maxSteps(form.detector) && steps.at(-1)?.priority !== 'emergency'
  const limitLabel = quantity === 'match' ? 'state' : 'limit'

  return (
    <fieldset
      className="skar-field skar-steps-field"
      aria-describedby={stepErrors.length > 0 ? errorId : undefined}
    >
      <legend className="skar-label">
        {`Priority and ${limitLabel}`}
        <Required />
      </legend>
      <ol className="skar-steps">
        {steps.map((step, i) => {
          const n = String(i + 1)
          const at = stepPointer(i)
          const control = (label: string, field?: StepLimitField) => {
            const pointer = limitPointer(i, field)
            return {
              'aria-label': `${label} for step ${n}`,
              className: `skar-input${stepErrors.some((e) => e.pointer === pointer) ? ' skar-input-invalid' : ''}`,
              ...invalid(pointer)
            }
          }
          const limitControl = control(capitalised(limitLabel))
          return (
            <li key={i} className="skar-step">
              <span className="skar-step-number" aria-hidden="true">
                {n}
              </span>
              <SelectControl
                aria-label={`Priority for step ${n}`}
                className={`skar-input${stepErrors.some((e) => e.pointer === `${at}/priority`) ? ' skar-input-invalid' : ''}`}
                {...invalid(`${at}/priority`)}
                value={step.priority}
                options={PRIORITY_OPTIONS}
                onChange={(priority) => {
                  setChosen(i)
                  setStep(i, { priority })
                }}
              />
              {word !== '' && <span className="skar-step-word">{word}</span>}
              <span className="skar-step-limit">
                {(quantity === 'time' || quantity === 'within') && (
                  <DurationControl
                    label={`${capitalised(limitLabel)} for step ${n}`}
                    value={step.duration}
                    control={limitControl}
                    onChange={(duration) => {
                      setStep(i, { duration })
                    }}
                  />
                )}
                {quantity === 'match' && (
                  <ValueControl
                    label={`State for step ${n}`}
                    value={step.value}
                    unit={labels.value}
                    kind={valueKind}
                    control={limitControl}
                    onChange={(v) => {
                      setStep(i, { value: v })
                    }}
                  />
                )}
                {(quantity === 'value' ||
                  quantity === 'slope' ||
                  quantity === 'integral' ||
                  quantity === 'count') && (
                  <span className="skar-input-row">
                    <input
                      {...limitControl}
                      type="text"
                      inputMode="decimal"
                      value={step.limit}
                      onChange={(e) => {
                        setStep(i, { limit: e.target.value })
                      }}
                    />
                    {quantity !== 'count' && unit !== '' && (
                      <span className="skar-unit">{unit}</span>
                    )}
                  </span>
                )}
                {quantity === 'range' && (
                  <span className="skar-input-row">
                    <input
                      {...control('Low limit', 'low')}
                      type="text"
                      inputMode="decimal"
                      value={step.low}
                      onChange={(e) => {
                        setStep(i, { low: e.target.value })
                      }}
                    />
                    <span className="skar-unit">to</span>
                    <input
                      {...control('High limit', 'high')}
                      type="text"
                      inputMode="decimal"
                      value={step.high}
                      onChange={(e) => {
                        setStep(i, { high: e.target.value })
                      }}
                    />
                    {unit !== '' && <span className="skar-unit">{unit}</span>}
                  </span>
                )}
              </span>
              {i > 0 ? (
                <button
                  type="button"
                  className="skar-icon-btn"
                  aria-label={`Remove step ${n}`}
                  onClick={() => {
                    setChosen(undefined)
                    onChange(steps.filter((_, k) => k !== i))
                  }}
                >
                  <CrossIcon />
                </button>
              ) : (
                <span />
              )}
            </li>
          )
        })}
      </ol>
      {stepErrors.length > 0 && (
        <div id={errorId} className="skar-error" role="alert">
          {stepErrors.map((e) => (
            <div key={`${e.pointer} ${e.message}`}>{stepError(form, e, limitLabel, measure)}</div>
          ))}
        </div>
      )}
      {canEscalate && (
        <div>
          <button
            type="button"
            className="skar-link-btn"
            onClick={() => {
              setChosen(steps.length)
              onChange([...steps, emptyStep(nextPriority(steps))])
            }}
          >
            <PlusIcon />
            {quantity === 'match' ? 'Escalate on another state…' : 'Escalate at…'}
          </button>
        </div>
      )}
      {(ladder !== undefined || now !== undefined) && (
        <p className="skar-hint">{[ladder, now].filter((t) => t !== undefined).join(' ')}</p>
      )}
      {shownPriority !== '' && (
        <p className="skar-hint skar-priority-hint">
          <strong>{capitalised(shownPriority)}:</strong> {priorityMeaning(shownPriority)}
        </p>
      )}
    </fieldset>
  )
}
