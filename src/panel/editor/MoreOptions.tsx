import { useRef, useState } from 'react'
import { RANGE_HYSTERESIS } from '../../model/rangeMessages'
import type { Priority, ZoneLevel } from '../../model/rule'
import { PriorityBadge } from '../list/PriorityBadge'
import { PathPicker } from '../paths/PathPicker'
import type { PathList } from '../paths/selfPaths'
import type { Measure, UnitLookup } from '../signalUnits'
import { CheckField, DurationInput, SelectField, TextField, useFieldErrors } from './fields'
import {
  canLatch,
  emptyGate,
  isZoneLimited,
  MAX_GATES,
  setMode,
  withDetector,
  ZONE_LEVEL_NAMES,
  type RuleForm
} from './formModel'
import { GateFields, zoneText } from './GateFields'
import { SignalFields, useAllInstances } from './SignalFields'
import { clearMarginText, unitLabels } from './words'

/** The priority each zone level alerts at; a test keeps it equal to the model's LEVEL_PRIORITY. */
export const ZONE_PRIORITY: Readonly<Record<ZoneLevel, Priority>> = {
  alert: 'caution',
  warn: 'warning',
  alarm: 'alarm',
  emergency: 'emergency'
}

const LEVELS = ZONE_LEVEL_NAMES.map((value) => ({ value, label: value }))

interface ZonesProps {
  form: RuleForm
  onChange: (form: RuleForm) => void
  measure: Measure
  paths: PathList
  units: UnitLookup
}

