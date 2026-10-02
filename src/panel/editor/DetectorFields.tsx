import { PathPicker } from '../paths/PathPicker'
import type { PathList, Zone } from '../paths/selfPaths'
import type { Step } from '../../model/rule'
import { formatDuration, formatNumber, formatValue } from '../rules/describe'
import type { Measure, UnitLookup } from '../signalUnits'
import { fromSI, unitLabel } from '../units'
import {
  CheckField,
  DurationInput,
  RadioGroup,
  SelectField,
  TextField,
  useFieldErrors,
  ValueInput,
  type Option
} from './fields'
import {
  canLatch,
  FIRST_STEP,
  matchTakesDuration,
  matchTakesValue,
  ZONE_LEVEL_NAMES,
  type DetectorForm,
  type DetectorType,
  type EventForm,
  type LimitForm,
  type MatchOp
} from './formModel'

/** One plain-language line per detector. */
const DETECTORS: readonly (Option<DetectorType> & { description: string })[] = [
  {
    value: 'sustained',
    label: 'Above or below a limit',
    description: 'for a time, clearing once back past the limit'
  },
  {
    value: 'match',
    label: 'A value or state',
    description: 'equal to a value, changing to it, or silent'
  },
  { value: 'slope', label: 'Rising or falling too fast', description: 'the trend over a window' },
  {
    value: 'projection',
    label: 'About to reach a limit',
    description: 'the trend over a window, projected ahead'
  },
  {
    value: 'accumulator',
    label: 'Running time or a total',
    description: 'accumulated, alerting once it reaches a limit'
  },
  { value: 'count', label: 'Too many events', description: 'within a window' },
  { value: 'absence', label: 'An expected event missing', description: 'for a time' }
]

const MATCH_OPS: readonly Option<MatchOp>[] = [
  { value: 'equals', label: 'equals a value' },
  { value: 'notEquals', label: 'differs from a value' },
  { value: 'changesTo', label: 'changes to a value' },
  { value: 'decreases', label: 'decreases' },
  { value: 'timedOut', label: 'stops reporting (timed out)' }
]

const DIRECTIONS = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' }
] as const

const TRENDS = [
  { value: 'rising', label: 'rising' },
  { value: 'falling', label: 'falling' }
] as const

const MEASURES = [
  { value: 'time', label: 'time while the condition holds' },
  { value: 'integral', label: 'the value summed over time' }
] as const

const STATE_OPS = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' },
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'differs from' }
] as const

const EVENT_OPS = [
  { value: 'changes', label: 'the value changes' },
  { value: 'changesTo', label: 'the value changes to' },
  { value: 'decreases', label: 'the value decreases' }
] as const

const LIMIT_KINDS = [
  { value: 'fixed', label: 'A fixed value' },
  { value: 'zone', label: "A zone level of the path's zones" }
] as const

const LEVELS = ZONE_LEVEL_NAMES.map((value) => ({ value, label: value }))

export interface DetectorFieldsProps {
  detector: DetectorForm
  update: (patch: Partial<DetectorForm>) => void
  /** How the signal's values convert and are labelled. */
  measure: Measure
}

/** The unit labels of each kind of field on a signal measured by `measure`. */
export function unitLabels(measure: Measure) {
  const ratio = measure.kind === 'ratio'
  const symbol = ratio ? '' : measure.unit.symbol
  return {
    value: unitLabel(measure.kind, measure.unit),
    interval: unitLabel(ratio ? 'ratio' : 'interval', measure.unit),
    slope: ratio ? '/min' : unitLabel('slope', measure.unit),
    integral: symbol === '' ? 's' : `${symbol}·s`
  }
}

function EventFields({
  label,
  at,
  event,
  onChange,
  unit
}: {
  label: string
  at: string
  event: EventForm
  onChange: (event: EventForm) => void
  unit: string
}) {
  return (
    <>
      <SelectField
        label={label}
        pointer={`${at}/op`}
        value={event.op}
        options={EVENT_OPS}
        onChange={(op) => {
          onChange({ ...event, op })
        }}
      />
      {event.op === 'changesTo' && (
        <ValueInput
          label={`${label}: value`}
          pointer={`${at}/value`}
          value={event.value}
          unit={unit}
          onChange={(value) => {
            onChange({ ...event, value })
          }}
        />
      )}
    </>
  )
}

