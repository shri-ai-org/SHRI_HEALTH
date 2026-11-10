// Indian mobile numbers: 10 digits starting with 6, 7, 8 or 9. One place
// defines the rule so every mobile field and every domain action agrees on it.

export const MOBILE_LENGTH = 10
export const MOBILE_ERROR = 'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.'

/** Keep digits only, and at most the first 10 of them. */
export function sanitizeMobile(value: string): string {
  return value.replace(/\D/g, '').slice(0, MOBILE_LENGTH)
}

/** The 10-digit number inside whatever was typed or stored —
 *  "+91 98431 22456", "098431 22456" and "9843122456" all give "9843122456". */
export function nationalMobile(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

export function isValidMobile(value: string | null | undefined): boolean {
  return /^[6-9]\d{9}$/.test(nationalMobile(value))
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
