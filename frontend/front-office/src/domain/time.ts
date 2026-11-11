// Time helpers shared by the domain layer. Slots are stored as "HH:MM"
// strings in the clinic's time (what staff read on a schedule) and converted
// to real timestamps whenever anything needs to compare them against the
// clock — so "past", "upcoming", "running late" and "waiting N min" are all
// genuinely computed, never hardcoded.
//
// Whose time: the clinic's. With the SHRI_HEALTH API (SHRI_API=real) that is
// the facility's IANA time zone from the server (setClinicTimeZone, SHRI_HEALTH
// D40), whatever the browser's own zone is — a desk in Chennai looking after a
// clinic in Chicago sees Chicago's today and Chicago's times. With no zone set
// (the sample data), it is the browser's, as before.

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

let clinicTimeZone: string | null = null
let clinicFormat: Intl.DateTimeFormat | null = null

/** The clinic's IANA time zone (e.g. "America/Chicago"); null goes back to the browser's. */
export function setClinicTimeZone(timeZone: string | null): void {
  clinicTimeZone = timeZone
  clinicFormat = timeZone
    ? new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    : null
}

export function getClinicTimeZone(): string | null {
  return clinicTimeZone
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** What the clinic's clock and calendar read at `timestamp`. */
function wallClock(timestamp: number): WallClock {
  if (!clinicFormat) {
    const d = new Date(timestamp)
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() }
  }
  const parts: Record<string, number> = {}
  for (const part of clinicFormat.formatToParts(new Date(timestamp))) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! }
}

/** The timestamp at which the clinic's clock reads this date and time. */
function fromWallClock(year: number, month: number, day: number, hour: number, minute: number): number {
  if (!clinicFormat) return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  const offsetAt = (timestamp: number) => {
    const w = wallClock(timestamp)
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(timestamp / 1000) * 1000
  }
  // Twice, so a time on the day the clocks change lands on the right side of it.
  const first = asUtc - offsetAt(asUtc)
  return asUtc - offsetAt(first)
}

/** The clinic's date (YYYY-MM-DD) at that moment — now, by default. Deliberately
 *  not toISOString(), so a clinic doesn't flip to "tomorrow" at midnight UTC. */
export function todayKey(date: Date = new Date()): string {
  const w = wallClock(date.getTime())
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`
}

/** When the clinic's day starts. */
export function dayStartTimestamp(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return fromWallClock(year, month, day, 0, 0)
}

/** The clinic's time at that moment, "HH:MM". */
export function slotLabel(timestamp: number): string {
  const w = wallClock(timestamp)
  return `${pad2(w.hour)}:${pad2(w.minute)}`
}

/** Minutes after the clinic's midnight at that moment (the charts' Now line). */
export function minutesOfDay(timestamp: number): number {
  const w = wallClock(timestamp)
  return w.hour * 60 + w.minute
}

/** A date key as a calendar date, for showing its weekday, day and month — never for comparing with the clock. */
export function calendarDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** 0 (Sunday) .. 6 (Saturday), for a date key, wherever the browser is. */
export function weekdayOfKey(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** The date key `days` after (or before) this one — calendar arithmetic, no clock. */
export function addDaysToKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * A time for people to read: 12-hour with AM/PM ("9:05 AM", "12:30 PM").
 * Slots stay "HH:MM" everywhere as data — keys, sorting, URL params — and
 * become this only at the point they are shown.
 */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`
}

/** "9:00 AM – 1:00 PM" */
export function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)}`
}

/** A timestamp's clinic time, 12-hour. */
export function formatTimestampTime(timestamp: number): string {
  return formatTime(slotLabel(timestamp))
}

/** An hour of the day as "9 AM" / "12 PM" (axes and hour blocks). */
export function formatHour(hour: number): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12} ${hour < 12 ? 'AM' : 'PM'}`
}

/** When the clinic's clock reads `slot` on that date. */
export function slotToTimestamp(dateKey: string, slot: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hours, minutes] = slot.split(':').map(Number)
  return fromWallClock(year, month, day, hours, minutes)
}

/** Back to the last whole `stepMinutes` on the clinic's clock. */
export function roundDownToStep(timestamp: number, stepMinutes: number): number {
  const w = wallClock(timestamp)
  return timestamp - (timestamp % 1000) - w.second * 1000 - (w.minute % stepMinutes) * 60000
}

export function buildSlotRange(startTimestamp: number, endTimestamp: number, stepMinutes: number): string[] {
  const slots: string[] = []
  for (let t = startTimestamp; t <= endTimestamp; t += stepMinutes * 60000) {
    slots.push(slotLabel(t))
  }
  return slots
}

export function minutesBetween(later: number, earlier: number): number {
  return Math.max(0, Math.round((later - earlier) / 60000))
}
