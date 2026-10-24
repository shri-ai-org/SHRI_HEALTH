/**
 * U.S. phone numbers. The API stores E.164 (`+16175550123`, API_STANDARDS §6.2); screens show the
 * familiar `(617) 555-0123`. Numbers outside the U.S. plan are shown as sent.
 */

const NANP_E164 = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/

/** `+16175550123` → `(617) 555-0123`. */
export function formatPhone(e164: string): string {
  const m = NANP_E164.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}

/**
 * What a user typed (`617-555-0123`, `(617) 555 0123`, `1 617 555 0123`) → `+16175550123`,
 * or `null` if it is not a valid U.S. number (area code and exchange cannot start with 0 or 1).
 */
export function parseUsPhone(input: string): string | null {
  let digits = input.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (digits.length !== 10) return null
  const e164 = `+1${digits}`
  return NANP_E164.test(e164) ? e164 : null
}

/** Last four digits only, as patient search results show them (PatientSummary.phoneLast4). */
export function formatPhoneLast4(last4: string): string {
  return `(•••) •••-${last4}`
}
