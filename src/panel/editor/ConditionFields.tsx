import type { SignalValue } from '../api'
import type { Measure } from '../signalUnits'
import { kindOf, kindsFor, withKind, type ConditionKind } from './conditionKinds'
import {
  CheckField,
  DurationInput,
  Field,
  SelectControl,
  SelectField,
  ValueControl,
  type ValueKind
} from './fields'
import {
  matchTakesDuration,
  withDetector,
  type DetectorForm,
  type EventForm,
  type RuleForm
} from './formModel'
import { unitLabels } from './words'

const TRENDS = [
  { value: 'falling', label: 'Falling' },
  { value: 'rising', label: 'Rising' }
] as const

const STATE_OPS = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'changesTo', label: 'changes to' },
  { value: 'decreases', label: 'decreases' }
] as const

const EVENT_OPS = [
  { value: 'changes', label: 'changes' },
  { value: 'changesTo', label: 'changes to' },
  { value: 'decreases', label: 'decreases' }
] as const

const MEASURES = [
  { value: 'time', label: 'Time' },
  { value: 'integral', label: 'The value over time' }
] as const

const WHILE_OPS = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' },
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' }
] as const

interface EventProps {
  label: string
  at: string
  event: EventForm
  onChange: (event: EventForm) => void
  unit: string
  valueKind: ValueKind | undefined
}

function EventFields({ label, at, event, onChange, unit, valueKind }: EventProps) {
  return (
    <Field label={label} pointer={`${at}/op`} required>
      {(control) => (
        <div className="skar-input-row skar-wrap">
          <SelectControl
            {...control}
            value={event.op}
            options={EVENT_OPS}
            onChange={(op) => {
              onChange({ ...event, op })
            }}
          />
          {event.op === 'changesTo' && (
            <ValueControl
              label={`${label}: value`}
              value={event.value}
              unit={unit}
              kind={valueKind}
              control={{ 'aria-label': `${label}: value` }}
              onChange={(value) => {
                onChange({ ...event, value })
              }}
            />
          )}
        </div>
      )}
    </Field>
  )
}

interface ConditionFieldsProps {
  form: RuleForm
  onChange: (form: RuleForm) => void
  measure: Measure
  valueKind: ValueKind | undefined
  /** The value now, which decides the kinds offered. */
  value: SignalValue | undefined
}

/** Alert when: the condition kind, and the fields it needs above its steps. */
export function KindField({ form, onChange, value }: ConditionFieldsProps) {
  const kind = kindOf(form.detector)
  const kinds = kindsFor(value)
  // A stored rule keeps its kind even where the value now would not offer it.
  const offered =
    kind === undefined || kinds.some((k) => k.kind === kind)
      ? kinds
      : [...kinds, ...kindsFor(undefined).filter((k) => k.kind === kind)]
  return (
    <SelectField<ConditionKind>
      label="Alert when"
      pointer="/detector/type"
      required
      value={kind ?? ''}
      options={offered.map((k) => ({ value: k.kind, label: k.label }))}
      onChange={(next) => {
        onChange(withKind(form, next))
      }}
    />
  )
}

