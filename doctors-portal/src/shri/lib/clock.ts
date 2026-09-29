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
/** September 2026 — the calendar's heading */
export const fmtMonth = (d: Date) => format(d, 'MMMM yyyy')
