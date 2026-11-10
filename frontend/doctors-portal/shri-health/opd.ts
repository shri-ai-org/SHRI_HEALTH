// SHRI_HEALTH data layer: today's outpatient list (src/shri/logic/opd.ts `useOpdLive`) and the
// doctor's "Call" (src/shri/state/opd.ts `start`) over the staff status board: GET /status-board
// (view=staff) and POST /appointments/{id}/status (with-provider). Rows keep the screen's shape.
import { useEffect } from 'react'
import { create } from 'zustand'

import type { ClinicRow } from '@/data/clinical'
import type { RowMark } from '@/data/myday'
import { useUI } from '@/store/ui'

import type { LiveStatus, OpdRow } from '../src/shri/logic/opd'
import { API_BASE, ApiError, newIdempotencyKey } from '../../src/api/client'
import { getMe, getSession } from '../../src/api/generated/endpoints/platform/platform'
import { getStatusBoard, listBookableFacilities, recordVisitStatus } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { BookableFacility, Me, Session, SessionUser, StatusBoardItem } from '../../src/api/generated/model'
import { problemCopy } from '../../src/design-system/problem/problem'

import { clinicDate, formatTime, setFacilityTimeZone, tick } from './format'
import { read } from './resource'

export { nextToCall, opdCounts, type OpdRow } from '../src/shri/logic/opd'

const REFRESH_MS = 30_000

// Live updates: the event stream (GET /events/stream, streamEvents), one per tab, shared by every
// listener. A check-in, a visit-status change or an encounter-status change reloads; the timer stays
// as the fallback. Events carry IDs and statuses only (core/events.py), and nothing from them is shown.
const LIVE_TYPES = ['appointment.checked-in', 'appointment.status-changed', 'encounter.status-changed', 'stream.reset']
const liveListeners = new Set<() => void>()
let liveSource: EventSource | null = null

export function onLiveChange(listener: () => void): () => void {
  liveListeners.add(listener)
  if (!liveSource && typeof EventSource !== 'undefined') {
    liveSource = new EventSource(`${API_BASE}/events/stream`)
    const notify = () => liveListeners.forEach((l) => l())
    for (const type of LIVE_TYPES) liveSource.addEventListener(type, notify)
  }
  return () => {
    liveListeners.delete(listener)
    if (liveListeners.size === 0) {
      liveSource?.close()
      liveSource = null
    }
  }
}

// As src/shri/logic/opd.ts draws each status (its `mark()` is not exported).
const MARK: Record<LiveStatus, RowMark> = {
  'Admission in progress': { label: 'Admission in progress', icon: 'Hourglass', tone: 'attention' },
  Waiting: { label: 'Waiting', icon: 'Clock', tone: 'attention' },
  'In room': { label: 'In room', icon: 'DoorOpen', tone: 'normal' },
  Seen: { label: 'Seen', icon: 'Check', tone: 'neutral', iconOnly: true },
  Teleconsult: { label: 'Teleconsult', icon: 'Video', tone: 'neutral' },
  'Not arrived': { label: 'Not arrived', icon: 'CircleDashed', tone: 'neutral' },
}
const RANK: Record<LiveStatus, number> = { 'Admission in progress': 0, Waiting: 1, 'In room': 2, Teleconsult: 3, 'Not arrived': 3, Seen: 4 }
const FOLLOW_UP: RowMark = { label: 'Follow-up', icon: 'History', tone: 'neutral', iconOnly: true }
const NEW_PATIENT: RowMark = { label: 'New patient', icon: 'UserPlus', tone: 'normal' }
const OPD_PLACE = { icon: 'UserRound', label: 'OPD' }

/** The visit status as the screen's status: roomed patients still wait for the doctor. */
function liveOf(i: StatusBoardItem): LiveStatus | null {
  if (i.status === 'cancelled' || i.status === 'noshow') return null
  switch (i.visitStatus) {
    case 'with-provider':
      return 'In room'
    case 'checked-out':
      return 'Seen'
    case 'arrived':
    case 'checked-in':
    case 'roomed':
      return 'Waiting'
    default:
      return i.status === 'fulfilled' ? 'Seen' : 'Not arrived'
  }
}

function toRow(i: StatusBoardItem): OpdRow | null {
  const live = liveOf(i)
  if (!live || !i.patient) return null
  const clinic: ClinicRow = {
    // TODO(gap): there is no OPD token in US care; the column shows the appointment time, as the
    // screen does for a row without a token.
    token: formatTime(i.startAt),
    patientId: i.patient.id,
    bookedAt: clinicDate(i.startAt),
    arrivedAt: live === 'Waiting' && i.visitStatusAt ? clinicDate(i.visitStatusAt) : undefined,
    status: live === 'Teleconsult' ? 'Not arrived' : live === 'Admission in progress' ? 'Waiting' : live,
  }
  const code = i.appointmentType?.code ?? ''
  return {
    patientId: i.patient.id,
    place: OPD_PLACE,
    kind: code.includes('FU') ? FOLLOW_UP : code.includes('NEW') ? NEW_PATIENT : undefined,
    status: MARK[live],
    done: live === 'Seen',
    clinic,
    live,
    due: clinicDate(i.startAt),
  }
}

