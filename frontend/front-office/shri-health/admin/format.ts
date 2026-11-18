// SHRI_HEALTH: dates and small helpers for the Administration screens. Times show in the clinic's
// time zone (D40) once the front office has read it, else the browser's.
import { ApiError } from '../../../src/api/client'
import { getClinicTimeZone } from '../../src/domain/time'

export function when(at: string | undefined | null): string {
  if (!at) return '—'
  const zone = getClinicTimeZone()
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}) }).format(new Date(at))
}

/** `YYYY-MM-DD`, `days` before today (the clinic's day when known). */
export function dayBefore(days: number): string {
  const zone = getClinicTimeZone()
  const d = new Date(Date.now() - days * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(zone ? { timeZone: zone } : {}) }).format(d)
}

/** A plain line for a failed read; a 403 says the account can't read it. */
export function readFailure(err: unknown, what: string): string {
  if (err instanceof ApiError && err.status === 403) return `Your account can't read ${what}.`
  return `Couldn't read ${what}. Try again.`
}

/** `breakGlass` → "Break glass", `integration-messages` → "Integration messages". */
export function words(code: string): string {
  const spaced = code.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
