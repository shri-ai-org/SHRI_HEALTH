import { useId, useState, type InputHTMLAttributes, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { US_STATES } from '../format/address'
import { formatDate, parseUsDate } from '../format/datetime'
import { formatMoney, parseMoneyInput } from '../format/money'
import { formatPhone, parseUsPhone } from '../format/phone'
import { cn } from '../lib/cn'
import { inputClass } from './Field'

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={cn(inputClass, className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputClass, 'pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

type BaseInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue' | 'type'>

export interface DateInputProps extends BaseInputProps {
  /** Contract value `YYYY-MM-DD`, or empty. */
  value: string
  /** Called with `YYYY-MM-DD` when the text is a real date, `null` when it is not, `''` when cleared. */
  onValueChange: (isoDate: string | null) => void
}

/**
 * Date typed as MM/DD/YYYY. A text field rather than `type="date"`, because the native picker shows
 * the browser's locale format, which differs between machines. The contract value is `YYYY-MM-DD`.
 */
export function DateInput({ value, onValueChange, className, ...rest }: DateInputProps) {
  const [text, setText] = useState(value ? formatDate(value) : '')
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="MM/DD/YYYY"
      maxLength={10}
      className={cn(inputClass, 'tabular-nums', className)}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const trimmed = e.target.value.trim()
        onValueChange(trimmed === '' ? '' : parseUsDate(trimmed))
      }}
      {...rest}
    />
  )
}

export interface PhoneInputProps extends BaseInputProps {
  /** Contract value in E.164 (`+16175550123`), or empty. */
  value: string
  /** Called with E.164 when the text is a valid U.S. number, `null` when it is not, `''` when cleared. */
  onValueChange: (e164: string | null) => void
}

/** U.S. phone typed any common way; shown as (617) 555-0123 once it is valid. */
export function PhoneInput({ value, onValueChange, className, onBlur, ...rest }: PhoneInputProps) {
  const [text, setText] = useState(value ? formatPhone(value) : '')
  return (
    <input
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      placeholder="(555) 555-0100"
      className={cn(inputClass, 'tabular-nums', className)}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const trimmed = e.target.value.trim()
        onValueChange(trimmed === '' ? '' : parseUsPhone(trimmed))
      }}
      onBlur={(e) => {
        const parsed = parseUsPhone(text)
        if (parsed) setText(formatPhone(parsed))
        onBlur?.(e)
      }}
      {...rest}
    />
  )
}

export interface MoneyInputProps extends BaseInputProps {
  /** Contract value: a decimal string such as `25.00` (API_STANDARDS §6.3), or empty. */
  value: string
  /** Called with the decimal string when the text is a valid amount, `null` when it is not, `''` when cleared. */
  onValueChange: (value: string | null) => void
  /** Only where the endpoint documents negative amounts (adjustments, refunds). */
  allowNegative?: boolean
}

/**
 * U.S. dollar amount typed as `25`, `25.5` or `1,234.50`. The amount stays a decimal string from
 * keystroke to request and is never turned into a float (D40). Shown grouped once it is valid.
 * The label should name the currency, e.g. "Copay amount (USD)"; the `$` sign is visual only.
 */
export function MoneyInput({ value, onValueChange, allowNegative = false, className, onBlur, ...rest }: MoneyInputProps) {
  const [text, setText] = useState(value ? withoutSign(value) : '')
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm text-ink-subtle">
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        className={cn(inputClass, 'pl-7 tabular-nums', className)}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const trimmed = e.target.value.trim()
          onValueChange(trimmed === '' ? '' : parseMoneyInput(trimmed, { allowNegative }))
        }}
        onBlur={(e) => {
          const parsed = parseMoneyInput(text, { allowNegative })
          if (parsed) setText(withoutSign(parsed))
          onBlur?.(e)
        }}
        {...rest}
      />
    </div>
  )
}

/** `1234.50` → `1,234.50`, `-5.00` → `-5.00`: the `$` is drawn beside the field. */
function withoutSign(value: string): string {
  return formatMoney({ value, currency: 'USD' }).replace('$', '')
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'maxLength'> {
  value: string
  /**
   * Character limit from the contract (e.g. 500 for a break-glass `reasonText`). Typing past it is
   * allowed, so pasted text is never silently cut; the count turns red and the form must refuse to
   * submit while `isOverLimit(value, limit)` is true.
   */
  limit?: number
  ref?: Ref<HTMLTextAreaElement>
}

/** Multi-line text with an optional character count (WCAG 3.3.1: the count is read with the field). */
export function Textarea({ value, limit, className, rows = 3, 'aria-describedby': describedBy, ...rest }: TextareaProps) {
  const countId = useId()
  const remaining = limit === undefined ? 0 : limit - value.length
  const over = limit !== undefined && remaining < 0
  const countText = remaining >= 0 ? `${remaining} ${plural(remaining, 'character')} left` : `${-remaining} ${plural(-remaining, 'character')} too many`
  const describedByAll = [describedBy, limit === undefined ? undefined : countId].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1">
      <textarea
        rows={rows}
        value={value}
        aria-describedby={describedByAll}
        className={cn(inputClass, 'resize-y py-2 leading-relaxed', over && 'border-critical-fg', className)}
        {...rest}
        {...(over ? { 'aria-invalid': true } : {})}
      />
      {limit === undefined ? null : (
        <>
          <p id={countId} aria-hidden="true" className={cn('text-xs tabular-nums', over ? 'font-medium text-critical-fg' : 'text-ink-subtle')}>
            {countText}
          </p>
          {/* Announced only near and past the limit, so screen readers aren't told every keystroke. */}
          <span className="sr-only" aria-live="polite">
            {remaining <= 20 ? countText : ''}
          </span>
        </>
      )}
    </div>
  )
}

/** True when the text is longer than the contract allows; block submit while it is. */
export function isOverLimit(value: string, limit: number): boolean {
  return value.length > limit
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

export interface StateSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  placeholder?: string
}

/** USPS state codes with full names; the value sent is the two-letter code. */
export function StateSelect({ placeholder = 'Select a state', ...rest }: StateSelectProps) {
  return (
    <Select autoComplete="address-level1" {...rest}>
      <option value="">{placeholder}</option>
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name} ({s.code})
        </option>
      ))}
    </Select>
  )
}
