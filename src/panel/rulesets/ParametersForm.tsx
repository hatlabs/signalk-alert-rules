import { useId, useMemo, useState, type SyntheticEvent } from 'react'
import { RuleRejectedError, type FieldError } from '../api'
import { Field, FieldErrors } from '../editor/fields'
import { unitLabel, type DisplayUnit } from '../units'
import type { Parameter, RulesetEntry } from './api'
import { initialDraft, shownValue, valuesToSend, type Draft, type Values } from './parameters'

export interface ParametersFormProps {
  ruleset: RulesetEntry
  unitOf: (p: Parameter) => DisplayUnit
  /** Sends the whole values object; a refusal rejects with RuleRejectedError. */
  save: (values: Values) => Promise<void>
}

function hint(p: Parameter, unit: DisplayUnit, atDefault: boolean): string {
  const withUnit = (v: number | string) =>
    p.type === 'number' && unit.symbol !== ''
      ? `${shownValue(p, v, unit)} ${unit.symbol}`
      : shownValue(p, v, unit)
  const { minimum, maximum } = p
  const range =
    minimum !== undefined && maximum !== undefined
      ? `Allowed from ${withUnit(minimum)} to ${withUnit(maximum)}.`
      : minimum !== undefined
        ? `At least ${withUnit(minimum)}.`
        : maximum !== undefined
          ? `At most ${withUnit(maximum)}.`
          : undefined
  return [
    p.description === undefined ? undefined : p.description.replace(/\.?$/, '.'),
    `${atDefault ? 'Uses the default' : 'Default'} ${withUnit(p.default)}.`,
    range
  ]
    .filter((s): s is string => s !== undefined)
    .join(' ')
}

/**
 * A ruleset's parameters. The fields start from the stored values; the form
 * is mounted afresh when those change, so a save or another admin's change
 * shows as stored rather than as a pending edit.
 */
export function ParametersForm({ ruleset, unitOf, save }: ParametersFormProps) {
  const { parameters, values } = ruleset
  const initial = useMemo(
    () => initialDraft(parameters, values, unitOf),
    [parameters, values, unitOf]
  )
  const [draft, setDraft] = useState<Draft>(initial)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const headingId = useId()

  const dirty = parameters.some((p) => draft[p.name] !== initial[p.name])
  const byField = new Map<string, string[]>()
  for (const e of errors) byField.set(e.path, [...(byField.get(e.path) ?? []), e.message])
  const placed = new Set(parameters.map((p) => `/${p.name}`))
  const messages = [
    ...errors.filter((e) => !placed.has(e.path)).map((e) => e.message),
    ...(failure === undefined ? [] : [failure])
  ]

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setFailure(undefined)
    const outcome = valuesToSend(parameters, values, initial, draft, unitOf)
    if (!outcome.ok) {
      setErrors(outcome.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      await save(outcome.values)
    } catch (err) {
      if (err instanceof RuleRejectedError && err.errors.length > 0) setErrors(err.errors)
      else setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FieldErrors.Provider value={byField}>
      <form
        aria-label={`Parameters of ${ruleset.name}`}
        className="skar-parameters"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <h5 id={headingId} className="skar-section-heading">
          Parameters
        </h5>
        {messages.length > 0 && (
          <div className="alert alert-danger" role="alert">
            <p className="mb-1">The values were not saved.</p>
            <ul className="mb-0">
              {messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {parameters.map((p) => {
          const unit = unitOf(p)
          const text = draft[p.name]
          const atDefault = text === undefined
          return (
            <div key={p.name} className="skar-parameter">
              <Field
                label={p.name}
                pointer={`/${p.name}`}
                hint={hint(p, unit, atDefault)}
                {...(p.type === 'number' ? { unit: unitLabel('absolute', unit) } : {})}
              >
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    className="form-control form-control-sm"
                    inputMode={p.type === 'number' ? 'decimal' : undefined}
                    value={text ?? shownValue(p, p.default, unit)}
                    onChange={(e) => {
                      setDraft({ ...draft, [p.name]: e.target.value })
                    }}
                  />
                )}
              </Field>
              <button
                type="button"
                className="btn btn-link btn-sm skar-reset-default"
                aria-label={`Reset ${p.name} to default`}
                disabled={atDefault || busy}
                onClick={() => {
                  setDraft({ ...draft, [p.name]: undefined })
                }}
              >
                Reset to default
              </button>
            </div>
          )
        })}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || busy}>
          Save parameters
        </button>
      </form>
    </FieldErrors.Provider>
  )
}
