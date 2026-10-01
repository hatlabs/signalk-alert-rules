import { createContext, useContext, useId, type ReactNode } from 'react'
import type { DurationField, DurationUnit, ValueField } from './formModel'

/** Error messages by the JSON pointer of the field that shows them. */
export const FieldErrors = createContext<ReadonlyMap<string, string[]>>(new Map())

export function useFieldErrors(pointer: string | undefined): string[] {
  const errors = useContext(FieldErrors)
  return pointer === undefined ? [] : (errors.get(pointer) ?? [])
}

export interface ControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

interface FieldProps {
  label: string
  /** The rule field this control edits, whose errors it shows. */
  pointer?: string
  hint?: ReactNode
  /** Extra messages, such as a check made while typing. */
  extraErrors?: (string | undefined)[]
  /** Read-only text before the control, such as the fixed part of a path. */
  prefix?: string
  unit?: string
  children: (control: ControlProps) => ReactNode
}

/** A label, a control, its unit, hint and errors, wired together for assistive technology. */
export function Field({
  label,
  pointer,
  hint,
  extraErrors = [],
  prefix,
  unit,
  children
}: FieldProps) {
  const id = useId()
  const errors = [
    ...useFieldErrors(pointer),
    ...extraErrors.filter((e): e is string => e !== undefined)
  ]
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const described = [hint === undefined ? '' : hintId, errors.length === 0 ? '' : errorId]
    .filter((s) => s !== '')
    .join(' ')
  const control: ControlProps = {
    id,
    ...(described === '' ? {} : { 'aria-describedby': described }),
    ...(errors.length === 0 ? {} : { 'aria-invalid': true })
  }
  return (
    <div className="skar-field">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      {(unit === undefined || unit === '') && prefix === undefined ? (
        children(control)
      ) : (
        <div className="input-group input-group-sm">
          {prefix !== undefined && (
            <span className="input-group-text text-wrap text-break">{prefix}</span>
          )}
          {children(control)}
          {unit !== undefined && unit !== '' && <span className="input-group-text">{unit}</span>}
        </div>
      )}
      {hint !== undefined && (
        <div id={hintId} className="form-text">
          {hint}
        </div>
      )}
      {errors.length > 0 && (
        <div id={errorId} className="invalid-feedback d-block">
          {errors.join('; ')}
        </div>
      )}
    </div>
  )
}

interface TextProps {
  label: string
  pointer?: string
  value: string
  onChange: (value: string) => void
  hint?: ReactNode
  unit?: string
  extraErrors?: (string | undefined)[]
  prefix?: string
  placeholder?: string
  /** A number: the keyboard offers digits, and the text is kept as typed. */
  numeric?: boolean
  readOnly?: boolean
}

export function TextField({
  label,
  value,
  onChange,
  numeric,
  readOnly,
  placeholder,
  ...field
}: TextProps) {
  return (
    <Field label={label} {...field}>
      {(control) => (
        <input
          {...control}
          type="text"
          className="form-control form-control-sm"
          inputMode={numeric === true ? 'decimal' : undefined}
          readOnly={readOnly}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        />
      )}
    </Field>
  )
}

export interface Option<T extends string> {
  value: T
  label: string
}

