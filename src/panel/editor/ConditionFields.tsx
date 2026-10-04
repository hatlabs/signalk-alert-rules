import type { SignalValue } from '../api'
import type { Measure } from '../signalUnits'
import { kindOf, kindsFor, withKind, type ConditionKind } from './conditionKinds'
import {
  CheckField,
  DurationInput,
  errorIdOf,
  Field,
  SelectControl,
  SelectField,
  useFieldErrors,
  validity,
  ValueControl,
  type ControlProps,
  type Option,
  type ValueKind
} from './fields'
import {
  holdsFor,
  withDetector,
  type DetectorForm,
  type EventForm,
  type RuleForm,
  type ValueField
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

interface OpValueProps<T extends string> {
  label: string
  /** The pointer of the condition, which holds its `op` and `value`. */
  at: string
  op: T | ''
  options: readonly Option<T>[]
  onOp: (op: T) => void
  valueLabel: string
  /** The value compared with; undefined while the op takes none. */
  value: ValueField | undefined
  onValue: (value: ValueField) => void
  unit: string
  valueKind: ValueKind | undefined
}

/**
 * An op and the value it compares with, under one label. An error on either
 * shows under the field, but marks only the control it belongs to.
 */
function OpValueField<T extends string>({
  label,
  at,
  op,
  options,
  onOp,
  valueLabel,
  value,
  onValue,
  unit,
  valueKind
}: OpValueProps<T>) {
  const opInvalid = useFieldErrors(`${at}/op`).length > 0
  const valueErrors = useFieldErrors(`${at}/value`)
  const shownErrors = value === undefined ? [] : valueErrors
  return (
    <Field label={label} pointer={`${at}/op`} extraErrors={shownErrors} required>
      {(control) => {
        const { id: _id, ...forValue } = marked(control, shownErrors.length > 0)
        return (
          <div className="skar-input-row skar-wrap">
            <SelectControl
              {...marked(control, opInvalid)}
              value={op}
              options={options}
              onChange={onOp}
            />
            {value !== undefined && (
              <ValueControl
                label={valueLabel}
                value={value}
                unit={unit}
                kind={valueKind}
                control={{ ...forValue, 'aria-label': valueLabel }}
                onChange={onValue}
              />
            )}
          </div>
        )
      }}
    </Field>
  )
}

/**
 * A field's control, marked invalid and described by the field's error only
 * when its own errors are among the field's.
 */
function marked(control: ControlProps, invalid: boolean): ControlProps {
  const { 'aria-invalid': _invalid, 'aria-describedby': describedBy, ...rest } = control
  const ids = (describedBy ?? '')
    .split(' ')
    .filter((id) => id !== '' && (invalid || id !== errorIdOf(control.id)))
  return {
    ...rest,
    ...validity(invalid),
    ...(ids.length === 0 ? {} : { 'aria-describedby': ids.join(' ') })
  }
}

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
    <OpValueField
      label={label}
      at={at}
      op={event.op}
      options={EVENT_OPS}
      onOp={(op) => {
        onChange({ ...event, op })
      }}
      valueLabel={`${label}: value`}
      value={event.op === 'changesTo' ? event.value : undefined}
      onValue={(value) => {
        onChange({ ...event, value })
      }}
      unit={unit}
      valueKind={valueKind}
    />
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
  // Below and Above a limit are a direction as much as a kind, so this field asks for it.
  const directionErrors = useFieldErrors('/detector/direction')
  const kinds = kindsFor(value)
  // A stored rule keeps its kind even where the value now would not offer it;
  // one that lost its direction keeps both, so it can be chosen again.
  const kept: readonly ConditionKind[] =
    kind !== undefined ? [kind] : form.detector.type === 'sustained' ? ['below', 'above'] : []
  const offered = [
    ...kinds,
    ...kindsFor(undefined).filter(
      (k) => kept.includes(k.kind) && !kinds.some((o) => o.kind === k.kind)
    )
  ]
  return (
    <SelectField<ConditionKind>
      label="Alert when"
      pointer="/detector/type"
      required
      extraErrors={form.detector.type === 'sustained' ? directionErrors : []}
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
            <OpValueField
              label="Count while the value is"
              at="/detector/while"
              op={d.whileOp}
              options={WHILE_OPS}
              onOp={(whileOp) => {
                update({ whileOp })
              }}
              valueLabel="Count while: value"
              value={d.whileValue}
              onValue={(whileValue) => {
                update({ whileValue })
              }}
              unit={unit}
              valueKind={d.whileOp === 'above' || d.whileOp === 'below' ? 'number' : valueKind}
            />
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
  if (!holdsFor(d)) return null
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
