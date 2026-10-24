/**
 * U.S. date and time display (API_STANDARDS §6.1, D40).
 * - Calendar dates (`YYYY-MM-DD`, e.g. birthDate) have no time zone: they are reformatted as text,
 *   never through `Date`, so a birth date can never shift by a day.
 * - Instants (RFC 3339 UTC, e.g. startAt) are shown in the facility's IANA time zone, which the API
 *   returns as `timeZone`; never the browser's zone.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/** `1984-07-19` → `07/19/1984`. Returns the input unchanged if it is not a full date. */
export function formatDate(isoDate: string): string {
  const m = ISO_DATE.exec(isoDate)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : isoDate
}

/** Parses what a user typed as MM/DD/YYYY into `YYYY-MM-DD`, or `null` if it is not a real date. */
export function parseUsDate(input: string): string | null {
  const m = US_DATE.exec(input.trim())
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  const year = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || year < 1900) return null
  if (day > daysInMonth(year, month)) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Age in whole years on `today` (`YYYY-MM-DD`). Age is never stored or sent; screens derive it. */
export function ageInYears(birthDate: string, today: string): number | null {
  const b = ISO_DATE.exec(birthDate)
  const t = ISO_DATE.exec(today)
  if (!b || !t) return null
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])]
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])]
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0)
}

/** Today's date in the facility's time zone, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return parts.format(now)
}

/** `2026-11-03T14:30:00Z` in America/Chicago → `8:30 AM CST`. 12-hour clock with the zone shown. */
export function formatTime(instant: string, timeZone: string, { withZone = true } = {}): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(withZone ? { timeZoneName: 'short' as const } : {}),
  }).format(new Date(instant))
}

/** `2026-11-03T14:30:00Z` in America/Chicago → `11/03/2026, 8:30 AM CST`. */
export function formatDateTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(new Date(instant))
}

/** Minutes between two instants, rounded down, e.g. how long a patient has waited. */
export function minutesBetween(fromInstant: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(fromInstant).getTime()) / 60_000))
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