/** What to detect: the detector and the choices that shape its condition. */
export function DetectFields({ detector: d, update, measure }: DetectorFieldsProps) {
  const units = unitLabels(measure)
  return (
    <>
      <RadioGroup
        legend="What to detect"
        pointer="/detector/type"
        value={d.type}
        options={DETECTORS}
        onChange={(type) => {
          update({ type })
        }}
      />
      {d.type === 'match' && (
        <SelectField
          label="The input"
          pointer="/detector/op"
          value={d.matchOp}
          options={MATCH_OPS}
          onChange={(matchOp) => {
            update({ matchOp })
          }}
        />
      )}
      {d.type === 'sustained' && (
        <SelectField
          label="Alert when the input is"
          pointer="/detector/direction"
          value={d.direction}
          options={DIRECTIONS}
          onChange={(direction) => {
            update({ direction })
          }}
        />
      )}
      {(d.type === 'slope' || d.type === 'projection') && (
        <SelectField
          label="Alert when the input is"
          pointer="/detector/direction"
          value={d.trend}
          options={TRENDS}
          onChange={(trend) => {
            update({ trend })
          }}
        />
      )}
      {d.type === 'accumulator' && (
        <>
          <SelectField
            label="Accumulate"
            pointer="/detector/measure"
            value={d.measure}
            options={MEASURES}
            onChange={(measured) => {
              update({ measure: measured })
            }}
          />
          <CheckField
            label="Only while a condition holds"
            checked={d.useWhile}
            onChange={(useWhile) => {
              update({ useWhile })
            }}
          />
          {d.useWhile && (
            <>
              <SelectField
                label="Accumulate while the input is"
                pointer="/detector/while/op"
                value={d.whileOp}
                options={STATE_OPS}
                onChange={(whileOp) => {
                  update({ whileOp })
                }}
              />
              <ValueInput
                label="Accumulate while: value"
                pointer="/detector/while/value"
                value={d.whileValue}
                unit={units.value}
                onChange={(whileValue) => {
                  update({ whileValue })
                }}
              />
            </>
          )}
          <CheckField
            label="Reset the total on an event"
            checked={d.useResetOn}
            onChange={(useResetOn) => {
              update({ useResetOn })
            }}
          />
          {d.useResetOn && (
            <EventFields
              label="Reset when"
              at="/detector/resetOn"
              event={d.resetOn}
              unit={units.value}
              onChange={(resetOn) => {
                update({ resetOn })
              }}
            />
          )}
        </>
      )}
      {(d.type === 'count' || d.type === 'absence') && (
        <EventFields
          label="The event: when"
          at="/detector/event"
          event={d.event}
          unit={units.value}
          onChange={(event) => {
            update({ event })
          }}
        />
      )}
    </>
  )
}

function zoneText(zone: Zone, measure: Measure): string {
  const show = (v: number) => formatValue(v, { kind: 'absolute', unit: measure.unit })
  if (zone.lower === undefined && zone.upper === undefined) return `${zone.state}: everywhere`
  if (zone.lower === undefined) return `${zone.state}: below ${show(zone.upper ?? 0)}`
  if (zone.upper === undefined) return `${zone.state}: above ${show(zone.lower)}`
  return `${zone.state}: ${show(zone.lower)} to ${show(zone.upper)}`
}

interface LimitProps {
  label: string
  at: string
  /** Where a fixed limit's value is stored; a rule's detector keeps it in its first step. */
  valuePointer?: string
  limit: LimitForm
  onChange: (limit: LimitForm) => void
  measure: Measure
  /** The path whose zones a zone limit uses by default; none for a combined signal. */
  signalPath: string | undefined
  paths: PathList
  units: UnitLookup
}

