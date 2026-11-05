import type { ClipboardEvent, ComponentPropsWithoutRef } from 'react'
import { sanitizeMobile } from '../../utils/phone'

/** The one mobile-number field. Accepts digits only, stops at 10 digits, and on
 *  paste keeps the first 10 valid digits of whatever was pasted. It renders the
 *  caller's own input styling, so existing forms look exactly as before. */
export function MobileInput({
  value,
  onValueChange,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'type' | 'maxLength'> & {
  value: string
  onValueChange: (value: string) => void
}) {
  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault()
    const input = event.currentTarget
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? value.length
    const pasted = event.clipboardData.getData('text')
    onValueChange(sanitizeMobile(value.slice(0, start) + pasted + value.slice(end)))
  }

  return (
    <input
      {...props}
      type="tel"
      inputMode="numeric"
      autoComplete="tel-national"
      maxLength={10}
      value={value}
      onChange={(event) => onValueChange(sanitizeMobile(event.target.value))}
      onPaste={handlePaste}
    />
  )
}
