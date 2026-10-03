import { useState } from 'react'
import { PathPicker } from '../paths/PathPicker'
import type { PathList } from '../paths/selfPaths'
import { COMBINATOR_LABELS } from '../rules/describe'
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

const COMBINATOR_OPTIONS: readonly Option<(typeof COMBINATOR_KINDS)[number]>[] =
  COMBINATOR_KINDS.map((value) => ({ value, label: COMBINATOR_LABELS[value] }))

const MODES = [
  { value: 'single', label: 'Single path' },
  { value: 'combine', label: 'Combine paths' }
] as const

/**
 * The sources to offer for a path: the preferred source, then those that
 * report it, all in canonical form. A source that is not reporting now, as a
 * stored rule may name, stays selectable.
 */
export function sourceOptions(slot: SlotForm, units: UnitLookup): Option<string>[] {
  const entry = units.entry(slot.path)
  const reported = entry?.sources ?? []
  const all =
    slot.source === '' || reported.includes(slot.source) ? reported : [slot.source, ...reported]
  const preferred =
    entry?.preferredSource === undefined
      ? 'Preferred source'
      : `Preferred source (server's choice): ${entry.preferredSource}`
  return [{ value: '', label: preferred }, ...all.map((s) => ({ value: s, label: s }))]
}

/**
 * The slot with a new path. A source kept from the old path would read a
 * path it never reports, so the rule would never alert; one the new path
 * also reports stays.
 */
export function withPath(slot: SlotForm, path: string, units: UnitLookup): SlotForm {
  const kept = units.entry(path)?.sources?.includes(slot.source) === true
  return { ...slot, path, source: kept ? slot.source : '' }
}

/** Matching every instance of a path: the toggle's state, and turning it on and off. */
export function useAllInstances(
  slot: SlotForm,
  paths: PathList,
  onChange: (slot: SlotForm) => void
) {
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
  const hint =
    wildAt >= 0
      ? matched.length === 0
        ? 'No reported path matches yet.'
        : `Matches now: ${matched.join(', ')}`
      : pattern === undefined
        ? 'This path has no instance segment; type * in place of one to match several.'
        : `Matches ${pattern}, one alert per instance.`
  return { checked: wildAt >= 0, available: wildAt >= 0 || pattern !== undefined, hint, toggle }
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
  const all = useAllInstances(slot, paths, onChange)
  return (
    <div className="skar-slot">
      <PathPicker
        label={label}
        value={slot.path}
        paths={paths}
        errors={pathErrors}
        onChange={(path) => {
          onChange(withPath(slot, path, units))
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
          checked={all.checked}
          disabled={!all.available}
          onChange={all.toggle}
          hint={all.hint}
        />
      )}
    </div>
  )
}

export interface SignalFieldsProps {
  /** Names the fields: "Input", or "Condition 1 input". */
  label: string
  /** The signal's JSON pointer in the rule. */
  at: string
  signal: SignalForm
  onChange: (signal: SignalForm) => void
  paths: PathList
  units: UnitLookup
  /** Offers the choice between a single path and a combination; off where another control makes it. */
  modeToggle?: boolean
}

/** A signal: one path, or a combination of paths, each with an optional source. */
export function SignalFields({
  label,
  at,
  signal,
  onChange,
  paths,
  units,
  modeToggle = true
}: SignalFieldsProps) {
  const unitErrors = slotUnitErrors(signal, units)
  const setSlot = (index: number, slot: SlotForm) => {
    onChange({ ...signal, slots: signal.slots.map((s, i) => (i === index ? slot : s)) })
  }
  const toggle = modeToggle && (
    <RadioGroup
      legend={label}
      value={signal.mode}
      options={MODES}
      onChange={(mode) => {
        onChange(setMode(signal, mode))
      }}
    />
  )

  if (signal.mode === 'single') {
    return (
      <div className="skar-signal">
        {toggle}
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
      {toggle}
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
      <div className="skar-row-actions">
        {canAddSlot(signal) && (
          <button
            type="button"
            className="skar-btn skar-btn-ghost skar-btn-small"
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
            className="skar-btn skar-btn-ghost skar-btn-small"
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