/** A fixed limit in the display unit, or a zone level with the path's zones shown. */
export function LimitFields({
  label,
  at,
  valuePointer = `${at}/value`,
  limit,
  onChange,
  measure,
  signalPath,
  paths,
  units
}: LimitProps) {
  const zonePathErrors = useFieldErrors(`${at}/path`)
  const zonePath = limit.path === '' ? signalPath : limit.path
  const zones = zonePath === undefined ? undefined : units.entry(zonePath)?.zones
  const zoneMeasure = { ...measure, unit: units.entry(zonePath ?? '')?.unit ?? measure.unit }
  return (
    <>
      <RadioGroup
        legend={`${label} is`}
        pointer={`${at}/kind`}
        value={limit.kind}
        options={LIMIT_KINDS}
        onChange={(kind) => {
          onChange({ ...limit, kind })
        }}
      />
      {limit.kind === 'fixed' ? (
        <TextField
          label={label}
          pointer={valuePointer}
          value={limit.value}
          numeric
          unit={unitLabels(measure).value}
          onChange={(value) => {
            onChange({ ...limit, value })
          }}
        />
      ) : (
        <>
          <SelectField
            label="Zone level"
            pointer={`${at}/level`}
            value={limit.level}
            options={LEVELS}
            onChange={(level) => {
              onChange({ ...limit, level })
            }}
            hint={
              zones === undefined
                ? 'The path reports no zones yet.'
                : `Zones now: ${zones.map((z) => zoneText(z, zoneMeasure)).join('; ')}`
            }
          />
          <PathPicker
            label={signalPath === undefined ? 'Zones from path' : 'Zones from path (optional)'}
            value={limit.path}
            paths={paths}
            errors={zonePathErrors}
            onChange={(path) => {
              onChange({ ...limit, path })
            }}
          />
        </>
      )}
    </>
  )
}

/** A step's condition in words, numbers in the display unit of the signal. */
function stepCondition(d: DetectorForm, step: Step, measure: Measure): string {
  if ('value' in step)
    return step.value === undefined ? '' : `on ${formatValue(step.value, measure)}`
  if ('within' in step) return `after ${formatDuration(step.within)} without the event`
  if (!('limit' in step)) return ''
  const labels = unitLabels(measure)
  const shown = (kind: 'slope' | 'interval' | 'ratio') =>
    formatNumber(fromSI(kind, step.limit, measure.unit))
  switch (d.type) {
    case 'sustained':
      return `${d.direction} ${formatValue(step.limit, measure)}`
    case 'projection':
      return `when projected to reach ${formatValue(step.limit, measure)}`
    case 'slope':
      return `${d.trend} faster than ${shown('slope')} ${labels.slope}`
    case 'accumulator':
      return d.measure === 'time'
        ? `at a total of ${formatDuration(step.limit)}`
        : `at a total of ${shown(measure.kind === 'ratio' ? 'ratio' : 'interval')} ${labels.integral}`
    case 'count':
      return `above ${String(step.limit)} events`
    default:
      return formatValue(step.limit, measure)
  }
}

/**
 * The steps after the first, which the editor cannot show as fields yet and
 * saving keeps as they are: a user changing the first step's limit sees what
 * the rule goes on to, and whether it still fits.
 */
