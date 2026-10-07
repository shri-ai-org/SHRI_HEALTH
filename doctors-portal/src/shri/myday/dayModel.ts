/**
 * One day, 7 AM to 7 PM, as the Today panel draws it (`DayTimeline`) — from
 * the same live calendar as every other view of the day (`CalendarDay`):
 *
 *   · activities: the doctor's sessions and activities (today, the day plan),
 *     each of a kind that picks its colour;
 *   · patients booked outside any session, each for the time booked, or its
 *     clinic's slot — but not a clinic visit of today's: that patient is in
 *     the OPD queue, drawn as the OPD block, which runs as long as the queue
 *     does (their other appointments today are drawn as ever);
 *   · blocked time, the doctor's own;
 *   · free time: the working day — 8 AM to 5 PM, Monday to Saturday, widened
 *     to take in anything the doctor has earlier or later — less all of the above;
 *   · off hours: the rest.
 *
 * Overlaps are merged for the totals, so no minute counts twice; on the one
 * row a bar ends where the next begins. Free time from now on can be tapped
 * to schedule a patient — never time already gone.
 */

import { format } from 'date-fns'

import { CLINIC_LIST } from '@/data/clinical'
import { SESSIONS } from '@/data/schedule'

import { NOW, clock12, span12 } from '../lib/clock'
import { clinicMatches, type ShriEntry } from '../logic/schedule'

import type { CalendarDay } from './useMyDay'

export const GRID_START = 7
export const GRID_HOURS = 12
export const START = GRID_START * 60
export const END = START + GRID_HOURS * 60

export type Span = [number, number]

/** The working day, Monday to Saturday. */
const WORK: Span = [8 * 60, 17 * 60]
const DEFAULT_SLOT = 15
/** Free time shorter than this is not named "next free". */
const MIN_FREE = 15
/** How long a patient scheduled into free time is booked for, at most — less where the free time ends sooner. */
export const SCHEDULE_MIN = 30

export type ActivityKind = 'brief' | 'opd' | 'tele' | 'ward' | 'paper' | 'discharge' | 'stroke' | 'patient' | 'procedure' | 'other'
export type ItemKind = ActivityKind | 'blocked' | 'free' | 'off'

export const KIND_LABEL: Record<ItemKind, string> = {
  brief: 'Morning brief',
  opd: 'OPD',
  tele: 'Teleconsult',
  ward: 'Ward round',
  paper: 'Paperwork',
  discharge: 'Discharge',
  stroke: 'Stroke',
  patient: 'Booked patient',
  procedure: 'Procedure',
  other: 'Other',
  blocked: 'Blocked',
  free: 'Available',
  off: 'Off hours',
}

const ACTIVITY_KINDS = new Set<ItemKind>(['brief', 'opd', 'tele', 'ward', 'paper', 'discharge', 'stroke', 'patient', 'procedure', 'other'])
export const isActivity = (k: ItemKind): k is ActivityKind => ACTIVITY_KINDS.has(k)

/** A session's kind, from its icon (the day plan's and the calendar's own). */
const BY_ICON: Record<string, ActivityKind> = {
  Sunrise: 'brief',
  Stethoscope: 'opd',
  Video: 'tele',
  BedDouble: 'ward',
  PenLine: 'paper',
  Signature: 'paper',
  FileText: 'paper',
  ClipboardList: 'paper',
  DoorOpen: 'discharge',
  LogOut: 'discharge',
  Brain: 'stroke',
  Network: 'stroke',
  Syringe: 'procedure',
}

export function kindOf(e: ShriEntry): ActivityKind {
  if (e.kind === 'appointment') return e.appointment?.kind === 'Teleconsult' ? 'tele' : e.appointment?.kind === 'Procedure' ? 'procedure' : 'patient'
  return BY_ICON[e.icon] ?? 'other'
}

export interface TimelineItem {
  id: string
  kind: ItemKind
  start: number
  end: number
  /** Where its bar ends on the one row — at the next activity's start, where they overlap. */
  drawEnd: number
  title: string
  entry?: ShriEntry
  /** Free time already gone: drawn, never offered. */
  past?: boolean
}

