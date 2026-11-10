/**
 * Form fields in this build's look: a label above, the control, then a hint
 * or an error. Required fields carry a visible asterisk and say "required" to
 * a screen reader. The control is 52px tall with the control fill, as the
 * search box and the break-glass reason already are.
 */

import { Check } from 'lucide-react'
import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

import { Icon } from './primitives'

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  aside,
  children,
  className,
}: {
  label: ReactNode
  htmlFor: string
  required?: boolean
  hint?: ReactNode
  error?: ReactNode
  /** Beside the label — where a field's AI suggestion sits (the old `aiSlot`). */
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  const labelEl = (
    <label htmlFor={htmlFor} className="text-[13px] font-medium text-sh-text-2">
      {label}
      {required && (
        <>
          <span className="ml-[3px] text-sh-crit-fg" aria-hidden="true">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  )
  return (
    <div className={cn('flex min-w-0 flex-col gap-[6px]', className)}>
      {aside ? (
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          {labelEl}
          {aside}
        </div>
      ) : (
        labelEl
      )}
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-[12px]/[1.4] text-sh-text-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className="text-[12px]/[1.4] font-medium text-sh-crit-fg">
          {error}
        </p>
      )}
    </div>
  )
}

const control =
  'w-full rounded-[16px] bg-sh-control px-[16px] text-[14px] text-sh-text placeholder:text-sh-muted transition-colors duration-150 hover:bg-sh-hover-strong disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:inset-ring-2 aria-invalid:inset-ring-sh-crit'

export function TextInput({ className, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(control, 'h-[52px]', className)} {...rest} />
}

export function TextArea({ className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(control, 'min-h-[104px] resize-y py-[14px] leading-[1.5]', className)} {...rest} />
}

export function Select({ className, ref, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select ref={ref} className={cn(control, 'h-[52px] appearance-auto pr-[12px]', className)} {...rest}>
      {children}
    </select>
  )
}

/**
 * A checkbox whose whole row is the target — an attestation, a declaration.
 * One control (`role="checkbox"`), so the words and the box answer the same
 * press and the row is a full-width 44px target.
 */
export function CheckboxRow({
  checked,
  onChange,
  disabled,
  className,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[44px] w-full items-start gap-[12px] rounded-[14px] px-[10px] py-[10px] text-left text-[14px]/[1.5] text-sh-text transition-colors duration-150 hover:bg-sh-hover disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-[1px] inline-flex size-[20px] shrink-0 items-center justify-center rounded-[6px]',
          checked ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-card inset-ring-2 inset-ring-sh-line-strong',
        )}
      >
        {checked && <Icon icon={Check} size={14} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}
