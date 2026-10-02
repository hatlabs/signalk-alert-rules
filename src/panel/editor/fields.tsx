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
  className: string
  'aria-describedby'?: string
  'aria-invalid'?: true
  'aria-required'?: true
}

/** The mark after a required field's label; its meaning is said once, by the form. */
export function Required() {
  return (
    <span className="skar-required" aria-hidden="true">
      {' *'}
    </span>
  )
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
  required?: boolean
  children: (control: ControlProps) => ReactNode
}

function described(...ids: (string | false)[]): string | undefined {
  const joined = ids.filter((id) => id !== false).join(' ')
  return joined === '' ? undefined : joined
}

/** A label, a control, its unit, hint and errors, wired together for assistive technology. */
export function Field({
  label,
  pointer,
  hint,
  extraErrors = [],
  prefix,
  unit,
  required = false,
  children
}: FieldProps) {
  const id = useId()
  const errors = [
    ...useFieldErrors(pointer),
    ...extraErrors.filter((e): e is string => e !== undefined)
  ]
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = described(hint !== undefined && hintId, errors.length > 0 && errorId)
  const control: ControlProps = {
    id,
    className: errors.length === 0 ? 'skar-input' : 'skar-input skar-input-invalid',
    ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
    ...(errors.length === 0 ? {} : { 'aria-invalid': true }),
    ...(required ? { 'aria-required': true } : {})
  }
  return (
    <div className="skar-field">
      <label htmlFor={id} className="skar-label">
        {label}
        {required && <Required />}
      </label>
      {(unit === undefined || unit === '') && prefix === undefined ? (
        children(control)
      ) : (
        <div className="skar-input-row">
          {prefix !== undefined && <span className="skar-mono skar-prefix">{prefix}</span>}
          {children(control)}
          {unit !== undefined && unit !== '' && <span className="skar-unit">{unit}</span>}
        </div>
      )}
      {errors.length > 0 && (
        <div id={errorId} className="skar-error">
          {errors.join('; ')}
        </div>
      )}
      {hint !== undefined && (
        <div id={hintId} className="skar-hint">
          {hint}
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
  required?: boolean
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

interface SelectControlProps<T extends string> {
  value: T | ''
  options: readonly Option<T>[]
  onChange: (value: T) => void
}

/** A select of typed options, prompting for a choice while none is made. */
export function SelectControl<T extends string>({
  value,
  options,
  onChange,
  ...control
}: SelectControlProps<T> & Partial<ControlProps> & { 'aria-label'?: string }) {
  // Nothing chosen yet shows a prompt, unless the empty value is itself an option.
  const unchosen = value === '' && !options.some((o) => o.value === '')
  return (
    <select
      className="skar-input"
      {...control}
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
  )
}

interface SelectProps<T extends string> {
  label: string
  pointer?: string
  value: T | ''
  options: readonly Option<T>[]
  onChange: (value: T) => void
  hint?: ReactNode
  required?: boolean
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  ...field
}: SelectProps<T>) {
  return (
    <Field label={label} {...field}>
      {(control) => (
        <SelectControl {...control} value={value} options={options} onChange={onChange} />
      )}
    </Field>
  )
}

interface CheckProps {
  label: ReactNode
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
  return (
    <div className="skar-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={described(hint !== undefined && hintId, errors.length > 0 && errorId)}
        aria-invalid={errors.length === 0 ? undefined : true}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
      />
      <div className="skar-check-text">
        <label htmlFor={id}>{label}</label>
        {hint !== undefined && (
          <div id={hintId} className="skar-hint">
            {hint}
          </div>
        )}
        {errors.length > 0 && (
          <div id={errorId} className="skar-error">
            {errors.join('; ')}
          </div>
        )}
      </div>
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
      className="skar-field skar-radios"
      aria-describedby={errors.length === 0 ? undefined : errorId}
      aria-invalid={errors.length === 0 ? undefined : true}
    >
      <legend className="skar-label">{legend}</legend>
      {options.map((o) => {
        const id = `${name}-${o.value}`
        return (
          <div key={o.value} className="skar-check">
            <input
              id={id}
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => {
                onChange(o.value)
              }}
            />
            <label htmlFor={id} className="skar-check-text">
              {o.label}
              {o.description !== undefined && <span className="skar-hint">{o.description}</span>}
            </label>
          </div>
        )
      })}
      {errors.length > 0 && (
        <div id={errorId} className="skar-error">
          {errors.join('; ')}
        </div>
      )}
    </fieldset>
  )
}

export const DURATION_UNITS: readonly Option<DurationUnit>[] = [
  { value: 's', label: 's' },
  { value: 'min', label: 'min' },
  { value: 'h', label: 'h' }
]

interface DurationControlProps {
  /** Names the unit select after the amount. */
  label: string
  value: DurationField
  onChange: (value: DurationField) => void
  control: Partial<ControlProps> & { 'aria-label'?: string }
}

/** An amount and the unit it is in, side by side. */
export function DurationControl({ label, value, onChange, control }: DurationControlProps) {
  return (
    <div className="skar-duration">
      <input
        className="skar-input"
        {...control}
        type="text"
        inputMode="decimal"
        value={value.amount}
        onChange={(e) => {
          onChange({ ...value, amount: e.target.value })
        }}
      />
      <SelectControl
        aria-label={`${label} unit`}
        className="skar-input skar-duration-unit"
        value={value.unit}
        options={DURATION_UNITS}
        onChange={(unit) => {
          onChange({ ...value, unit })
        }}
      />
    </div>
  )
}

interface DurationProps {
  label: string
  pointer?: string
  value: DurationField
  onChange: (value: DurationField) => void
  hint?: ReactNode
  required?: boolean
}

export function DurationInput({ label, value, onChange, ...field }: DurationProps) {
  return (
    <Field label={label} {...field}>
      {(control) => (
        <DurationControl label={label} value={value} onChange={onChange} control={control} />
      )}
    </Field>
  )
}

/** What kind of value a path reports, from a reading of it; undefined while unknown. */
export type ValueKind = 'number' | 'text' | 'boolean'

export function valueKindOf(value: unknown): ValueKind | undefined {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'text'
  return undefined
}

const VALUE_TYPES: readonly Option<ValueField['type']>[] = [
  { value: 'number', label: 'number' },
  { value: 'text', label: 'text' },
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' }
]

const BOOLEANS: readonly Option<'true' | 'false'>[] = [
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' }
]

interface ValueControlProps {
  label: string
  value: ValueField
  onChange: (value: ValueField) => void
  /** The unit a number is entered in. */
  unit: string
  /** What the path reports, which decides how the value is entered; unknown offers every type. */
  kind: ValueKind | undefined
  control: Partial<ControlProps> & { 'aria-label'?: string }
}

/**
 * A value to compare with, entered as the path reports its values: a number
 * in the display unit, text, or true or false. A path not reported yet
 * offers the choice of type.
 */
export function ValueControl({ label, value, onChange, unit, kind, control }: ValueControlProps) {
  if (kind === 'boolean') {
    return (
      <SelectControl
        {...control}
        value={value.type === 'true' || value.type === 'false' ? value.type : ''}
        options={BOOLEANS}
        onChange={(type) => {
          onChange({ type, text: '' })
        }}
      />
    )
  }
  const typed = (
    <div className="skar-input-row">
      <input
        className="skar-input"
        {...control}
        type="text"
        inputMode={value.type === 'number' ? 'decimal' : undefined}
        value={value.text}
        onChange={(e) => {
          onChange({
            type: kind ?? (value.type === 'text' ? 'text' : 'number'),
            text: e.target.value
          })
        }}
      />
      {value.type === 'number' && unit !== '' && <span className="skar-unit">{unit}</span>}
    </div>
  )
  if (kind !== undefined) return typed
  return (
    <div className="skar-value">
      <SelectControl
        aria-label={`${label} type`}
        className="skar-input skar-value-type"
        value={value.type}
        options={VALUE_TYPES}
        onChange={(type) => {
          onChange({ ...value, type })
        }}
      />
      {(value.type === 'number' || value.type === 'text') && typed}
    </div>
  )
}

interface ValueProps {
  label: string
  pointer?: string
  value: ValueField
  onChange: (value: ValueField) => void
  unit: string
  kind: ValueKind | undefined
  required?: boolean
}

export function ValueInput({ label, value, onChange, unit, kind, ...field }: ValueProps) {
  return (
    <Field label={label} {...field}>
      {(control) => (
        <ValueControl
          label={label}
          value={value}
          onChange={onChange}
          unit={unit}
          kind={kind}
          control={control}
        />
      )}
    </Field>
  )
}