interface SelectProps<T extends string> {
  label: string
  pointer?: string
  value: T | ''
  options: readonly Option<T>[]
  onChange: (value: T) => void
  hint?: ReactNode
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  ...field
}: SelectProps<T>) {
  // Nothing chosen yet shows a prompt, unless the empty value is itself an option.
  const unchosen = value === '' && !options.some((o) => o.value === '')
  return (
    <Field label={label} {...field}>
      {(control) => (
        <select
          {...control}
          className="form-select form-select-sm"
          value={value}
          onChange={(e) => {
            const chosen = options.find((o) => o.value === e.target.value)
            if (chosen !== undefined) onChange(chosen.value)
          }}
        >
          {unchosen && (
            <option value="" disabled>
              Choose…
            </option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

interface CheckProps {
  label: string
  pointer?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  hint?: ReactNode
}

export function CheckField({ label, pointer, checked, onChange, disabled, hint }: CheckProps) {
  const id = useId()
  const errors = useFieldErrors(pointer)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const described = [hint === undefined ? '' : hintId, errors.length === 0 ? '' : errorId]
    .filter((s) => s !== '')
    .join(' ')
  return (
    <div className="form-check skar-field">
      <input
        id={id}
        type="checkbox"
        className="form-check-input"
        checked={checked}
        disabled={disabled}
        aria-describedby={described === '' ? undefined : described}
        aria-invalid={errors.length === 0 ? undefined : true}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
      />
      <label htmlFor={id} className="form-check-label">
        {label}
      </label>
      {hint !== undefined && (
        <div id={hintId} className="form-text">
          {hint}
        </div>
      )}
      {errors.length > 0 && (
        <div id={errorId} className="invalid-feedback d-block">
          {errors.join('; ')}
        </div>
      )}
    </div>
  )
}

interface RadioProps<T extends string> {
  legend: string
  pointer?: string
  value: T | ''
  options: readonly (Option<T> & { description?: string })[]
  onChange: (value: T) => void
}

export function RadioGroup<T extends string>({
  legend,
  pointer,
  value,
  options,
  onChange
}: RadioProps<T>) {
  const name = useId()
  const errors = useFieldErrors(pointer)
  const errorId = `${name}-error`
  return (
    <fieldset
      className="skar-field"
      aria-describedby={errors.length === 0 ? undefined : errorId}
      aria-invalid={errors.length === 0 ? undefined : true}
    >
      <legend className="form-label fs-6">{legend}</legend>
      {options.map((o) => {
        const id = `${name}-${o.value}`
        return (
          <div key={o.value} className="form-check">
            <input
              id={id}
              type="radio"
              className="form-check-input"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => {
                onChange(o.value)
              }}
            />
            <label htmlFor={id} className="form-check-label">
              {o.label}
              {o.description !== undefined && (
                <span className="form-text d-block">{o.description}</span>
              )}
            </label>
          </div>
        )
      })}
      {errors.length > 0 && (
        <div id={errorId} className="invalid-feedback d-block">
          {errors.join('; ')}
        </div>
      )}
    </fieldset>
  )
}

const DURATION_UNITS: readonly Option<DurationUnit>[] = [
  { value: 's', label: 'seconds' },
  { value: 'min', label: 'minutes' },
  { value: 'h', label: 'hours' }
]

interface DurationProps {
  label: string
  pointer?: string
  value: DurationField
  onChange: (value: DurationField) => void
  hint?: ReactNode
}

/** An amount and its unit; the unit select is named after the amount's label. */
export function DurationInput({ label, pointer, value, onChange, hint }: DurationProps) {
  return (
    <Field label={label} pointer={pointer} hint={hint}>
      {(control) => (
        <div className="input-group input-group-sm">
          <input
            {...control}
            type="text"
            inputMode="decimal"
            className="form-control form-control-sm"
            value={value.amount}
            onChange={(e) => {
              onChange({ ...value, amount: e.target.value })
            }}
          />
          <select
            aria-label={`${label} unit`}
            className="form-select form-select-sm skar-duration-unit"
            value={value.unit}
            onChange={(e) => {
              const unit = DURATION_UNITS.find((u) => u.value === e.target.value)?.value
              if (unit !== undefined) onChange({ ...value, unit })
            }}
          >
            {DURATION_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </Field>
  )
}

const VALUE_TYPES: readonly Option<ValueField['type']>[] = [
  { value: 'number', label: 'number' },
  { value: 'text', label: 'text' },
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' }
]

interface ValueProps {
  label: string
  pointer?: string
  value: ValueField
  onChange: (value: ValueField) => void
  /** The unit a number is entered in. */
  unit: string
}

/** A value to compare with: a number in the display unit, a text, or true or false. */
export function ValueInput({ label, pointer, value, onChange, unit }: ValueProps) {
  const typed = value.type === 'number' || value.type === 'text'
  return (
    <div className="skar-value">
      <SelectField
        label={`${label} type`}
        value={value.type}
        options={VALUE_TYPES}
        onChange={(type) => {
          onChange({ ...value, type })
        }}
      />
      {typed && (
        <TextField
          label={label}
          pointer={pointer}
          value={value.text}
          numeric={value.type === 'number'}
          unit={value.type === 'number' ? unit : undefined}
          onChange={(text) => {
            onChange({ ...value, text })
          }}
        />
      )}
      {!typed && <FieldErrorsOnly pointer={pointer} />}
    </div>
  )
}

/** Errors for a field whose control is not shown, such as a boolean value. */
function FieldErrorsOnly({ pointer }: { pointer?: string }) {
  const errors = useFieldErrors(pointer)
  if (errors.length === 0) return null
  return <div className="invalid-feedback d-block">{errors.join('; ')}</div>
}
