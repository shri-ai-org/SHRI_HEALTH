/**
 * The doctor's month — what is on any date, and a short AI brief of the day.
 *
 * Built only from what the record already holds (§8.6 — nothing invented):
 *   • today is the day plan itself (`dayPlanFor`), block for block;
 *   • any other date is the standing week laid over it — the session
 *     templates and the fixed theatre and on-call slots (`schedule.ts`);
 *   • on every date, the appointments booked with this doctor (`APPOINTMENTS`).
 *
 * The brief is AI-608's reading of the day's load, in two or three plain
 * sentences: what the day holds, who is booked, and — where the template has
 * a known habit (a Monday that overruns, a Friday that finishes early) — that
 * too. It is derived, never a default, and hidden with the AI switch off.
 */

import type { ConfidenceBand } from '@/atlas/confidence'

import { NOW, formatTime } from './format'
import { patient } from './kit'
import type { DayBlock } from './myday'
import { APPOINTMENTS } from './record'
import type { Appointment } from './record'
import { SESSIONS, WEEKLY_SLOTS } from './schedule'

export interface CalendarEntry {
  id: string
  at: Date
  until?: Date
  title: string
  detail?: string
  /** A session or activity of the doctor's own, or a patient booked with them. */
  kind: 'session' | 'appointment'
  icon: string
  /** Where the entry opens. */
  to?: string
  patientId?: string
  /** An appointment already seen. */
  done?: boolean
  /** The entry carries something critical — the day plan's "1 critical". */
  critical?: boolean
}

/** How full a day is, as the calendar's dots draw it: nothing, light, moderate, busy. */
export type DayLoad = 0 | 1 | 2 | 3

/**
 * One entry is a light day, two or three moderate, four or more busy. Counted
 * over the doctor's own sessions and the patients booked with them, so a
 * clinic day with bookings reads fuller than a lone on-call.
 */
export function dayLoad(entries: CalendarEntry[]): DayLoad {
  const n = entries.length
  return n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3
}

/** "3 sessions · 2 booked" — what a date holds, in a few words (today's are activities). */
export function dayCounts(day: Date, entries: CalendarEntry[]): string {
  const sessions = entries.filter((e) => e.kind === 'session').length
  const booked = entries.filter((e) => e.kind === 'appointment').length
  const what = sameDay(day, NOW) ? (sessions === 1 ? 'activity' : 'activities') : sessions === 1 ? 'session' : 'sessions'
  const parts = [sessions > 0 && `${sessions} ${what}`, booked > 0 && `${booked} booked`].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing booked'
}

export const LOAD_WORD: Record<DayLoad, string> = {
  0: 'nothing booked',
  1: 'light day',
  2: 'moderate day',
  3: 'busy day',
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * The dates a month view shows: whole weeks, Monday first, from the week
 * holding the 1st to the week holding the last day — five or six rows.
 */
export function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7))
  const last = new Date(year, month + 1, 0)
  const end = new Date(year, month + 1, 0 + (6 - ((last.getDay() + 6) % 7)))
  const days: Date[] = []
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d)
  return days
}

function atTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
}

/** `01-Apr-2026` → a date, for a template's effective-from. */
function parseDmy(s: string): Date {
  const [d, mon, y] = s.split('-')
  return new Date(Number(y), MONTHS.indexOf(mon), Number(d))
}

const APPOINTMENT_ICON: Record<Appointment['kind'], string> = {
  'Follow-up': 'CalendarCheck',
  Review: 'Stethoscope',
  Procedure: 'Syringe',
  Investigation: 'FlaskConical',
  Teleconsult: 'Video',
  Transfer: 'Ambulance',
}

/**
 * Everything on one date, in time order. `today` is the day plan; `stroke`
 * leaves out the standing clinic week, which is not a stroke clinician's.
 */
