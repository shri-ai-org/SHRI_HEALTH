/**
 * Today's OPD, live — ported from `src/data/myday.ts` (`opdList`, `teleStatus`)
 * so that it reads the session as it happens, not only as it was seeded.
 *
 * ONE list, in ONE order, with ONE status per patient, for every card that
 * shows the outpatient session: My Day's KPI strip and Patients Today, My
 * patients → OPD, and the teleconsult queue. The old build computed the same
 * patients twice (the OPD queue re-sorted the raw clinic list, My Day ranked
 * teleconsults after the waiting room), so the two disagreed about who was
 * first, how many were waiting and whether Meera Krishnan was in the clinic or
 * on video. Here there is nothing to disagree about.
 *
 * The status moves with the doctor: called in, a consultation opened or a
 * teleconsult joined → In room; the note signed or the teleconsult ended →
 * Seen. Order: being admitted, waiting, in the room, teleconsults, not yet
 * arrived, seen — then booked (or scheduled) time.
 */

import { useMemo } from 'react'

import { inpatientRows, opdRows, type Admissions } from '@/data/admissions'
import { TELECONSULT_QUEUE, encounterForPatient, type ClinicRow, type TeleRow } from '@/data/clinical'
import { formatTime } from '@/data/format'
import { isFollowUp, type PatientListRow, type RowMark } from '@/data/myday'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'

import { useOpd } from '../state/opd'

export type LiveStatus = 'Admission in progress' | 'Waiting' | 'In room' | 'Teleconsult' | 'Not arrived' | 'Seen'

export interface OpdRow extends PatientListRow {
  /** The clinic's token and booking, where the patient is on the clinic list. */
  clinic?: ClinicRow
  /** The teleconsult, where they are seen by video. */
  tele?: TeleRow
  live: LiveStatus
  /** When they are due: the clinic booking, or the call's time. */
  due: Date
}

const FOLLOW_UP: RowMark = { label: 'Follow-up', icon: 'History', tone: 'neutral', iconOnly: true }
const NEW_PATIENT: RowMark = { label: 'New patient', icon: 'UserPlus', tone: 'normal' }
const TELECONSULT_PLACE = { icon: 'Video', label: 'Teleconsult' }
const OPD_PLACE = { icon: 'UserRound', label: 'OPD' }

const RANK: Record<LiveStatus, number> = { 'Admission in progress': 0, Waiting: 1, 'In room': 2, Teleconsult: 2.5, 'Not arrived': 3, Seen: 4 }

function mark(live: LiveStatus, tele?: TeleRow): RowMark {
  switch (live) {
    case 'Admission in progress':
      return { label: 'Admission in progress', icon: 'Hourglass', tone: 'attention' }
    case 'Waiting':
      return { label: 'Waiting', icon: 'Clock', tone: 'attention' }
    case 'In room':
      return { label: 'In room', icon: 'DoorOpen', tone: 'normal' }
    case 'Seen':
      return { label: 'Seen', icon: 'Check', tone: 'neutral', iconOnly: true }
    case 'Teleconsult':
      return tele?.videoReady ? { label: formatTime(tele.scheduledAt), icon: 'Clock', tone: 'neutral' } : { label: 'Telephone only', icon: 'Phone', tone: 'attention' }
    default:
      return { label: 'Not arrived', icon: 'CircleDashed', tone: 'neutral' }
  }
}

export interface OpdLive {
  startedAt: Record<string, string>
  finishedAt: Record<string, string>
  /** Whether the patient's consultation note for today is signed. */
  signed: (patientId: string) => boolean
}

/** The list, from the seeded session and what has happened since. */
export function opdLive(admissions: Admissions, live: OpdLive): OpdRow[] {
  const inBed = new Set(inpatientRows(admissions).map((r) => r.patientId))
  const teleFor = (patientId: string) => TELECONSULT_QUEUE.find((t) => t.patientId === patientId)
  const over = (patientId: string) => live.finishedAt[patientId] !== undefined || live.signed(patientId)
  const statusOf = (patientId: string, base: LiveStatus): LiveStatus => {
    if (admissions[patientId]) return 'Admission in progress'
    if (over(patientId)) return 'Seen'
    if (live.startedAt[patientId]) return 'In room'
    return base
  }

  const rows: OpdRow[] = []
  // The clinic list; a patient also on the teleconsult queue is seen by video, once, as the teleconsult.
  for (const r of opdRows(admissions)) {
    const tele = admissions[r.patientId] ? undefined : teleFor(r.patientId)
    const liveStatus = statusOf(r.patientId, tele ? 'Teleconsult' : r.status)
    rows.push({
      patientId: r.patientId,
      place: tele ? TELECONSULT_PLACE : OPD_PLACE,
      kind: isFollowUp(r.patientId) ? FOLLOW_UP : NEW_PATIENT,
      status: mark(liveStatus, tele),
      done: liveStatus === 'Seen',
      clinic: r,
      tele,
      live: liveStatus,
      due: tele ? tele.scheduledAt : r.bookedAt,
    })
  }
  // Teleconsults for someone not on the clinic list and not in a bed.
  const listed = new Set(rows.map((r) => r.patientId))
  for (const t of TELECONSULT_QUEUE) {
    if (listed.has(t.patientId) || inBed.has(t.patientId)) continue
    const liveStatus = statusOf(t.patientId, 'Teleconsult')
    rows.push({
      patientId: t.patientId,
      place: TELECONSULT_PLACE,
      kind: isFollowUp(t.patientId) ? FOLLOW_UP : NEW_PATIENT,
      status: mark(liveStatus, t),
      done: liveStatus === 'Seen',
      tele: t,
      live: liveStatus,
      due: t.scheduledAt,
    })
  }
  return rows.sort((a, b) => RANK[a.live] - RANK[b.live] || a.due.getTime() - b.due.getTime())
}

/** The live OPD for the signed-in session — the one every card reads. */
export function useOpdLive(): OpdRow[] {
  const admissions = useAdmissions((s) => s.admissions)
  const notes = useClinical((s) => s.notes)
  const startedAt = useOpd((s) => s.startedAt)
  const finishedAt = useOpd((s) => s.finishedAt)
  return useMemo(
    () =>
      opdLive(admissions, {
        startedAt,
        finishedAt,
        signed: (patientId) => {
          const enc = encounterForPatient(patientId)
          return enc !== undefined && (enc.type === 'OP' || enc.type === 'TELE') && notes[enc.id]?.status === 'signed'
        },
      }),
    [admissions, notes, startedAt, finishedAt],
  )
}

/** The counts the OPD screens and My Day both say, from the same rows. */
export function opdCounts(rows: OpdRow[]) {
  return {
    booked: rows.length,
    seen: rows.filter((r) => r.live === 'Seen').length,
    waiting: rows.filter((r) => r.live === 'Waiting').length,
    inRoom: rows.filter((r) => r.live === 'In room').length,
  }
}
