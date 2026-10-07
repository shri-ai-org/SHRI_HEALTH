/**
 * Everything My Day shows, read from the old build's data and stores — the day
 * plan, who is on today's lists, what needs the doctor, the tasks, the to-do
 * notes and the month. One hook, so the KPI strip, the lists and every count
 * are computed from the same state and can never disagree.
 */

import { useCallback, useMemo } from 'react'

import { LOAD_WORD, monthDays, sameDay, type DayLoad } from '@/data/calendar'
import { DISCHARGE_BOARD, RESULTS } from '@/data/clinical'
import { patient } from '@/data/kit'
import {
  attentionChronological, attentionFor, currentBlock, dayPlanFor, isStrokePersona, telestrokeList, toFinishFor,
  type AttentionItem, type DayBlock, type PatientListRow,
} from '@/data/myday'
import { SESSIONS } from '@/data/schedule'
import { useAdmissions } from '@/store/admissions'
import { UNATTACHED, useClinical } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'

import { NOW } from '../lib/clock'
import { useInpatientsLive, type InpatientRow } from '../logic/inpatients'
import { entriesFor, loadOf, useAppointments, type ShriEntry } from '../logic/schedule'
import { useOpdLive, type OpdRow } from '../logic/opd'
import { useAiActive, useForcedState } from '../state/ai'
import { useSchedule } from '../state/schedule'
import { useShri } from '../state/store'

/**
 * The day plan, less its one forecast: the Discharge round's "N predicted today"
 * is AI-610's prediction. The block keeps its time and its link and says what
 * the board actually holds — a recorded count.
 */
function withoutForecasts(blocks: DayBlock[]): DayBlock[] {
  return blocks.map((b) =>
    b.ai === 'AI-610'
      ? { ...b, summary: `${DISCHARGE_BOARD.length} on the board`, emphasis: undefined, ai: undefined, band: undefined }
      : b,
  )
}

/**
 * The day plan's counts, read from the live lists rather than from the seeded
 * session, so a block can never disagree with the list it opens: the morning
 * OPD counts the patients in the clinic (a teleconsult is counted once, in its
 * own block), and both say how many have been seen — and it runs until the
 * last patient still to be seen has had their slot, so the day's timeline never
 * offers as free a time the queue is still using; the ward round counts who
 * is still in a bed and who needs attention; the discharge round, who is still
 * on the board.
 */
