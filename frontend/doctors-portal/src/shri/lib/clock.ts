/**
 * The demo clock and the date formats are the old build's (`src/data/format.ts`):
 * one fixed moment, Mon 21-Sep-2026 08:40, so the greeting, the NOW row and
 * every "ago" are the same on every machine; dates as 21-Sep-2026, times
 * 24-hour. Everything in this build reads the time from here.
 */

import { format } from 'date-fns'

import { NOW as DEMO_NOW, formatDate, formatDateLong, formatTime } from '@/data/format'

export const NOW = DEMO_NOW

/** "Good morning" before 12:00, "Good afternoon" before 17:00, else "Good evening" — the old greeting's rule. */
export function greetingWord(d: Date = NOW) {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/** 21-Sep-2026 */
export const fmtDate = formatDate
/** Mon 21-Sep-2026 */
export const fmtLongDate = formatDateLong
/** 24-hour HH:mm */
export const fmtTime = formatTime

/** "8:40", and on the hour "8" — or "8:00" where `minutes` is asked for, as a list wants. */
const hour12 = (min: number, minutes = false) => {
  const h = Math.floor(min / 60) % 12 || 12
  const m = min % 60
  return m || minutes ? `${h}:${String(m).padStart(2, '0')}` : `${h}`
}
const period = (min: number) => (Math.floor(min / 60) % 24 < 12 ? 'AM' : 'PM')
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()

/** 12-hour, from minutes after midnight, as the day's own views read: 520 → "8:40 AM", 840 → "2 PM", 720 → "12 PM". */
export const clock12 = (min: number) => `${hour12(min)} ${period(min)}`
/** A stretch of time, 12-hour, the period said once where it can be: "8–9 AM", "11:30 AM–1 PM". */
export const span12 = (a: number, b: number) => (period(a) === period(b) ? `${hour12(a)}–${hour12(b)} ${period(b)}` : `${clock12(a)}–${clock12(b)}`)
/** 12-hour with its minutes, from minutes after midnight: 480 → "8:00 AM". */
export const time12 = (min: number) => `${hour12(min, true)} ${period(min)}`
/** A stretch with its minutes, AM/PM said once where it can be: "8:00 – 9:00 AM", "11:30 AM – 1:00 PM". */
export const range12 = (a: number, b: number) => (period(a) === period(b) ? `${hour12(a, true)} – ${hour12(b, true)} ${period(b)}` : `${time12(a)} – ${time12(b)}`)
/** 12-hour time of a date, for a list: "8:40 AM", "2:00 PM". */
export const fmtTime12 = (d: Date) => time12(minutesOf(d))
/** The same in two parts, for a large time with a small AM/PM: { time: "10:05", period: "AM" }. */
export const fmtTime12Parts = (d: Date) => ({ time: hour12(minutesOf(d), true), period: period(minutesOf(d)) })
/** 12-hour span between two dates, for a list: "8:00 – 9:00 AM", "11:30 AM – 1:00 PM". */
export const fmtSpan12 = (a: Date, b: Date) => range12(minutesOf(a), minutesOf(b))
/** September 2026 — the calendar's heading */
export const fmtMonth = (d: Date) => format(d, 'MMMM yyyy')
