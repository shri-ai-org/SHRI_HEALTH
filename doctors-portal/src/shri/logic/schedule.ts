/**
 * The doctor's calendar as it stands now — the seeded appointment book and
 * sessions (`src/data/record.ts`, `appointments-ext.ts`, `schedule.ts`,
 * `calendar.ts`, all as they were) with the doctor's own changes laid over
 * them (`state/schedule.ts`): blocked time, and appointments moved, handed to
 * the front office to rebook, or cancelled.
 *
 * ONE appointment book for every screen that shows one — My Day's calendar
 * and day detail, the record's Appointments part and its "next" line, the
 * Patient report card, Blocks and leave — so a move or a cancellation shows
 * everywhere at once. Free slots are a lookup, never a prediction: the
 * doctor's own session templates, less what is booked and what is blocked.
 *
 * What a patient is told never carries the reason for a block (the old
 * S-05-05 rule: "they are told the appointment has moved, not why"); the
 * front office gets the reason and what to do with each booking.
 */

import { format } from 'date-fns'
import { useMemo } from 'react'

import { entriesOn, sameDay, type CalendarEntry } from '@/data/calendar'
import { APPOINTMENTS_EXT } from '@/data/appointments-ext'
import { NOW } from '@/data/format'
import { patient } from '@/data/kit'
import type { DayBlock } from '@/data/myday'
import { APPOINTMENTS, type Appointment } from '@/data/record'
import { SESSIONS } from '@/data/schedule'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useNotifications } from '../state/notifications'
import { useSchedule, type AppointmentChange, type Block, type BlockReason } from '../state/schedule'

/* ------------------------------------------------------------ the book */

export type ShriStatus = Appointment['status'] | 'Cancelled' | 'Moved'

