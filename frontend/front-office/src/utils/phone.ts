// Indian mobile numbers: 10 digits starting with 6, 7, 8 or 9. One place
// defines the rule so every mobile field and every domain action agrees on it.
// SHRI_HEALTH (real API): U.S. numbers instead, 10 digits with an area code and exchange that
// don't start with 0 or 1 (NANP); a leading 1 is the country code.
import { REAL_API } from '../../shri-health/client'

export const MOBILE_LENGTH = 10
export const MOBILE_ERROR = REAL_API
  ? 'Enter a 10-digit U.S. phone number, area code first.'
  : 'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.'

/** Keep digits only, and at most the first 10 of them. */
export function sanitizeMobile(value: string): string {
  return value.replace(/\D/g, '').slice(0, MOBILE_LENGTH)
}

/** The 10-digit number inside whatever was typed or stored —
 *  "+91 98431 22456", "098431 22456" and "9843122456" all give "9843122456". */
export function nationalMobile(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '')
  if (REAL_API) return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

export function isValidMobile(value: string | null | undefined): boolean {
  return (REAL_API ? /^[2-9]\d{2}[2-9]\d{6}$/ : /^[6-9]\d{9}$/).test(nationalMobile(value))
}

/** How a mobile is stored and shown: "+91 98431 22456". */
export function formatMobile(value: string): string {
  const national = nationalMobile(value)
  return `+91 ${national.slice(0, 5)} ${national.slice(5)}`
}

/** For editing an already-stored number such as "+91 98450 11020": the
 *  10-digit field starts from the real number. */
export function toEditableMobile(stored: string): string {
  return nationalMobile(stored).slice(0, MOBILE_LENGTH)
}
