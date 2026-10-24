import { useId, type ReactNode } from 'react'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
  'aria-required'?: true
}

export interface FieldProps {
  label: string
  /** Shown under the label, e.g. the expected format "MM/DD/YYYY". */
  hint?: string
  error?: string | undefined
  required?: boolean
  children: (control: FieldControlProps) => ReactNode
}

/**
 * Label, hint and error for one control, wired with ids so screen readers read them together
 * (WCAG 1.3.1, 3.3.1, 3.3.2). Required fields say "(required)" in words, not only with a star.
 */
export function Field({ label, hint, error, required = false, children }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink-muted">
        {label}
        {required ? (
          <span className="ml-1 text-critical-fg">
            <span aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId} className="text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(required ? { 'aria-required': true as const } : {}),
      })}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-critical-fg">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export const inputClass =
  'min-h-11 w-full rounded-lg border bg-surface-1 px-3.5 text-sm text-ink placeholder:text-ink-subtle border-border hover:border-border-strong aria-invalid:border-critical-fg disabled:opacity-60'
