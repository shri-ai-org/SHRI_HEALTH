/**
 * The day, hour by hour — what `HourGrid` draws. From the same live calendar as
 * the rest of the day (`CalendarDay`): busy is the doctor's own sessions and
 * activities, plus any booking that falls outside them (each for its clinic's
 * slot length); blocked is the doctor's self-blocks; free is the rest of 07–19.
 * Overlaps are merged, so no minute counts twice.
 */

import { SESSIONS } from '@/data/schedule'

import { NOW } from '../lib/clock'
import { clinicMatches } from '../logic/schedule'

import type { CalendarDay } from './useMyDay'

export const GRID_START = 7
export const GRID_HOURS = 12

const START = GRID_START * 60
const END = START + GRID_HOURS * 60
const DEFAULT_SLOT = 15
/** A gap shorter than this is not offered as "next free". */
const MIN_FREE = 15

type Span = [number, number]

export interface HourCell {
  hour: number
  busyMin: number
  blockedMin: number
  freeMin: number
  bookings: number
  past: boolean
  /** What fills the hour, for the hover line and the screen-reader list. */
  titles: string[]
}

export interface HourGridModel {
  cells: HourCell[]
  busyMin: number
  blockedMin: number
  freeMin: number
  /** The first free stretch of at least 15 minutes still to come, as minutes from midnight. */
  nextFree: number | null
}

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()
const clip = ([a, b]: Span): Span | null => {
  const s = Math.max(a, START)
  const e = Math.min(b, END)
  return e > s ? [s, e] : null
}

function merge(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const overlap = (spans: Span[], [a, b]: Span) => spans.reduce((n, [s, e]) => n + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0)
const minus = (spans: Span[], cut: Span[]): Span[] =>
  cut.reduce<Span[]>(
    (acc, [cs, ce]) => acc.flatMap(([s, e]): Span[] => (ce <= s || cs >= e ? [[s, e]] : ([cs > s ? [s, cs] : null, ce < e ? [ce, e] : null].filter(Boolean) as Span[]))),
    spans,
  )

const slotFor = (clinic: string | undefined) => (clinic && SESSIONS.find((s) => clinicMatches(clinic, s.clinic))?.slotMin) || DEFAULT_SLOT

export function hourGrid(day: CalendarDay): HourGridModel {
  const blocked = merge(
    day.blocks
      .map((e): Span | null => clip(e.block!.allDay ? [START, END] : [minutesOf(e.at), e.until ? minutesOf(e.until) : minutesOf(e.at) + 30]))
      .filter((s): s is Span => s !== null),
  )
  const sessions = day.sessions.filter((e) => !e.blocked).map((e): Span => [minutesOf(e.at), e.until ? minutesOf(e.until) : minutesOf(e.at) + 30])
  const outside = day.bookings
    .map((e): Span => [minutesOf(e.at), minutesOf(e.at) + slotFor(e.appointment?.clinic)])
    .filter((b) => overlap(merge(sessions), b) === 0)
  // Blocked time is not also busy: a session inside a block is already greyed out on the list.
  const busy = minus(merge([...sessions, ...outside].map(clip).filter((s): s is Span => s !== null)), blocked)

  const nowMin = day.isToday ? minutesOf(NOW) : day.date < NOW ? END : START
  const cells: HourCell[] = Array.from({ length: GRID_HOURS }, (_, i) => {
    const span: Span = [START + i * 60, START + (i + 1) * 60]
    const busyMin = overlap(busy, span)
    const blockedMin = overlap(blocked, span)
    const at = (e: { at: Date; until?: Date }) => {
      const s = minutesOf(e.at)
      const end = e.until ? minutesOf(e.until) : s + 1
      return s < span[1] && end > span[0]
    }
    return {
      hour: GRID_START + i,
      busyMin,
      blockedMin,
      freeMin: 60 - busyMin - blockedMin,
      bookings: day.bookings.filter((b) => minutesOf(b.at) >= span[0] && minutesOf(b.at) < span[1]).length,
      past: span[1] <= nowMin,
      titles: [...day.blocks.filter(at).map((e) => `Blocked · ${e.block!.reason}`), ...day.sessions.filter((e) => !e.blocked && at(e)).map((e) => e.title)],
    }
  })

  const free = minus(minus([[Math.max(START, nowMin), END]], busy), blocked).filter(([a, b]) => b - a >= MIN_FREE)
  const busyMin = busy.reduce((n, [a, b]) => n + b - a, 0)
  const blockedMin = blocked.reduce((n, [a, b]) => n + b - a, 0)
  return { cells, busyMin, blockedMin, freeMin: GRID_HOURS * 60 - busyMin - blockedMin, nextFree: free[0]?.[0] ?? null }
}

/** 370 → "6h 10m", 60 → "1h", 45 → "45m". */
export function duration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`
}

/** 370 → "6 hours 10 minutes", for screen readers. */
export function durationSpoken(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  const hs = h ? `${h} hour${h === 1 ? '' : 's'}` : ''
  const ms = m ? `${m} minute${m === 1 ? '' : 's'}` : ''
  return [hs, ms].filter(Boolean).join(' ') || '0 minutes'
}

export const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