interface BoardState {
  items: StatusBoardItem[]
  /** When the list was last read (ms), so a screen opened again can tell it may be stale. */
  loadedAt: number
  facilityId?: string
  date?: string
  load: () => Promise<void>
  start: (patientId: string) => void
}

/** Today in the facility's own time zone (D40), as YYYY-MM-DD. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

let signedIn: SessionUser | undefined

/** The signed-in user (roles, practitioner), known once loadClinic() has run. */
export const signedInUser = (): SessionUser | undefined => signedIn

/** The user's facility (GET /me, or the session where /me isn't built yet) and its time zone. */
export async function userFacility(): Promise<BookableFacility | undefined> {
  const user = await getMe()
    .then((res) => (res.data as Me).user)
    .catch(async () => ((await getSession()).data as Session).user)
  signedIn = user
  const facilities = ((await listBookableFacilities({ limit: 100 })).data as { items: BookableFacility[] }).items
  const facility = facilities.find((f) => user.facilityIds.includes(f.id)) ?? facilities[0]
  if (facility) setFacilityTimeZone(facility.timeZone)
  return facility
}

/** The clinic's time zone, read once before the first screen with SHRI_API=real (main.tsx). */
export function loadClinic(): Promise<void> {
  return userFacility().then(() => undefined)
}

export const useBoard = create<BoardState>()((set, get) => ({
  items: [],
  loadedAt: 0,
  load: async () => {
    const facility = await userFacility()
    if (!facility) return
    const date = todayIn(facility.timeZone)
    // The clinical team's list (demo step 7): the facility's whole board, so the MA rooms for every
    // provider. My Day's own day is the provider's (useProviderDay in myday.ts).
    const res = await getStatusBoard({ facilityId: facility.id, date, view: 'staff', limit: 100 })
    tick()
    set({ items: (res.data as { items: StatusBoardItem[] }).items, loadedAt: Date.now(), facilityId: facility.id, date })
  },
  start: (patientId) => {
    const item = get().items.find((i) => i.patient?.id === patientId && liveOf(i) === 'Waiting')
    if (!item) return
    recordVisitStatus(item.appointmentId, { status: 'with-provider' }, { 'Idempotency-Key': newIdempotencyKey() })
      .then(() => get().load())
      .catch((error: unknown) => {
        const copy = error instanceof ApiError ? problemCopy(error.problem) : null
        useUI.getState().toast({ tone: 'critical', title: copy?.title ?? 'The patient was not called in', detail: copy?.message })
      })
  },
}))

/** Today's list for the facility, read once through Suspense, then kept fresh by the live stream
 *  (and every 30 s, as the fallback). */
export function useOpdLive(): OpdRow[] {
  read('opd:board', () => useBoard.getState().load())
  const items = useBoard((s) => s.items)
  useEffect(() => {
    const reload = () => void useBoard.getState().load().catch(() => undefined)
    // The stream is closed while no screen listens, so a list opened again (after rooming, say)
    // reads once more rather than show what it had.
    if (Date.now() - useBoard.getState().loadedAt > 2000) reload()
    const t = window.setInterval(reload, REFRESH_MS)
    const stop = onLiveChange(reload)
    return () => {
      window.clearInterval(t)
      stop()
    }
  }, [])
  return items
    .map(toRow)
    .filter((r): r is OpdRow => r !== null)
    .sort((a, b) => RANK[a.live] - RANK[b.live] || a.due.getTime() - b.due.getTime())
}

/** The encounter of a patient's visit today, for the screen's "Start consultation". */
export function encounterOfToday(patientId: string): string | undefined {
  return useBoard.getState().items.find((i) => i.patient?.id === patientId && i.encounterId)?.encounterId
}

/** Whether the user may call a patient in (with-provider: MD, APP and RN, the server's visit-status rule). */
export function mayCall(): boolean {
  if (typeof __SHRI_REAL_API__ === 'undefined' || !__SHRI_REAL_API__) return true
  return signedIn?.roles.some((r) => r === 'MD' || r === 'APP' || r === 'RN') ?? false
}

/** TEMPORARY (demo step 6, shri-health/TemporaryRooming.tsx): the encounter to room while the
 *  patient is checked in and not yet roomed. */
export function roomingOf(patientId: string): string | undefined {
  // Only MA and RN may mark a patient roomed (the server's visit-status rule).
  if (!signedIn?.roles.some((r) => r === 'MA' || r === 'RN')) return undefined
  return useBoard.getState().items.find((i) => i.patient?.id === patientId && i.encounterId && (i.visitStatus === 'arrived' || i.visitStatus === 'checked-in'))?.encounterId
}

export const roomingPath = (encounterId: string) => `/temporary/rooming/${encounterId}`

/** The doctor's "Call": src/shri/state/opd.ts `useOpd`, with start() recording with-provider. */
export const useOpd = <T>(select: (s: { start: (patientId: string) => void; finish: (patientId: string) => void }) => T): T =>
  select({
    start: useBoard.getState().start,
    // TODO(gap): the doctor doesn't finish the visit; check-out is the front desk's (checkOutAppointment, #161).
    finish: () => undefined,
  })