export interface ShriAppointment extends Omit<Appointment, 'status'> {
  status: ShriStatus
  change?: AppointmentChange
  /** The appointment this one replaces, when it is a move. */
  movedFrom?: string
  /** Handed to the front office to rebook with the patient; still in the book until they do. */
  rebooking?: boolean
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

export function mergeAppointments(changes: Record<string, AppointmentChange>, booked: ReturnType<typeof useSchedule.getState>['booked']): ShriAppointment[] {
  const withChange = (a: Omit<ShriAppointment, 'change'>): ShriAppointment => {
    const change = changes[a.id]
    const status: ShriStatus = change?.kind === 'cancelled' ? 'Cancelled' : change?.kind === 'moved' ? 'Moved' : a.status
    return { ...a, status, change, rebooking: change?.kind === 'rebooking' }
  }
  const seeded = [...APPOINTMENTS, ...APPOINTMENTS_EXT].map(withChange)
  const here = booked.map((b) => {
    const at = new Date(b.at)
    return withChange({ ...b, at, status: sameDay(at, NOW) ? 'Today' : 'Booked' })
  })
  return [...seeded, ...here].sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** The whole book, live. */
export function useAppointments(): ShriAppointment[] {
  const changes = useSchedule((s) => s.changes)
  const booked = useSchedule((s) => s.booked)
  return useMemo(() => mergeAppointments(changes, booked), [changes, booked])
}

export const isActive = (a: ShriAppointment) => a.status === 'Booked' || a.status === 'Today'

/** Oldest first — the order a history reads in. */
export const appointmentsOf = (book: ShriAppointment[], patientId: string) => book.filter((a) => a.patientId === patientId)

/** The next thing the patient is booked for — today's first, then the future. */
export const nextOf = (book: ShriAppointment[], patientId: string) =>
  book.find((a) => a.patientId === patientId && isActive(a) && a.at.getTime() >= startOfDay(NOW).getTime())

/** A booked appointment of the doctor's own, still to come, is theirs to move or cancel; anyone else's is their clinic's. */
export const canChange = (a: ShriAppointment, staffName: string) => a.with === staffName && isActive(a) && a.at > NOW

/* ------------------------------------------------------------ blocks */

export const dayIso = (d: Date) => format(d, 'yyyy-MM-dd')
const atTime = (day: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
}

export const blocksOn = (blocks: Block[], day: Date) => {
  const iso = dayIso(day)
  return blocks.filter((b) => b.from <= iso && iso <= b.to)
}

/** Whether a block covers a moment — or, given `until`, overlaps a span. */
export function blockCovers(b: Block, at: Date, until?: Date): boolean {
  const iso = dayIso(at)
  if (iso < b.from || iso > b.to) return false
  if (b.allDay) return true
  const s = atTime(at, b.start ?? '00:00').getTime()
  const e = atTime(at, b.end ?? '23:59').getTime()
  return until ? at.getTime() < e && until.getTime() > s : at.getTime() >= s && at.getTime() < e
}

const DAY = 'EEE d MMM'
export const whenLabel = (d: Date) => format(d, `${DAY} yyyy, HH:mm`)
export const slotLabel = (d: Date) => format(d, `${DAY}, HH:mm`)

/** "Thu 24 Sep, all day" · "Thu 24 – Fri 25 Sep, 09:00–12:00". */
export function rangeLabel(b: Pick<Block, 'from' | 'to' | 'allDay' | 'start' | 'end'>): string {
  const from = new Date(`${b.from}T00:00`)
  const to = new Date(`${b.to}T00:00`)
  const days = b.from === b.to ? format(from, DAY) : `${format(from, from.getMonth() === to.getMonth() ? 'EEE d' : DAY)} – ${format(to, DAY)}`
  return `${days}, ${b.allDay ? 'all day' : `${b.start}–${b.end}`}`
}

/** The doctor's own active bookings still to come that a block would displace. */
export const affectedBy = (book: ShriAppointment[], block: Omit<Block, 'id' | 'by' | 'at'>, staffName: string) =>
  book.filter((a) => canChange(a, staffName) && blockCovers({ ...block, id: '', by: '', at: '' }, a.at))

/* ------------------------------------------------------------ free slots */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parseDmy = (s: string) => {
  const [d, mon, y] = s.split('-')
  return new Date(Number(y), MONTHS.indexOf(mon), Number(d))
}

export interface Slot {
  at: Date
  clinic: string
  slotMin: number
}

/** Whether a session is the same kind of clinic as an appointment's — so a move keeps the patient in the right room. */
export function clinicMatches(appointmentClinic: string, sessionClinic: string): boolean {
  const a = appointmentClinic.toLowerCase()
  const s = sessionClinic.toLowerCase()
  if (a.includes('endocrine') || a.includes('thyroid') || a.includes('diabetes')) return s.includes('thyroid') || s.includes('endocrine')
  if (a.includes('general medicine')) return s.startsWith('general medicine')
  return s.split(/[ ,]+/).some((w) => w.length > 3 && a.includes(w))
}

/**
 * The doctor's next free slots: their own sessions from the templates, on the
 * days each runs, one slot per template step — less anything past, anything
 * already booked with them, anything blocked (including a block still being
 * set up), and anything already chosen for another patient in the same
 * decision. Same kind of clinic first, then the rest, each in time order.
 */
export function freeSlots(
  book: ShriAppointment[],
  blocks: Block[],
  staffName: string,
  { hint, limit = 5, days = 42, taken = [] }: { hint?: string; limit?: number; days?: number; taken?: Date[] } = {},
): Slot[] {
  const mine = book.filter((a) => a.with === staffName && isActive(a))
  const all: Slot[] = []
  for (let i = 0; i <= days; i += 1) {
    const day = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + i)
    for (const s of SESSIONS) {
      if (s.day !== WEEKDAYS[day.getDay()] || day < parseDmy(s.effectiveFrom)) continue
      const end = atTime(day, s.end).getTime()
      for (let t = atTime(day, s.start); t.getTime() + s.slotMin * 60_000 <= end; t = new Date(t.getTime() + s.slotMin * 60_000)) {
        if (t <= NOW) continue
        const tEnd = new Date(t.getTime() + s.slotMin * 60_000)
        if (blocks.some((b) => blockCovers(b, t, tEnd))) continue
        if (mine.some((a) => a.at >= t && a.at < tEnd)) continue
        if (taken.some((x) => x.getTime() === t.getTime())) continue
        all.push({ at: t, clinic: s.clinic, slotMin: s.slotMin })
      }
    }
  }
  const same = hint ? all.filter((s) => clinicMatches(hint, s.clinic)) : []
  const rest = all.filter((s) => !same.includes(s))
  return [...same, ...rest].slice(0, limit)
}

/* ------------------------------------------------------------ the calendar */

export type EntryKind = 'session' | 'appointment' | 'block'

export interface ShriEntry extends Omit<CalendarEntry, 'kind'> {
  kind: EntryKind
  /** A session inside blocked time. */
  blocked?: boolean
  appointment?: ShriAppointment
  block?: Block
}

/** The old calendar's appointment icons (`src/data/calendar.ts`). */
const APPOINTMENT_ICON: Record<Appointment['kind'], string> = {
  'Follow-up': 'CalendarCheck',
  Review: 'Stethoscope',
  Procedure: 'Syringe',
  Investigation: 'FlaskConical',
  Teleconsult: 'Video',
  Transfer: 'Ambulance',
}

/**
 * Everything on one date, in time order: the doctor's blocked time, their
 * sessions (today, the day plan), and the patients booked with them from the
 * live book — a cancelled or moved appointment is no longer on the day it
 * left. A day is critical only while something critical is outstanding: the
 * morning brief's "0 critical" no longer marks the day red.
 */
export function entriesFor(
  day: Date,
  ctx: { staffName: string; stroke: boolean; today: DayBlock[]; book: ShriAppointment[]; blocks: Block[]; criticalCount: number },
): ShriEntry[] {
  const dayBlocks = blocksOn(ctx.blocks, day)
  const sessions: ShriEntry[] = entriesOn(day, { staffName: ctx.staffName, stroke: ctx.stroke, today: ctx.today })
    .filter((e) => e.kind === 'session')
    .map((e) => ({
      ...e,
      kind: 'session' as const,
      critical: e.critical === true && ctx.criticalCount > 0,
      blocked: dayBlocks.some((b) => blockCovers(b, e.at, e.until ?? new Date(e.at.getTime() + 30 * 60_000))),
    }))
  const bookings: ShriEntry[] = ctx.book
    .filter((a) => a.with === ctx.staffName && sameDay(a.at, day) && a.status !== 'Cancelled' && a.status !== 'Moved')
    .map((a) => {
      const p = patient(a.patientId)
      return {
        id: a.id,
        at: a.at,
        title: p.name,
        detail: `${a.purpose} · ${a.clinic}`,
        kind: 'appointment' as const,
        icon: APPOINTMENT_ICON[a.kind],
        to: `/patient/${p.uhid}/appointments`,
        patientId: a.patientId,
        done: a.status === 'Completed',
        appointment: a,
      }
    })
  const blocked: ShriEntry[] = dayBlocks.map((b) => ({
    id: `block-${b.id}-${dayIso(day)}`,
    at: b.allDay ? startOfDay(day) : atTime(day, b.start ?? '00:00'),
    until: b.allDay ? undefined : atTime(day, b.end ?? '23:59'),
    title: 'Blocked',
    detail: b.reason,
    kind: 'block' as const,
    icon: 'Ban',
    block: b,
  }))
  return [...blocked, ...sessions, ...bookings].sort((x, y) => x.at.getTime() - y.at.getTime())
}

/** How full a day is, over what the doctor will actually do: blocked time and the sessions inside it do not count. */
export function loadOf(entries: ShriEntry[]): 0 | 1 | 2 | 3 {
  const n = entries.filter((e) => e.kind !== 'block' && !e.blocked).length
  return n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3
}

/* ------------------------------------------------------------ actions */

export type Decision = { action: 'move'; slot: Slot } | { action: 'rebook' } | { action: 'cancel'; reason: string }

export interface BlockInput {
  from: string
  to: string
  allDay: boolean
  start?: string
  end?: string
  reason: BlockReason
  note?: string
}

/**
 * Every change to the calendar, done once: the store, the audit row, the
 * patient's notice (never the reason for a block) and the front office's
 * (with it), and the doctor's toast.
 */
export function useScheduleActions() {
  const me = useCurrentStaff()
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const toast = useUI((s) => s.toast)
  const store = useSchedule()

  const actor = { actor: me.name, actorId: me.id }
  const where = (a: ShriAppointment) => a.location ?? a.clinic

  /** One booking, changed; `quiet` leaves the front office's notice to the caller (a block sends one message for all of them). */
  function apply(a: ShriAppointment, d: Decision, quiet = false): string {
    const p = patient(a.patientId)
    const was = whenLabel(a.at)
    const now = new Date().toISOString()
    if (d.action === 'move') {
      const id = `AP-H-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const { change: _c, rebooking: _r, status: _s, movedFrom: _m, ...rest } = a
      store.book({ ...rest, id, at: d.slot.at.toISOString(), status: 'Booked', movedFrom: a.id })
      store.setChange(a.id, { kind: 'moved', to: id, by: me.name, at: now })
      audit({ event: 'APPOINTMENT.RESCHEDULED', ...actor, subject: a.patientId, detail: `${a.id} · ${was} → ${whenLabel(d.slot.at)} · ${p.name}` })
      send({ severity: 'routine', kind: 'appointment', recipient: 'patient', title: `Appointment moved — ${slotLabel(d.slot.at)}`, detail: `${p.name}: your appointment with ${me.name} on ${was} is now on ${whenLabel(d.slot.at)}, ${where(a)}.`, to: `/patient/${p.uhid}/appointments` })
      if (!quiet) send({ severity: 'routine', kind: 'appointment', recipient: 'front office', title: `Appointment moved — ${p.name}`, detail: `${was} → ${whenLabel(d.slot.at)} · ${a.clinic} · ${me.name}. The patient has been told.`, to: `/patient/${p.uhid}/appointments` })
      return `${p.name} ${was} → moved to ${whenLabel(d.slot.at)}`
    }
    if (d.action === 'rebook') {
      store.setChange(a.id, { kind: 'rebooking', by: me.name, at: now })
      audit({ event: 'APPOINTMENT.REBOOK_REQUESTED', ...actor, subject: a.patientId, detail: `${a.id} · ${was} · ${p.name}` })
      send({ severity: 'routine', kind: 'appointment', recipient: 'patient', title: 'Your appointment is being rearranged', detail: `${p.name}: the front office will call you to agree a new time for your appointment with ${me.name} on ${was}.`, to: `/patient/${p.uhid}/appointments` })
      if (!quiet) send({ severity: 'urgent', kind: 'appointment', recipient: 'front office', title: `Rebook ${p.name}`, detail: `${was} with ${me.name} · ${a.clinic}. Call the patient to agree a new time.`, to: `/patient/${p.uhid}/appointments` })
      return `${p.name} ${was} → the front office to rebook with the patient`
    }
    store.setChange(a.id, { kind: 'cancelled', reason: d.reason, by: me.name, at: now })
    audit({ event: 'APPOINTMENT.CANCELLED', ...actor, subject: a.patientId, detail: `${a.id} · ${was} · ${p.name} · ${d.reason}` })
    send({ severity: 'routine', kind: 'appointment', recipient: 'patient', title: 'Appointment cancelled', detail: `${p.name}: your appointment with ${me.name} on ${was} is cancelled. The front office will contact you if a new one is needed.`, to: `/patient/${p.uhid}/appointments` })
    if (!quiet) send({ severity: 'routine', kind: 'appointment', recipient: 'front office', title: `Appointment cancelled — ${p.name}`, detail: `${was} with ${me.name} · ${a.clinic}. Reason: ${d.reason}.`, to: `/patient/${p.uhid}/appointments` })
    return `${p.name} ${was} → cancelled (${d.reason})`
  }

  return {
    reschedule(a: ShriAppointment, slot: Slot) {
      apply(a, { action: 'move', slot })
      toast({ tone: 'success', title: 'Appointment moved', detail: `${patient(a.patientId).name} · ${whenLabel(slot.at)}. The patient and the front office are told.` })
    },
    rebook(a: ShriAppointment) {
      apply(a, { action: 'rebook' })
      toast({ tone: 'info', title: 'Sent to the front office to rebook', detail: `${patient(a.patientId).name} is told the front office will call.` })
    },
    cancel(a: ShriAppointment, reason: string) {
      apply(a, { action: 'cancel', reason })
      toast({ tone: 'info', title: 'Appointment cancelled', detail: `${patient(a.patientId).name} · ${whenLabel(a.at)}. The patient and the front office are told.` })
    },
    /** Block the time, act on every booking it displaces, and tell the front office once. */
    block(input: BlockInput, displaced: { appointment: ShriAppointment; decision: Decision }[]) {
      const b: Block = { ...input, id: `BLK-${Date.now().toString(36)}`, by: me.name, at: new Date().toISOString() }
      store.addBlock(b)
      const lines = displaced.map(({ appointment, decision }) => apply(appointment, decision, true))
      const rebooks = displaced.filter((d) => d.decision.action === 'rebook').length
      send({
        severity: rebooks > 0 ? 'urgent' : 'routine',
        kind: 'schedule',
        recipient: 'front office',
        title: `${me.name} — blocked ${rangeLabel(b)}`,
        detail: `${b.reason}${b.note ? ` · ${b.note}` : ''}. ${lines.length === 0 ? 'No bookings affected.' : `${lines.length} booking${lines.length === 1 ? '' : 's'}: ${lines.join('; ')}.`}`,
        to: '/schedule/blocks',
      })
      audit({
        event: 'SCHEDULE.BLOCKED',
        ...actor,
        subject: me.id,
        detail: `${rangeLabel(b)} · ${b.reason} · ${displaced.length} booking${displaced.length === 1 ? '' : 's'} · told: front office${displaced.length > 0 ? `, ${displaced.length} patient${displaced.length === 1 ? '' : 's'}` : ''}`,
      })
      toast({
        tone: displaced.length > 0 ? 'caution' : 'success',
        title: 'Time blocked',
        detail: `${rangeLabel(b)} · ${b.reason}. The front office is told${displaced.length > 0 ? `, and ${displaced.length} patient${displaced.length === 1 ? ' is' : 's are'} told their appointment has changed` : ''}.`,
      })
      return b
    },
    unblock(b: Block) {
      store.removeBlock(b.id)
      audit({ event: 'SCHEDULE.UNBLOCKED', ...actor, subject: me.id, detail: `${rangeLabel(b)} · ${b.reason}` })
      send({ severity: 'routine', kind: 'schedule', recipient: 'front office', title: `${me.name} — unblocked ${rangeLabel(b)}`, detail: 'The time is bookable again. Appointments already moved or handed to you to rebook stay as they are.', to: '/schedule/blocks' })
      toast({ tone: 'info', title: 'Block removed', detail: `${rangeLabel(b)} is bookable again. The front office is told.` })
    },
  }
}