export function entriesOn(day: Date, { staffName, stroke, today }: { staffName: string; stroke: boolean; today: DayBlock[] }): CalendarEntry[] {
  const out: CalendarEntry[] = []

  if (sameDay(day, NOW)) {
    for (const b of today) {
      out.push({
        id: `block-${b.id}`,
        at: b.at,
        until: b.until,
        title: b.title,
        detail: b.summary,
        kind: 'session',
        icon: b.icon,
        to: b.to,
        critical: b.emphasis?.some((e) => e.tone === 'critical'),
      })
    }
  } else if (!stroke) {
    const name = WEEKDAYS[day.getDay()]
    for (const s of SESSIONS) {
      if (s.day !== name || day < parseDmy(s.effectiveFrom)) continue
      out.push({
        id: `${s.id}-${day.toDateString()}`,
        at: atTime(day, s.start),
        until: atTime(day, s.end),
        title: 'OPD',
        detail: `${s.clinic} · ${s.capacity} slots`,
        kind: 'session',
        icon: 'Stethoscope',
        to: '/schedule/templates',
      })
    }
    for (const w of WEEKLY_SLOTS) {
      if (w.day !== name) continue
      out.push({
        id: `${w.id}-${day.toDateString()}`,
        at: atTime(day, w.start),
        until: atTime(day, w.end),
        title: w.title,
        kind: 'session',
        icon: w.icon,
        to: '/schedule/blocks',
      })
    }
  }

  for (const a of APPOINTMENTS) {
    if (a.with !== staffName || !sameDay(a.at, day)) continue
    const p = patient(a.patientId)
    out.push({
      id: a.id,
      at: a.at,
      title: p.name,
      detail: `${a.purpose} · ${a.clinic}`,
      kind: 'appointment',
      icon: APPOINTMENT_ICON[a.kind],
      to: `/patient/${p.uhid}/appointments`,
      patientId: a.patientId,
      done: a.status === 'Completed',
    })
  }

  return out.sort((x, y) => x.at.getTime() - y.at.getTime())
}

export interface DayBrief {
  text: string
  band: ConfidenceBand
  confidence: number
  /** What the brief was read from — for its "Why?". */
  inputs: { label: string; source: string }[]
}

/** "Ward round" → "ward round", but "OPD" stays "OPD". */
function inSentence(title: string): string {
  return /^[A-Z]{2,}/.test(title) ? title : title.charAt(0).toLowerCase() + title.slice(1)
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** AI-608's brief of one date, from its entries. */
export function dayBrief(day: Date, entries: CalendarEntry[]): DayBrief {
  const sessions = entries.filter((e) => e.kind === 'session')
  const booked = entries.filter((e) => e.kind === 'appointment')
  const isToday = sameDay(day, NOW)
  const past = !isToday && day < NOW
  const weekday = WEEKDAYS[day.getDay()]
  const sentences: string[] = []
  let band: ConfidenceBand = 'HIGH'
  let confidence = 0.95

  if (entries.length === 0) {
    sentences.push(
      day.getDay() === 0 || day.getDay() === 6
        ? 'A weekend with nothing booked — no sessions and no appointments.'
        : 'Nothing is booked for this day: no session and no appointment with you.',
    )
  } else if (isToday) {
    const current = sessions.find((s) => s.at <= NOW && NOW < (s.until ?? new Date(s.at.getTime() + 30 * 60_000)))
    const ahead = sessions.filter((s) => s.at > NOW)
    if (current) sentences.push(`You are in ${inSentence(current.title)}${current.until ? ` until ${formatTime(current.until)}` : ''}.`)
    if (ahead.length > 0) sentences.push(`Still ahead: ${listOf(ahead.map((s) => `${inSentence(s.title)} at ${formatTime(s.at)}`))}.`)
  } else if (sessions.length > 0) {
    sentences.push(
      `${weekday} ${past ? 'had' : 'holds'} ${listOf(sessions.map((s) => `${inSentence(s.title)} ${formatTime(s.at)}–${formatTime(s.until ?? s.at)}`))}.`,
    )
  } else {
    sentences.push(`No session ${past ? 'was' : 'is'} scheduled this ${weekday}.`)
  }

  if (booked.length > 0) {
    const seen = booked.filter((b) => b.done).length
    const named = booked.slice(0, 2).map((b) => `${b.title} (${(b.detail ?? '').split(' · ')[0].toLowerCase()})`)
    const more = booked.length > 2 ? ` and ${booked.length - 2} more` : ''
    if (past) {
      sentences.push(`${booked.length === 1 ? 'One patient was' : `${booked.length} patients were`} seen with you: ${named.join(', ')}${more}.`)
    } else {
      sentences.push(
        `${booked.length === 1 ? 'One patient is' : `${booked.length} patients are`} booked with you${isToday && seen > 0 ? ` (${seen} already seen)` : ''}: ${named.join(', ')}${more}.`,
      )
    }
  }

  // A template's known habit, for a day still to come.
  if (!past && !isToday) {
    const habit = SESSIONS.find((s) => s.day === weekday && s.observation)
    if (habit && sessions.some((s) => s.title === 'OPD')) {
      sentences.push(habit.observation!.split('. ')[0].replace(/\.$/, '') + '.')
      band = habit.observationBand ?? band
      confidence = habit.observationConfidence ?? confidence
    }
  }

  return {
    text: sentences.join(' '),
    band,
    confidence,
    inputs: [
      { label: isToday ? "Today's day plan" : 'Session templates and the base week', source: isToday ? 'My Day' : 'S-05-04 · S-05-05' },
      { label: 'Appointments booked with you', source: 'Appointments' },
      { label: 'Session start and finish times, 12 weeks', source: 'Clinic session history' },
    ],
  }
}