export function LaterStepsNotice({
  detector,
  steps,
  measure
}: {
  detector: DetectorForm
  steps: readonly Step[]
  measure: Measure
}) {
  if (steps.length === 0) return null
  return (
    <div className="form-text">
      <p className="mb-1">
        This rule has further steps, which the editor cannot change yet. Saving keeps them as they
        are:
      </p>
      <ul className="mb-0">
        {steps.map((step) => (
          <li key={step.priority}>
            {['Then', step.priority, stepCondition(detector, step, measure)]
              .filter((part) => part !== '')
              .join(' ')}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LimitSectionFields({
  detector: d,
  update,
  measure,
  signalPath,
  paths,
  units
}: DetectorFieldsProps & { signalPath: string | undefined; paths: PathList; units: UnitLookup }) {
  const labels = unitLabels(measure)
  switch (d.type) {
    case 'match':
      return matchTakesValue(d.matchOp) ? (
        <ValueInput
          label="Value"
          pointer={`${FIRST_STEP}/value`}
          value={d.matchValue}
          unit={labels.value}
          onChange={(matchValue) => {
            update({ matchValue })
          }}
        />
      ) : null
    case 'sustained':
    case 'projection':
      return (
        <LimitFields
          label="Limit"
          at="/detector/limit"
          valuePointer={`${FIRST_STEP}/limit`}
          limit={d.limit}
          measure={measure}
          signalPath={signalPath}
          paths={paths}
          units={units}
          onChange={(limit) => {
            update({ limit })
          }}
        />
      )
    case 'slope':
      return (
        <TextField
          label="Faster than"
          pointer={`${FIRST_STEP}/limit`}
          value={d.slopeLimit}
          numeric
          unit={labels.slope}
          onChange={(slopeLimit) => {
            update({ slopeLimit })
          }}
        />
      )
    case 'accumulator':
      return d.measure === 'time' ? (
        <DurationInput
          label="Alert at a total of"
          pointer={`${FIRST_STEP}/limit`}
          value={d.timeLimit}
          onChange={(timeLimit) => {
            update({ timeLimit })
          }}
        />
      ) : (
        <TextField
          label="Alert at a total of"
          pointer={`${FIRST_STEP}/limit`}
          value={d.integralLimit}
          numeric
          unit={labels.integral}
          onChange={(integralLimit) => {
            update({ integralLimit })
          }}
        />
      )
    case 'count':
      return (
        <TextField
          label="More events than"
          pointer={`${FIRST_STEP}/limit`}
          value={d.countLimit}
          numeric
          onChange={(countLimit) => {
            update({ countLimit })
          }}
        />
      )
    default:
      return null
  }
}

export function TimingFields({ detector: d, update }: DetectorFieldsProps) {
  const duration = (label: string, hint?: string) => (
    <DurationInput
      label={label}
      pointer="/detector/duration"
      value={d.duration}
      hint={hint}
      onChange={(value) => {
        update({ duration: value })
      }}
    />
  )
  const window = (
    <DurationInput
      label="Over a window of"
      pointer="/detector/window"
      value={d.window}
      onChange={(value) => {
        update({ window: value })
      }}
    />
  )
  switch (d.type) {
    case 'match':
      if (!matchTakesDuration(d.matchOp)) return null
      return d.matchOp === 'timedOut'
        ? duration('Silent for')
        : duration('For at least', 'Empty means at once.')
    case 'sustained':
      return duration('For at least', 'Empty means at once.')
    case 'slope':
    case 'count':
      return window
    case 'projection':
      return (
        <>
          {window}
          <DurationInput
            label="Reaching the limit within"
            pointer="/detector/horizon"
            value={d.horizon}
            onChange={(horizon) => {
              update({ horizon })
            }}
          />
        </>
      )
    case 'absence':
      return (
        <DurationInput
          label="Missing for"
          pointer={`${FIRST_STEP}/within`}
          value={d.within}
          onChange={(within) => {
            update({ within })
          }}
        />
      )
    default:
      return null
  }
}

export function AdvancedFields({
  detector: d,
  update,
  measure,
  latching,
  setLatching
}: DetectorFieldsProps & { latching: boolean; setLatching: (latching: boolean) => void }) {
  return (
    <>
      {d.type === 'sustained' && (
        <>
          <TextField
            label="Hysteresis"
            pointer="/detector/hysteresis"
            value={d.hysteresis}
            numeric
            unit={unitLabels(measure).interval}
            hint="How far back past the limit the input must go to clear. Empty is none."
            onChange={(hysteresis) => {
              update({ hysteresis })
            }}
          />
          <DurationInput
            label="Clear after"
            pointer="/detector/clearDuration"
            value={d.clearDuration}
            hint="How long the input must stay clear. Empty clears at once."
            onChange={(clearDuration) => {
              update({ clearDuration })
            }}
          />
        </>
      )}
      {canLatch(d) && (
        <CheckField
          label="Latching: hold the alert until acknowledged"
          pointer="/latching"
          checked={latching}
          onChange={setLatching}
        />
      )}
    </>
  )
}