/** The fields of the chosen kind that come before its steps. */
export function ConditionFields({ form, onChange, measure, valueKind }: ConditionFieldsProps) {
  const d = form.detector
  const unit = unitLabels(measure).value
  const update = (patch: Partial<DetectorForm>) => {
    onChange(withDetector(form, patch))
  }
  switch (d.type) {
    case 'slope':
      return (
        <>
          <SelectField
            label="Changing"
            pointer="/detector/direction"
            required
            value={d.trend}
            options={TRENDS}
            onChange={(trend) => {
              update({ trend })
            }}
          />
          <DurationInput
            label="Over the last"
            pointer="/detector/window"
            required
            value={d.window}
            onChange={(window) => {
              update({ window })
            }}
          />
        </>
      )
    case 'projection':
      return (
        <>
          <SelectField
            label="Heading"
            pointer="/detector/direction"
            required
            value={d.trend}
            options={TRENDS}
            onChange={(trend) => {
              update({ trend })
            }}
          />
          <DurationInput
            label="Trend over the last"
            pointer="/detector/window"
            required
            value={d.window}
            onChange={(window) => {
              update({ window })
            }}
          />
          <DurationInput
            label="Reaching the limit within"
            pointer="/detector/horizon"
            required
            value={d.horizon}
            onChange={(horizon) => {
              update({ horizon })
            }}
          />
        </>
      )
    case 'match':
      return d.matchOp === 'timedOut' ? null : (
        <SelectField
          label="The value"
          pointer="/detector/op"
          required
          value={d.matchOp}
          options={STATE_OPS}
          onChange={(matchOp) => {
            update({ matchOp })
          }}
        />
      )
    case 'count':
      return (
        <>
          <EventFields
            label="Count each time the value"
            at="/detector/event"
            event={d.event}
            unit={unit}
            valueKind={valueKind}
            onChange={(event) => {
              update({ event })
            }}
          />
          <DurationInput
            label="Within"
            pointer="/detector/window"
            required
            value={d.window}
            onChange={(window) => {
              update({ window })
            }}
          />
        </>
      )
    case 'absence':
      return (
        <EventFields
          label="Expect the value to"
          at="/detector/event"
          event={d.event}
          unit={unit}
          valueKind={valueKind}
          onChange={(event) => {
            update({ event })
          }}
        />
      )
    case 'accumulator':
      return (
        <>
          <SelectField
            label="Total of"
            pointer="/detector/measure"
            required
            value={d.measure}
            options={MEASURES}
            onChange={(measured) => {
              update({ measure: measured })
            }}
          />
          <CheckField
            label="Only while the value is…"
            checked={d.useWhile}
            onChange={(useWhile) => {
              update({ useWhile })
            }}
          />
          {d.useWhile && (
            <Field label="Count while the value is" pointer="/detector/while/op">
              {(control) => (
                <div className="skar-input-row skar-wrap">
                  <SelectControl
                    {...control}
                    value={d.whileOp}
                    options={WHILE_OPS}
                    onChange={(whileOp) => {
                      update({ whileOp })
                    }}
                  />
                  <ValueControl
                    label="Count while: value"
                    value={d.whileValue}
                    unit={unit}
                    kind={d.whileOp === 'above' || d.whileOp === 'below' ? 'number' : valueKind}
                    control={{ 'aria-label': 'Count while: value' }}
                    onChange={(whileValue) => {
                      update({ whileValue })
                    }}
                  />
                </div>
              )}
            </Field>
          )}
          <CheckField
            label="Start the total again when…"
            checked={d.useResetOn}
            onChange={(useResetOn) => {
              update({ useResetOn })
            }}
          />
          {d.useResetOn && (
            <EventFields
              label="Start again when the value"
              at="/detector/resetOn"
              event={d.resetOn}
              unit={unit}
              valueKind={valueKind}
              onChange={(resetOn) => {
                update({ resetOn })
              }}
            />
          )}
        </>
      )
    default:
      return null
  }
}

/** How long a step's condition must hold; after the steps. */
export function HoldField({ form, onChange }: Pick<ConditionFieldsProps, 'form' | 'onChange'>) {
  const d = form.detector
  const holds = d.type === 'sustained' || (d.type === 'match' && matchTakesDuration(d.matchOp))
  if (!holds) return null
  const timeout = d.type === 'match' && d.matchOp === 'timedOut'
  return (
    <DurationInput
      label={
        timeout
          ? 'Silent for at least'
          : form.steps.length > 1
            ? 'Each step must hold for at least'
            : 'For at least'
      }
      pointer="/detector/duration"
      required={timeout}
      hint={timeout ? undefined : 'Empty alerts at once.'}
      value={d.duration}
      onChange={(duration) => {
        onChange(withDetector(form, { duration }))
      }}
    />
  )
}