function withLiveCounts(blocks: DayBlock[], live: { opd: OpdRow[]; inpatients: InpatientRow[]; discharged: (patientId: string) => boolean }): DayBlock[] {
  const clinic = live.opd.filter((r) => r.place.label === 'OPD')
  const tele = live.opd.filter((r) => r.place.label === 'Teleconsult')
  const seen = (rows: OpdRow[]) => rows.filter((r) => r.live === 'Seen').length
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`
  const attention = live.inpatients.filter((r) => r.pinned).length
  return blocks.map((b) => {
    if (b.id === 'opd-am') {
      const fresh = clinic.filter((r) => r.kind?.label === 'New patient').length
      const toSee = clinic.filter((r) => r.live !== 'Seen' && r.live !== 'Admission in progress')
      const last = Math.max(b.until?.getTime() ?? 0, ...toSee.map((r) => r.due.getTime() + CLINIC_SLOT_MIN * 60_000))
      return { ...b, until: last > 0 ? new Date(last) : b.until, summary: `${plural(clinic.length, 'patient')} · ${fresh} new · ${clinic.length - fresh} follow-ups · ${seen(clinic)} seen` }
    }
    if (b.id === 'tele') return { ...b, summary: `${plural(tele.length, 'patient')} · ${seen(tele)} seen` }
    if (b.id === 'round')
      return { ...b, summary: `${plural(live.inpatients.length, 'patient')} · ${attention} need attention`, emphasis: attention > 0 ? [{ text: `${attention} need attention`, tone: 'warning' as const }] : undefined }
    if (b.id === 'discharge') return { ...b, summary: `${DISCHARGE_BOARD.filter((d) => !live.discharged(d.patientId)).length} on the board` }
    return b
  })
}

/** The morning clinic's slot (its session template, `data/schedule.ts`). */
const CLINIC_SLOT_MIN = SESSIONS.find((s) => s.day === 'Monday')?.slotMin ?? 10

export interface CalendarDay {
  iso: string
  date: Date
  inMonth: boolean
  isToday: boolean
  entries: ShriEntry[]
  sessions: ShriEntry[]
  bookings: ShriEntry[]
  /** The doctor's blocked time on this date. */
  blocks: ShriEntry[]
  level: DayLoad
  levelWord: string
  critical: boolean
}

export function useMyDay() {
  const me = useCurrentStaff()
  const persona = useSession((s) => s.persona)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const attentionSort = useShri((s) => s.attentionSort)

  const admissions = useAdmissions((s) => s.admissions)
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const seenAt = useClinical((s) => s.seenAt)
  const pendingSeen = useClinical((s) => s.pendingSeen)
  const notes = useClinical((s) => s.notes)
  const coSigned = useClinical((s) => s.coSigned)
  const triagedReferrals = useClinical((s) => s.triagedReferrals)
  const voiceNotes = useClinical((s) => s.voiceNotes)

  const stroke = isStrokePersona(persona)
  const discharges = useClinical((s) => s.discharges)
  // The live lists every card reads — the same rows, order and statuses as My patients and Telehealth.
  const opd = useOpdLive()
  const inpatients = useInpatientsLive()
  const blocks = useMemo(
    () => withLiveCounts(withoutForecasts(dayPlanFor(persona, { admissions, acknowledgements, coSigned })), { opd, inpatients, discharged: (id) => discharges[id] !== undefined }),
    [persona, admissions, acknowledgements, coSigned, opd, inpatients, discharges],
  )
  const current = currentBlock(blocks)
  const upNext = blocks.find((b) => b.at > NOW && b.id !== current?.id)

  const telestroke = useMemo(() => telestrokeList(), [])

  /** Everything that needs this doctor, ranked by AI-613 — before anyone is marked seen. */
  const attention = useMemo(() => attentionFor(persona, acknowledgements, admissions), [persona, acknowledgements, admissions])
  /** Anyone marked seen drops off the list — that is what marking seen is for. */
  const ranked = useMemo(() => attention.filter((i) => seenAt[i.patientId] === undefined), [attention, seenAt])
  /** A critical result stays critical until a named clinician acknowledges it; marking the patient seen does not. */
  const criticalResults = useMemo(() => unacknowledgedCritical(acknowledgements), [acknowledgements])
  const lowConfidence = forced === 'AI-LOW'

  const toFinish = useMemo(
    () => toFinishFor(persona, { notes, coSigned, triagedReferrals, voiceNotes }),
    [persona, notes, coSigned, triagedReferrals, voiceNotes],
  )
  const todos = voiceNotes[UNATTACHED] ?? []

  // The live book and blocks, so a move, a cancellation or a block shows on the calendar at once.
  const book = useAppointments()
  const blockList = useSchedule((s) => s.blocks)
  const criticalCount = unacknowledgedCritical(acknowledgements).length
  const entriesForDay = useCallback(
    (day: Date) => entriesFor(day, { staffName: me.name, stroke, today: blocks, book, blocks: blockList, criticalCount }),
    [me.name, stroke, blocks, book, blockList, criticalCount],
  )

  const dayInfo = useCallback(
    (date: Date, month?: { year: number; month: number }): CalendarDay => {
      const entries = entriesForDay(date)
      const level = loadOf(entries)
      return {
        iso: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        date,
        inMonth: month ? date.getMonth() === month.month : true,
        isToday: sameDay(date, NOW),
        entries,
        sessions: entries.filter((e) => e.kind === 'session'),
        bookings: entries.filter((e) => e.kind === 'appointment'),
        blocks: entries.filter((e) => e.kind === 'block'),
        level,
        levelWord: LOAD_WORD[level],
        critical: entries.some((e) => e.critical),
      }
    },
    [entriesForDay],
  )

  /** The week holding a date, Monday first. */
  const weekDays = useCallback(
    (anchor: Date): CalendarDay[] => {
      const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((anchor.getDay() + 6) % 7))
      return Array.from({ length: 7 }, (_, i) => dayInfo(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)))
    },
    [dayInfo],
  )

  /** The month grid: whole weeks, Monday first (`monthDays`). */
  const monthWeeks = useCallback(
    (year: number, month: number): CalendarDay[][] => {
      const days = monthDays(year, month).map((d) => dayInfo(d, { year, month }))
      const weeks: CalendarDay[][] = []
      for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
      return weeks
    },
    [dayInfo],
  )

  return {
    me,
    persona,
    stroke,
    aiActive,
    forced,
    blocks,
    current,
    upNext,
    opd,
    inpatients,
    telestroke,
    attention,
    ranked,
    criticalResults,
    /** The attention list in the order it is shown: AI acuity, or time — AI-613's one-click reversal. */
    ordered: (showRanking: boolean) =>
      attentionSort === 'ai' && aiActive && (!lowConfidence || showRanking) ? ranked : attentionChronological(ranked),
    lowConfidence,
    toFinish,
    todos,
    pendingSeen,
    acknowledgements,
    dayInfo,
    weekDays,
    monthWeeks,
  }
}

export type MyDay = ReturnType<typeof useMyDay>

/** A row's patient — the old kit's record. */
export const rowPatient = (r: PatientListRow) => patient(r.patientId)

/** Critical results still waiting for someone to acknowledge them — the Critical KPI's count and sub-line. */
export function unacknowledgedCritical(acknowledgements: Record<string, unknown>) {
  return RESULTS.filter((r) => r.critical && !r.acknowledged && acknowledgements[r.id] === undefined)
}

export type { AttentionItem }
