// The register screen's controls, drawn only with care-entry's form classes (DESIGN_SYSTEM §10.2):
// the Angular wizard's Clarity inputs, selects, radios, textareas and checkboxes, one for one.
// Every control carries its Angular formControlName as `name`, so the two can be compared.
import type { ReactNode } from 'react'
import { FieldError } from '../../components/patient/AgeConfirm'
import { cn } from '../../utils/cn'
import { errorClass, hintClass, inputClass, labelClass } from '../../utils/formClasses'
import type { Option } from '../../../shri-health/registration'

const checkboxClass = 'mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-primary-600)]'

interface Base {
  id: string
  name: string
  label: ReactNode
  required?: boolean
  error?: string
  hint?: ReactNode
}

function Label({ id, label, required }: { id?: string; label: ReactNode; required?: boolean }) {
  if (!label) return null
  return (
    <label htmlFor={id} className={labelClass}>
      {label}
      {required ? <span className="text-critical-fg">*</span> : null}
    </label>
  )
}

function Message({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  if (error) return <FieldError id={`${id}-error`} message={error} />
  return hint ? (
    <p id={`${id}-hint`} className={hintClass}>
      {hint}
    </p>
  ) : null
}

export function TextField({
  id,
  name,
  label,
  required,
  error,
  hint,
  value,
  onChange,
  onBlur,
  type = 'text',
  inputMode,
  max,
  maxLength,
}: Base & {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  type?: 'text' | 'email' | 'tel' | 'date'
  inputMode?: 'text' | 'numeric' | 'tel' | 'email'
  max?: string
  maxLength?: number
}) {
  return (
    <div>
      <Label id={id} label={label} required={required} />
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        max={max}
        maxLength={maxLength}
        inputMode={inputMode}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(inputClass, error && errorClass)}
      />
      <Message id={id} error={error} hint={hint} />
    </div>
  )
}

export function TextAreaField({
  id,
  name,
  label,
  error,
  value,
  onChange,
  onBlur,
}: Base & { value: string; onChange: (value: string) => void; onBlur?: () => void }) {
  return (
    <div>
      <Label id={id} label={label} />
      <textarea
        id={id}
        name={name}
        value={value}
        rows={3}
        maxLength={100}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(inputClass, 'py-2.5', error && errorClass)}
      />
      <Message id={id} error={error} />
    </div>
  )
}

export function SelectField({
  id,
  name,
  label,
  required,
  error,
  value,
  onChange,
  onBlur,
  placeholder,
  options,
}: Base & {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  /** The Angular "Select …" first option. */
  placeholder?: string
  options: readonly (Option | string)[]
}) {
  return (
    <div>
      <Label id={id} label={label} required={required} />
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(inputClass, error && errorClass)}
      >
        <option value="">{placeholder ?? ''}</option>
        {options.map((option) => {
          const { value: v, label: l } = typeof option === 'string' ? { value: option, label: option } : option
          return (
            <option key={v} value={v}>
              {l}
            </option>
          )
        })}
      </select>
      <Message id={id} error={error} />
    </div>
  )
}

/** A radio group drawn as care-entry's segmented choice (the register screen's Sex buttons). */
export function RadioField({
  id,
  name,
  label,
  required,
  error,
  value,
  onChange,
  options,
}: Base & { value: string; onChange: (value: string) => void; options: readonly string[] }) {
  return (
    <div>
      <p id={id} className={labelClass}>
        {label}
        {required ? <span className="text-critical-fg">*</span> : null}
      </p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={id} aria-invalid={Boolean(error)}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            name={name}
            value={option}
            aria-checked={value === option}
            onClick={() => onChange(option)}
            className={cn(
              'focus-ring min-h-11 flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
              value === option
                ? 'border-primary-600 bg-primary-600 text-on-primary'
                : error
                  ? 'border-critical-fg bg-surface-1 text-ink hover:bg-surface-2'
                  : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <Message id={id} error={error} />
    </div>
  )
}

/** A list of checkboxes (the Angular *ngFor checkbox lists, which have no formControlName). */
export function CheckboxList({
  id,
  options,
  selected,
  onChange,
  columns = 'sm:grid-cols-2 lg:grid-cols-3',
}: {
  id: string
  options: readonly (Option | string)[]
  selected: string[]
  onChange: (next: string[]) => void
  columns?: string
}) {
  return (
    <div className={cn('grid grid-cols-1 gap-x-4 gap-y-2.5', columns)}>
      {options.map((option, index) => {
        const { value, label } = typeof option === 'string' ? { value: option, label: option } : option
        const inputId = `${id}-${index}`
        return (
          <label key={value} htmlFor={inputId} className="flex items-start gap-2.5 text-sm text-ink">
            <input
              id={inputId}
              type="checkbox"
              value={value}
              checked={selected.includes(value)}
              onChange={(event) => onChange(event.target.checked ? [...selected, value] : selected.filter((v) => v !== value))}
              className={checkboxClass}
            />
            <span>{label}</span>
          </label>
        )
      })}
    </div>
  )
}

export function Checkbox({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2.5 text-sm text-ink">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className={checkboxClass} />
      <span>{children}</span>
    </label>
  )
}

/** The fields of one section, two or three across on wide screens, one on a phone. */
export function FieldGrid({ children, columns = 'sm:grid-cols-2 xl:grid-cols-3' }: { children: ReactNode; columns?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4', columns)}>{children}</div>
}
