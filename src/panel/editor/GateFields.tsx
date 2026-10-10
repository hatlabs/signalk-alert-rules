import { isPointerPath } from '../../model/pointerPath'
import { ZONE_LEVELS } from '../../model/zoneLevels'
import { PathPicker } from '../paths/PathPicker'
import { withoutFields, type PathList, type Zone } from '../paths/selfPaths'
import { formatValue } from '../rules/describe'
import { signalMeasure, type Measure, type UnitLookup } from '../signalUnits'
import { DurationInput, RadioGroup, SelectField, TextField, useFieldErrors } from './fields'
import { signalShape, type GateForm, type LimitForm } from './formModel'
import { SignalFields } from './SignalFields'
import { unitLabels } from './words'

const DIRECTIONS = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' }
] as const

const LIMIT_KINDS = [
  { value: 'fixed', label: 'A fixed value' },
  { value: 'zone', label: "A zone level of the path's zones" }
] as const

const LEVELS = ZONE_LEVELS.map((value) => ({ value, label: value }))

/** A zone as the editor lists it: its state and range, in the display unit. */
export function zoneText(zone: Zone, measure: Measure): string {
  const show = (v: number) => formatValue(v, { kind: 'absolute', unit: measure.unit })
  if (zone.lower === undefined && zone.upper === undefined) return `${zone.state}: everywhere`
  if (zone.lower === undefined) return `${zone.state}: below ${show(zone.upper ?? 0)}`
  if (zone.upper === undefined) return `${zone.state}: above ${show(zone.lower)}`
  return `${zone.state}: ${show(zone.lower)} to ${show(zone.upper)}`
}

interface LimitProps {
  label: string
  at: string
  limit: LimitForm
  onChange: (limit: LimitForm) => void
  measure: Measure
  /** The path whose zones a zone limit uses by default; none for a combined signal. */
  signalPath: string | undefined
  paths: PathList
  units: UnitLookup
}

/** A gate's limit: a fixed value in the display unit, or a zone level with the path's zones. */
function LimitFields({
  label,
  at,
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
        // A field has no zones; a zone limit stored on one stays, to be turned off.
        options={
          signalPath !== undefined && isPointerPath(signalPath) && limit.kind !== 'zone'
            ? LIMIT_KINDS.filter((k) => k.value !== 'zone')
            : LIMIT_KINDS
        }
        onChange={(kind) => {
          onChange({ ...limit, kind })
        }}
      />
      {limit.kind === 'fixed' ? (
        <TextField
          label={label}
          pointer={`${at}/value`}
          value={limit.value}
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
            // A field never reports zones; the error on the level says what to do.
            hint={
              zonePath !== undefined && isPointerPath(zonePath)
                ? undefined
                : zones === undefined
                  ? 'The path reports no zones yet.'
                  : `Zones now: ${zones.map((z) => zoneText(z, zoneMeasure)).join('; ')}`
            }
          />
          <PathPicker
            label={signalPath === undefined ? 'Zones from path' : 'Zones from path (optional)'}
            value={limit.path}
            paths={withoutFields(paths)}
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

export interface GateFieldsProps {
  index: number
  gate: GateForm
  onChange: (gate: GateForm) => void
  onRemove: () => void
  paths: PathList
  units: UnitLookup
}

/** One condition under Only while: the rule is in use only while its input stays past its limit. */
export function GateFields({ index, gate, onChange, onRemove, paths, units }: GateFieldsProps) {
  const name = `Condition ${String(index + 1)}`
  const at = `/gates/${String(index)}`
  const measure = signalMeasure(signalShape(gate.signal), units)
  return (
    <fieldset className="skar-gate">
      <legend className="skar-label">{`Only while, condition ${String(index + 1)}`}</legend>
      <SignalFields
        label={`${name} input`}
        at={`${at}/signal`}
        signal={gate.signal}
        paths={paths}
        units={units}
        onChange={(signal) => {
          onChange({ ...gate, signal })
        }}
      />
      <SelectField
        label={`${name} holds while the input is`}
        pointer={`${at}/direction`}
        value={gate.direction}
        options={DIRECTIONS}
        onChange={(direction) => {
          onChange({ ...gate, direction })
        }}
      />
      <LimitFields
        label={`${name} limit`}
        at={`${at}/limit`}
        limit={gate.limit}
        measure={measure}
        signalPath={gate.signal.mode === 'single' ? gate.signal.slots[0]?.path : undefined}
        paths={paths}
        units={units}
        onChange={(limit) => {
          onChange({ ...gate, limit })
        }}
      />
      <DurationInput
        label={`${name}: for at least`}
        pointer={`${at}/duration`}
        value={gate.duration}
        onChange={(duration) => {
          onChange({ ...gate, duration })
        }}
      />
      <div>
        <button type="button" className="skar-btn skar-btn-ghost skar-btn-small" onClick={onRemove}>
          Remove condition {String(index + 1)}
        </button>
      </div>
    </fieldset>
  )
}
