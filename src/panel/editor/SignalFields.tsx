import { useState } from 'react'
import { PathPicker } from '../paths/PathPicker'
import type { PathList } from '../paths/selfPaths'
import { matchedInstances, withInstanceWildcard, type UnitLookup } from '../signalUnits'
import { CheckField, RadioGroup, SelectField, useFieldErrors, type Option } from './fields'
import {
  ANGULAR_KINDS,
  canAddSlot,
  canRemoveSlot,
  COMBINATOR_KINDS,
  setCombinator,
  setMode,
  slotUnitErrors,
  type SignalForm,
  type SlotForm
} from './formModel'

const COMBINATOR_LABELS: Readonly<Record<(typeof COMBINATOR_KINDS)[number], string>> = {
  difference: 'Difference: first minus second',
  absDifference: 'Absolute difference of two',
  ratio: 'Ratio: first divided by second',
  spread: 'Spread: largest minus smallest',
  mean: 'Mean',
  median: 'Median',
  distance: 'Distance between two positions',
  positionSpread: 'Largest distance between positions'
}

const COMBINATOR_OPTIONS: readonly Option<(typeof COMBINATOR_KINDS)[number]>[] =
  COMBINATOR_KINDS.map((value) => ({ value, label: COMBINATOR_LABELS[value] }))

const MODES = [
  { value: 'single', label: 'Single path' },
  { value: 'combine', label: 'Combine paths' }
] as const

export interface SignalFieldsProps {
  /** Names the fields: "Input", or "Gate 1 input". */
  label: string
  /** The signal's JSON pointer in the rule. */
  at: string
  signal: SignalForm
  onChange: (signal: SignalForm) => void
  paths: PathList
  units: UnitLookup
}

function sourceOptions(slot: SlotForm, units: UnitLookup): Option<string>[] {
  const reported = units.entry(slot.path)?.sources ?? []
  // A source that is not reporting now, as a stored rule may name, stays selectable.
  const all =
    slot.source === '' || reported.includes(slot.source) ? reported : [slot.source, ...reported]
  return [{ value: '', label: 'Preferred source' }, ...all.map((s) => ({ value: s, label: s }))]
}

interface SlotProps {
  label: string
  at: string
  slot: SlotForm
  onChange: (slot: SlotForm) => void
  paths: PathList
  units: UnitLookup
  unitError?: string
  /** Offers to match every instance: only for a single path. */
  wildcard: boolean
}

function Slot({ label, at, slot, onChange, paths, units, unitError, wildcard }: SlotProps) {
  // A save attempt reports the unit mismatch the slot already shows while typing.
  const pathErrors = [
    ...new Set([...useFieldErrors(`${at}/path`), ...(unitError === undefined ? [] : [unitError])])
  ]
  // The instance the wildcard replaced, restored when the toggle is turned off.
  const [instance, setInstance] = useState<string | undefined>(undefined)
  const segments = slot.path.split('.')
  const wildAt = segments.indexOf('*')
  const pattern = wildAt >= 0 ? slot.path : withInstanceWildcard(slot.path)
  const matched =
    wildAt >= 0 && paths.status === 'ready' ? matchedInstances(slot.path, paths.paths) : []

  const toggle = (on: boolean) => {
    if (on && pattern !== undefined) {
      const at = pattern.split('.').indexOf('*')
      setInstance(segments[at])
      onChange({ ...slot, path: pattern })
    } else if (!on && wildAt >= 0) {
      const back = instance ?? matched.at(0)
      if (back !== undefined) {
        onChange({ ...slot, path: segments.map((s, i) => (i === wildAt ? back : s)).join('.') })
      }
    }
  }

  return (
    <div className="skar-slot">
      <PathPicker
        label={label}
        value={slot.path}
        paths={paths}
        errors={pathErrors}
        onChange={(path) => {
          // A source kept from the old path would read a path it never reports,
          // so the rule would never alert.
          const kept = units.entry(path)?.sources?.includes(slot.source) === true
          onChange({ ...slot, path, source: kept ? slot.source : '' })
        }}
      />
      <SelectField
        label={`Source for ${label.toLowerCase()}`}
        pointer={`${at}/source`}
        value={slot.source}
        options={sourceOptions(slot, units)}
        onChange={(source) => {
          onChange({ ...slot, source })
        }}
      />
      {wildcard && (
        <CheckField
          label="Match all instances"
          checked={wildAt >= 0}
          disabled={wildAt < 0 && pattern === undefined}
          onChange={toggle}
          hint={
            wildAt >= 0
              ? matched.length === 0
                ? 'No reported path matches yet.'
                : `Matches now: ${matched.join(', ')}`
              : pattern === undefined
                ? 'This path has no instance segment; type * in place of one to match several.'
                : `Matches ${pattern}, one alert per instance.`
          }
        />
      )}
    </div>
  )
}

/** A signal: one path, or a combination of paths, each with an optional source. */
export function SignalFields({ label, at, signal, onChange, paths, units }: SignalFieldsProps) {
  const unitErrors = slotUnitErrors(signal, units)
  const setSlot = (index: number, slot: SlotForm) => {
    onChange({ ...signal, slots: signal.slots.map((s, i) => (i === index ? slot : s)) })
  }

  if (signal.mode === 'single') {
    return (
      <div className="skar-signal">
        <RadioGroup
          legend={label}
          value={signal.mode}
          options={MODES}
          onChange={(mode) => {
            onChange(setMode(signal, mode))
          }}
        />
        <Slot
          label={`${label} path`}
          at={at}
          slot={signal.slots[0] ?? { path: '', source: '' }}
          onChange={(slot) => {
            setSlot(0, slot)
          }}
          paths={paths}
          units={units}
          wildcard
        />
      </div>
    )
  }

  return (
    <div className="skar-signal">
      <RadioGroup
        legend={label}
        value={signal.mode}
        options={MODES}
        onChange={(mode) => {
          onChange(setMode(signal, mode))
        }}
      />
      <SelectField
        label={`${label} combination`}
        pointer={`${at}/combinator`}
        value={signal.combinator}
        options={COMBINATOR_OPTIONS}
        onChange={(kind) => {
          onChange(setCombinator(signal, kind))
        }}
      />
      {ANGULAR_KINDS.has(signal.combinator) && (
        <CheckField
          label="Values are angles, wrapping at a full turn"
          pointer={`${at}/angular`}
          checked={signal.angular}
          onChange={(angular) => {
            onChange({ ...signal, angular })
          }}
        />
      )}
      {signal.slots.map((slot, i) => (
        <Slot
          key={i}
          label={`${label} path ${String(i + 1)}`}
          at={`${at}/inputs/${String(i)}`}
          slot={slot}
          onChange={(next) => {
            setSlot(i, next)
          }}
          paths={paths}
          units={units}
          unitError={unitErrors[i]}
          wildcard={false}
        />
      ))}
      <div className="skar-slot-actions">
        {canAddSlot(signal) && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm me-2"
            onClick={() => {
              onChange({ ...signal, slots: [...signal.slots, { path: '', source: '' }] })
            }}
          >
            Add path
          </button>
        )}
        {canRemoveSlot(signal) && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => {
              onChange({ ...signal, slots: signal.slots.slice(0, -1) })
            }}
          >
            Remove last path
          </button>
        )}
      </div>
    </div>
  )
}