/** Use the value's zones: steps from the path's zones instead of typed ones. */
function Zones({ form, onChange, measure, paths, units }: ZonesProps) {
  const { limit } = form.detector
  const zonePathErrors = useFieldErrors('/detector/limit/path')
  const single = form.signal.mode === 'single' ? form.signal.slots[0]?.path : undefined
  const zonePath = limit.path === '' ? single : limit.path
  const entry = zonePath === undefined ? undefined : units.entry(zonePath)
  const from = ZONE_LEVEL_NAMES.indexOf(limit.level)
  const climbed = new Set(ZONE_LEVEL_NAMES.slice(from))
  const zones = (entry?.zones ?? []).filter((z) => climbed.has(z.state as ZoneLevel))
  const zoneMeasure = { ...measure, unit: entry?.unit ?? measure.unit }
  const on = isZoneLimited(form.detector)
  return (
    <>
      <CheckField
        label={<strong>Use the value&apos;s zones</strong>}
        hint="Instead of typing the steps"
        checked={on}
        onChange={(checked) => {
          onChange(withDetector(form, { limit: { ...limit, kind: checked ? 'zone' : 'fixed' } }))
        }}
      />
      {on && (
        <>
          <SelectField
            label="Starting at the zone"
            pointer="/detector/limit/level"
            value={limit.level}
            options={LEVELS}
            onChange={(level) => {
              onChange(withDetector(form, { limit: { ...limit, level } }))
            }}
          />
          {single === undefined && (
            <PathPicker
              label="Zones from path"
              value={limit.path}
              paths={paths}
              errors={zonePathErrors}
              onChange={(path) => {
                onChange(withDetector(form, { limit: { ...limit, path } }))
              }}
            />
          )}
          <div className="skar-card skar-zones">
            {zonePath === undefined || zonePath === '' ? (
              <p className="skar-hint">Choose the path whose zones the rule uses.</p>
            ) : (
              <>
                <p className="skar-hint">
                  From the zones of <span className="skar-mono">{zonePath}</span>
                </p>
                {zones.length === 0 ? (
                  <p className="skar-hint">
                    It reports no zone at this level or above yet, so the rule cannot alert.
                  </p>
                ) : (
                  <ul className="skar-ladder">
                    {zones.map((z) => (
                      <li
                        key={`${z.state} ${String(z.lower)} ${String(z.upper)}`}
                        className="skar-rung"
                      >
                        <PriorityBadge priority={ZONE_PRIORITY[z.state as ZoneLevel]} />
                        <span className="skar-rung-condition">
                          {zoneText(z, zoneMeasure).replace(/^(\w+):/, '$1 zone:')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}

interface MoreOptionsProps {
  form: RuleForm
  onChange: (form: RuleForm) => void
  measure: Measure
  paths: PathList
  units: UnitLookup
  /** A new rule's slug can still be chosen. */
  isNew: boolean
  open: boolean
  onToggle: (open: boolean) => void
}

/** The settings most rules leave as they are, closed until wanted. */
export function MoreOptions({
  form,
  onChange,
  measure,
  paths,
  units,
  isNew,
  open,
  onToggle
}: MoreOptionsProps) {
  const d = form.detector
  const single = form.signal.mode === 'single'
  const slot = form.signal.slots[0] ?? { path: '', source: '' }
  const all = useAllInstances(slot, paths, (next) => {
    onChange({ ...form, signal: { ...form.signal, slots: [next] } })
  })
  // Each condition keeps what it remembers only while its key stays with it through a removal.
  const gateCount = useRef(form.gates.length)
  const [gateKeys, setGateKeys] = useState(() => form.gates.map((_, i) => i))
  // The validator's "half the first step's range" says neither the range nor the margin it allows.
  const first = form.steps.at(0)
  const marginErrors = useFieldErrors('/detector/hysteresis').map((message) =>
    d.type === 'outside' && message === RANGE_HYSTERESIS && first !== undefined
      ? (clearMarginText(first, measure) ?? message)
      : message
  )
  return (
    <details
      className="skar-more"
      open={open}
      onToggle={(event) => {
        onToggle(event.currentTarget.open)
      }}
    >
      <summary className="skar-more-summary">More options</summary>
      <div className="skar-more-body">
        {(d.type === 'sustained' || d.type === 'outside') && (
          <>
            <TextField
              label="Clear margin"
              extraErrors={marginErrors}
              value={d.hysteresis}
              nonNegative
              unit={unitLabels(measure).interval}
              hint={
                d.type === 'outside'
                  ? 'How far inside the range the value must come back to clear. Empty is none.'
                  : 'How far back past the limit the value must go to clear. Empty is none.'
              }
              onChange={(hysteresis) => {
                onChange(withDetector(form, { hysteresis }))
              }}
            />
            <DurationInput
              label="Clear delay"
              pointer="/detector/clearDuration"
              value={d.clearDuration}
              hint="How long the value must stay clear. Empty clears at once."
              onChange={(clearDuration) => {
                onChange(withDetector(form, { clearDuration }))
              }}
            />
          </>
        )}
        {canLatch(d) && (
          <CheckField
            label="Keep the alert until acknowledged"
            pointer="/latching"
            checked={form.latching}
            onChange={(latching) => {
              onChange({ ...form, latching })
            }}
          />
        )}
        <div className="skar-subsection">
          <span className="skar-label">Only while…</span>
          <p className="skar-hint">
            The rule is in use only while every condition holds; one that stops holding clears the
            rule&apos;s alert.
          </p>
          {form.gates.map((gate, i) => (
            <GateFields
              key={gateKeys[i]}
              index={i}
              gate={gate}
              paths={paths}
              units={units}
              onChange={(next) => {
                onChange({ ...form, gates: form.gates.map((g, n) => (n === i ? next : g)) })
              }}
              onRemove={() => {
                onChange({ ...form, gates: form.gates.filter((_, n) => n !== i) })
                setGateKeys((keys) => keys.filter((_, n) => n !== i))
              }}
            />
          ))}
          {form.gates.length < MAX_GATES && (
            <div>
              <button
                type="button"
                className="skar-btn skar-btn-ghost skar-btn-small"
                onClick={() => {
                  onChange({ ...form, gates: [...form.gates, emptyGate()] })
                  const key = gateCount.current
                  gateCount.current = key + 1
                  setGateKeys((keys) => [...keys, key])
                }}
              >
                Add a condition
              </button>
            </div>
          )}
        </div>
        <CheckField
          label="Combine with other paths"
          checked={!single}
          onChange={(combine) => {
            onChange({ ...form, signal: setMode(form.signal, combine ? 'combine' : 'single') })
          }}
        />
        {!single && (
          <SignalFields
            label="Combined"
            at="/signal"
            signal={form.signal}
            paths={paths}
            units={units}
            modeToggle={false}
            onChange={(signal) => {
              onChange({ ...form, signal })
            }}
          />
        )}
        {single && all.available && (
          <CheckField
            label="Every instance, one alert each"
            checked={all.checked}
            onChange={all.toggle}
            hint={all.hint}
          />
        )}
        {(d.type === 'sustained' || d.type === 'projection') && (
          <Zones form={form} onChange={onChange} measure={measure} paths={paths} units={units} />
        )}
        {isNew && (
          <TextField
            label="Slug"
            pointer="/slug"
            value={form.slug}
            hint="Identifies the rule in links. Fixed once the rule is saved."
            onChange={(slug) => {
              onChange({ ...form, slug, slugFollowsName: false })
            }}
          />
        )}
      </div>
    </details>
  )
}
