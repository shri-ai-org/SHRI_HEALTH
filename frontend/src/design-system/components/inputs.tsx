import { useState, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { US_STATES } from '../format/address'
import { formatDate, parseUsDate } from '../format/datetime'
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