export interface HourCell {
  start: number
  busyMin: number
  blockedMin: number
  offMin: number
  freeMin: number
  bookings: number
  titles: string[]
}

export interface DayModel {
  /** Every bar, in time order, covering 7 AM to 7 PM end to end. */
  items: TimelineItem[]
  busyMin: number
  blockedMin: number
  freeMin: number
  offMin: number
  /** The first free stretch of 15 minutes or more still to come. */
  nextFree: number | null
  /** Hour by hour, for screen readers. */
  cells: HourCell[]
  /** Now, in minutes after midnight, on today; null on any other day. */
  now: number | null
  /** The day in one sentence: the chart's accessible name. */
  summary: string
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

const total = (spans: Span[]) => spans.reduce((n, [a, b]) => n + b - a, 0)
const overlap = (spans: Span[], [a, b]: Span) => spans.reduce((n, [s, e]) => n + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0)
const minus = (spans: Span[], cut: Span[]): Span[] =>
  cut.reduce<Span[]>(
    (acc, [cs, ce]) => acc.flatMap(([s, e]): Span[] => (ce <= s || cs >= e ? [[s, e]] : ([cs > s ? [s, cs] : null, ce < e ? [ce, e] : null].filter(Boolean) as Span[]))),
    spans,
  )

const slotFor = (clinic: string | undefined) => (clinic && SESSIONS.find((s) => clinicMatches(clinic, s.clinic))?.slotMin) || DEFAULT_SLOT
const spanOf = (e: ShriEntry): Span => {
  const s = minutesOf(e.at)
  if (e.kind === 'appointment') return [s, s + (e.appointment?.minutes ?? slotFor(e.appointment?.clinic))]
  return [s, e.until ? minutesOf(e.until) : s + 30]
}

export function dayModel(day: CalendarDay): DayModel {
  const now = day.isToday ? minutesOf(NOW) : null
  /** Everything before this has gone. */
  const gone = now ?? (day.date < NOW ? END : START)

  const blocks = day.blocks
    .map((e) => ({ e, span: clip(e.block!.allDay ? [START, END] : spanOf(e)) }))
    .filter((b): b is { e: ShriEntry; span: Span } => b.span !== null)
  const blocked = merge(blocks.map((b) => b.span))
  const sessions = day.sessions.filter((e) => !e.blocked).map((e) => ({ e, span: spanOf(e) }))
  const inSessions = merge(sessions.map((s) => s.span))
  // Today's clinic visits are the OPD queue — the OPD block — not bars of their own, whatever became of the patient.
  const visits = new Map(day.isToday ? CLINIC_LIST.map((r) => [r.patientId, r.bookedAt.getTime()]) : [])
  const outside = day.bookings
    .filter((e) => visits.get(e.patientId ?? '') !== e.at.getTime())
    .map((e) => ({ e, span: spanOf(e) }))
    .filter((b) => overlap(inSessions, b.span) === 0)
  const occupied = [...sessions, ...outside]
    .map((o) => ({ e: o.e, span: clip(o.span) }))
    .filter((o): o is { e: ShriEntry; span: Span } => o.span !== null)
  const doing = merge(occupied.map((o) => o.span))
  const busy = minus(doing, blocked)

  // The working day, widened for anything earlier or later; a Sunday is only what is booked on it.
  const first = doing[0]?.[0]
  const last = doing[doing.length - 1]?.[1]
  const work: Span | null =
    day.date.getDay() === 0 ? (first !== undefined ? [first, last!] : null) : [Math.min(WORK[0], first ?? WORK[0]), Math.max(WORK[1], last ?? WORK[1])]
  const taken = merge([...doing, ...blocked])
  const free = work ? minus([work], taken) : []
  const off = minus(minus([[START, END]], work ? [work] : []), taken)

  // The bars. Blocked time lies under everything; activities sit on one row, each ending where the next begins.
  const acts = occupied
    .map(({ e, span }) => ({ id: e.id, kind: kindOf(e) as ItemKind, start: span[0], end: span[1], drawEnd: span[1], title: e.title, entry: e }))
    .sort((x, y) => x.start - y.start || y.end - x.end)
  acts.forEach((a, i) => {
    const next = acts.slice(i + 1).find((n) => n.start > a.start)
    if (next && next.start < a.end) a.drawEnd = next.start
  })
  const items: TimelineItem[] = [
    ...blocks.map(({ e, span }) => ({ id: e.id, kind: 'blocked' as const, start: span[0], end: span[1], drawEnd: span[1], title: `Blocked · ${e.block!.reason}`, entry: e })),
    ...acts,
    ...off.map(([a, b]) => ({ id: `off-${a}`, kind: 'off' as const, start: a, end: b, drawEnd: b, title: 'Off hours' })),
  ]
  // Free time, split at now: what has gone is drawn but never offered.
  for (const [a, b] of free) {
    if (a < gone) items.push({ id: `gone-${a}`, kind: 'free', start: a, end: Math.min(b, gone), drawEnd: Math.min(b, gone), title: 'Free', past: true })
    if (b > gone) items.push({ id: `free-${Math.max(a, gone)}`, kind: 'free', start: Math.max(a, gone), end: b, drawEnd: b, title: 'Free' })
  }
  items.sort((x, y) => x.start - y.start)

  const open = items.filter((i) => i.kind === 'free' && !i.past && i.end - i.start >= MIN_FREE)

  const cells: HourCell[] = Array.from({ length: GRID_HOURS }, (_, i) => {
    const span: Span = [START + i * 60, START + (i + 1) * 60]
    const busyMin = overlap(busy, span)
    const blockedMin = overlap(blocked, span)
    const offMin = overlap(off, span)
    const titles = [
      ...blocks.filter((b) => overlap([b.span], span) > 0).map((b) => `Blocked · ${b.e.block!.reason}`),
      ...occupied.filter((o) => overlap([o.span], span) > 0).map((o) => o.e.title),
    ]
    return {
      start: span[0],
      busyMin,
      blockedMin,
      offMin,
      freeMin: 60 - busyMin - blockedMin - offMin,
      bookings: day.bookings.filter((b) => minutesOf(b.at) >= span[0] && minutesOf(b.at) < span[1]).length,
      titles: [...new Set(titles)],
    }
  })

  const busyMin = total(busy)
  const blockedMin = total(blocked)
  const offMin = total(off)
  const freeMin = GRID_HOURS * 60 - busyMin - blockedMin - offMin
  const nextFree = open[0]?.start ?? null
  const booked = day.bookings.length
  const summary = [
    `${format(day.date, 'EEEE d MMMM')}: busy ${durationSpoken(busyMin)}, free ${durationSpoken(freeMin)}`,
    offMin ? `off hours ${durationSpoken(offMin)}` : '',
    blockedMin ? `blocked ${durationSpoken(blockedMin)}` : '',
    booked ? `${booked} patient${booked === 1 ? '' : 's'} booked` : '',
    nextFree !== null ? `next free ${clock12(nextFree)}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return { items, busyMin, blockedMin, freeMin, offMin, nextFree, cells, now, summary }
}

/** One hour, for the screen-reader list: "2–3 PM · busy · OPD · 2 patients". */
export function hourLine(c: HourCell) {
  const parts = [
    c.busyMin === 60 ? 'busy' : c.busyMin && `${c.busyMin} min busy`,
    c.blockedMin === 60 ? 'blocked' : c.blockedMin && `${c.blockedMin} min blocked`,
    c.offMin === 60 ? 'off hours' : c.offMin && `${c.offMin} min off hours`,
    c.freeMin === 60 ? 'free' : c.freeMin && `${c.freeMin} min free`,
  ].filter(Boolean)
  const who = c.bookings ? ` · ${c.bookings} patient${c.bookings === 1 ? '' : 's'}` : ''
  return `${span12(c.start, c.start + 60)} · ${parts.join(', ')}${c.titles.length ? ` · ${c.titles.join(', ')}` : ''}${who}`
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

/** The minute on a date, as a Date. */
export const atMinute = (date: Date, min: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(min / 60), min % 60)
