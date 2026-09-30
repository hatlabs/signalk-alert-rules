import type { PathList } from '../paths/selfPaths'
import { signalMeasure, type UnitLookup } from '../signalUnits'
import { LimitFields, unitLabels } from './DetectorFields'
import { DurationInput, SelectField, TextField } from './fields'
import { signalShape, type GateForm } from './formModel'
import { SignalFields } from './SignalFields'

const DIRECTIONS = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' }
] as const

export interface GateFieldsProps {
  index: number
  gate: GateForm
  onChange: (gate: GateForm) => void
  onRemove: () => void
  paths: PathList
  units: UnitLookup
}

/** One gate: the rule is in use only while its input stays past its limit. */
export function GateFields({ index, gate, onChange, onRemove, paths, units }: GateFieldsProps) {
  const name = `Gate ${String(index + 1)}`
  const at = `/gates/${String(index)}`
  const measure = signalMeasure(signalShape(gate.signal), units)
  return (
    <fieldset className="skar-gate">
      <legend className="h6">{name}</legend>
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
      <details open={gate.hysteresis !== '' || gate.clearDuration.amount !== ''}>
        <summary>{name} advanced</summary>
        <TextField
          label={`${name} hysteresis`}
          pointer={`${at}/hysteresis`}
          value={gate.hysteresis}
          numeric
          unit={unitLabels(measure).interval}
          onChange={(hysteresis) => {
            onChange({ ...gate, hysteresis })
          }}
        />
        <DurationInput
          label={`${name}: stops holding after`}
          pointer={`${at}/clearDuration`}
          value={gate.clearDuration}
          onChange={(clearDuration) => {
            onChange({ ...gate, clearDuration })
          }}
        />
      </details>
      <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onRemove}>
        Remove {name.toLowerCase()}
      </button>
    </fieldset>
  )
}
