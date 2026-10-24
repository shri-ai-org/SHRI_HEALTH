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

/** Shown after a time when the facility time zone is missing or invalid, so nobody misreads it. */
export const TIME_ZONE_MISSING = 'time zone missing'

/**
 * True for an IANA zone the browser knows (e.g. `America/Chicago`). The facility time zone may be
 * null until the schema lock, and Intl silently uses the browser's zone when none is given, which
 * API_STANDARDS §6.1 forbids; every formatter checks this first.
 */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Today's date in the facility's time zone, as `YYYY-MM-DD`. Without a valid zone it uses UTC
 * (never the browser's zone); screens show the missing zone through formatTime.
 */
export function todayIn(timeZone: string | null, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/**
 * `2026-11-03T14:30:00Z` in America/Chicago → `8:30 AM CST`. 12-hour clock with the zone shown.
 * `timeZone` is required: pass the facility's `timeZone` from the response. If it is null or
 * invalid, the time is shown in UTC with a marker: `2:30 PM UTC · time zone missing`.
 */
export function formatTime(instant: string, timeZone: string | null, { withZone = true } = {}): string {
  const valid = isValidTimeZone(timeZone)
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: valid ? timeZone : 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(withZone && valid ? { timeZoneName: 'short' as const } : {}),
  }).format(new Date(instant))
  return valid ? text : `${text} UTC · ${TIME_ZONE_MISSING}`
}

/**
 * `2026-11-03T14:30:00Z` in America/Chicago → `11/03/2026, 8:30 AM CST`. Same rule as formatTime
 * when the zone is missing: `11/03/2026, 2:30 PM UTC · time zone missing`.
 */
export function formatDateTime(instant: string, timeZone: string | null): string {
  const valid = isValidTimeZone(timeZone)
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: valid ? timeZone : 'UTC',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(valid ? { timeZoneName: 'short' as const } : {}),
  }).format(new Date(instant))
  return valid ? text : `${text} UTC · ${TIME_ZONE_MISSING}`
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
