// The one set of rules for what a patient record may hold. Each check returns
// the message to show, or null when the value is fine — the registration form,
// the details card and the domain actions all ask the same questions.
import { MOBILE_ERROR, isValidMobile } from './phone'
import type { Sex } from '../types/patient'

export const MAX_AGE = 130
/** From this age the desk confirms the number with the patient before saving. */
export const AGE_CONFIRM_FROM = 100

/** Letters in any script, with single spaces, dots, apostrophes or hyphens
 *  between them: "R. Lakshmanan", "S. Kumaravel", "Mary-Ann O'Neil". */
const NAME_PATTERN = /^[\p{L}\p{M}]+(?:[ .'-]{1,2}[\p{L}\p{M}]+)*\.?$/u

/** An ABHA address: 8–18 letters, digits, dots or underscores (not at either
 *  end), then @abdm (or @sbx, the sandbox). */
const ABHA_ADDRESS = /^[a-z0-9][a-z0-9._]{6,16}[a-z0-9]@(abdm|sbx)$/

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function nameError(value: string | null | undefined): string | null {
  const name = normalizeName(value ?? '')
  if (!name) return "Enter the patient's name."
  if (/\d/.test(name)) return "A name can't contain numbers."
  if (name.length < 2 || name.length > 60) return 'A name is 2 to 60 characters.'
  if (!NAME_PATTERN.test(name)) return "Use letters only — spaces, . ' and - are allowed between them."
  return null
}

export function ageError(value: string | number | null | undefined): string | null {
  const text = String(value ?? '').trim()
  if (!text) return 'Enter the age in years.'
  if (!/^\d{1,3}$/.test(text)) return 'Age is a whole number of years.'
  if (Number(text) > MAX_AGE) return `Age can't be more than ${MAX_AGE}.`
  return null
}

/** What a name box keeps as it is typed or pasted in: letters in any
 *  script, spaces, dots, apostrophes and hyphens — never digits or other
 *  symbols — up to 60 characters. */
export function nextNameInput(typed: string): string {
  return typed.replace(/[^\p{L}\p{M} .'-]/gu, '').slice(0, 60)
}

/** What the age box keeps as it is typed in: whole years only, and never
 *  above MAX_AGE — a keystroke or paste that would pass it is ignored, so
 *  the box can't hold 131 or more. */
export function nextAgeInput(typed: string, previous: string): string {
  const digits = typed.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 3)
  return digits !== '' && Number(digits) > MAX_AGE ? previous : digits
}

/** 100–130 is possible but rare — worth asking the patient again. */
export function ageNeedsConfirmation(value: string | number | null | undefined): boolean {
  if (ageError(value)) return false
  return Number(value) >= AGE_CONFIRM_FROM
}

export function sexError(value: Sex | '' | null | undefined): string | null {
  return value === 'Male' || value === 'Female' || value === 'Other' ? null : 'Choose the sex.'
}

export function mobileError(value: string | null | undefined): string | null {
  if (!value?.trim()) return 'Enter a mobile number.'
  return isValidMobile(value) ? null : MOBILE_ERROR
}

/** A mobile that is already wrong while it is still being typed — it starts
 *  with 0–5 — so the field can say so at once instead of waiting for blur. */
export function mobileEarlyError(value: string | null | undefined): string | null {
  return /^[0-5]/.test((value ?? '').replace(/\D/g, '')) ? MOBILE_ERROR : null
}

/** ABHA is optional; when given it is an address or a 14-digit number. */
export function abhaError(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  if (text.includes('@')) {
    return ABHA_ADDRESS.test(text.toLowerCase())
      ? null
      : 'An ABHA address is 8–18 letters, numbers, . or _ followed by @abdm — e.g. ramesh.babu@abdm.'
  }
  const digits = text.replace(/[\s-]/g, '')
  if (!/^\d+$/.test(digits)) return 'Enter an ABHA address (name@abdm) or the 14-digit ABHA number.'
  return digits.length === 14 ? null : 'An ABHA number has 14 digits (xx-xxxx-xxxx-xxxx).'
}

/** Which kind of ABHA a value is: the ABHA ID (address, name@abdm) or the
 *  14-digit ABHA number. */
export function abhaKind(value: string): 'ABHA ID' | 'ABHA number' {
  return value.includes('@') ? 'ABHA ID' : 'ABHA number'
}

/** How an ABHA is stored: addresses in lower case, numbers as xx-xxxx-xxxx-xxxx. */
export function normalizeAbha(value: string): string {
  const text = value.trim().toLowerCase()
  if (text.includes('@')) return text
  const digits = text.replace(/[\s-]/g, '')
  return /^\d{14}$/.test(digits) ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}` : text
}

export function emailError(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) ? null : 'Enter a valid email address.'
}

export function addressError(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  return text.length < 5 || text.length > 200 ? 'An address is 5 to 200 characters.' : null
}
