// Check-out at the desk on the SHRI_HEALTH API (D98), for the check-out sheet
// (`src/flows/checkout/CheckOutFlow.tsx`; Minalini's exception of 2026-11-04). Connected (#161):
//   the follow-up        ⇐ the appointment's `followUp` (FollowUpSummary), from getAppointment
//   declineFollowUp      ⇒ declineFollowUpRequest(encounterId, { reason }), If-Match = the summary's
//                           `version`; a 412 means it changed: the sheet reads the appointment again
//   afterVisitSummaryUrl ⇒ getAfterVisitSummaryDownloadUrl(encounterId): a one-time link (D105);
//                           a restricted chart needs break-glass first (D109: 403 break-glass-required)
//   checkOut             ⇒ checkOutAppointment(appointmentId); 409 names `/followUp` while it is open
// The revisit is booked with bookAppointment and followUpOfEncounterId (scheduling.ts).
import { getAfterVisitSummaryDownloadUrl, declineFollowUpRequest } from '../../src/api/generated/endpoints/encounters/encounters'
import { checkOutAppointment, getAppointment } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { FollowUpRequest, FollowUpSummary } from '../../src/api/generated/model'
import { etagOf } from '../../src/api/client'
import { ApiError, newIdempotencyKey, problemMessage } from './client'
import { appointmentTypeName } from './scheduling'

export type FollowUpStatus = 'open' | 'booked' | 'declined' | 'withdrawn'

export interface DeskFollowUp {
  interval: { value: number; unit: 'day' | 'week' | 'month' }
  appointmentTypeName?: string
  providerId?: string
  note?: string
  status: FollowUpStatus
  declinedReason?: string
  bookedAppointmentId?: string
}

interface DeskVisit {
  followUp: DeskFollowUp | null
  encounterId: string | null
}

/** Per appointment: the encounter and the follow-up's version, for the next change. */
const known = new Map<string, { encounterId: string | null; version?: string }>()

/** A field the server named in its refusal, so the sheet can point at its section. */
export class DeskRefusal extends Error {
  readonly pointer?: '/followUp' | '/status'
  constructor(message: string, pointer?: '/followUp' | '/status') {
    super(message)
    this.pointer = pointer
  }
}

/** The break-glass refusal (D109): a restricted chart, so the desk sends the care team to print the summary (gap 52, by design). */
export class DeskBreakGlass extends Error {}

function fromSummary(f: FollowUpSummary | FollowUpRequest): DeskFollowUp {
  return {
    interval: { value: f.interval.value, unit: f.interval.unit },
    appointmentTypeName: appointmentTypeName(f.appointmentTypeId),
    providerId: f.providerId,
    note: f.note,
    status: f.status,
    bookedAppointmentId: f.bookedAppointmentId,
  }
}

function refusal(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.problem.code === 'break-glass-required') return new DeskBreakGlass(problemMessage(error))
    const pointer = error.problem.errors?.find((e) => e.pointer === '/followUp' || e.pointer === '/status')?.pointer
    if (pointer === '/followUp' || pointer === '/status' || error.status === 409 || error.status === 412) {
      return new DeskRefusal(problemMessage(error), (pointer as '/followUp' | '/status' | undefined) ?? '/followUp')
    }
    return new Error(problemMessage(error))
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function intervalLabel(i: DeskFollowUp['interval']): string {
  const unit = i.value === 1 ? i.unit : `${i.unit}s`
  return `In ${i.value} ${unit}`
}

export async function loadCheckOut(appointmentId: string, providerId: string): Promise<DeskVisit> {
  void providerId
  const res = await getAppointment(appointmentId)
  if (res.status !== 200) throw new Error('The visit could not be read')
  const a = res.data
  known.set(appointmentId, { encounterId: a.encounterId ?? null, version: a.followUp?.version })
  return { followUp: a.followUp ? fromSummary(a.followUp) : null, encounterId: a.encounterId ?? null }
}

export async function declineFollowUp(appointmentId: string, providerId: string, reason: string, key: string = newIdempotencyKey()): Promise<DeskFollowUp> {
  void providerId
  const k = known.get(appointmentId)
  if (!k?.encounterId || !k.version) throw new DeskRefusal('The follow-up is no longer open. Close this and open check-out again.', '/followUp')
  try {
    const res = await declineFollowUpRequest(k.encounterId, { reason: reason.trim() }, { 'If-Match': k.version, 'Idempotency-Key': key })
    if (res.status !== 200) throw new Error('The follow-up was not declined')
    k.version = etagOf(res) ?? undefined
    return { ...fromSummary(res.data), declinedReason: reason.trim() }
  } catch (e) {
    throw refusal(e)
  }
}

/** Marks the revisit booked here; the server links it in the booking's own transaction (D98). */
export function markRevisitBooked(appointmentId: string, providerId: string, bookedAppointmentId: string): void {
  void appointmentId
  void providerId
  void bookedAppointmentId
}

/** The one-time link to the after-visit summary (D105); break-glass first on a restricted chart (D109). */
export async function afterVisitSummaryUrl(appointmentId: string): Promise<string | null> {
  const k = known.get(appointmentId)
  if (!k?.encounterId) return null
  try {
    const res = await getAfterVisitSummaryDownloadUrl(k.encounterId)
    return res.status === 200 ? res.data.url : null
  } catch (e) {
    // 404: none is made until the note is signed (createAfterVisitSummary).
    if (e instanceof ApiError && e.status === 404) return null
    throw refusal(e)
  }
}

export async function checkOut(appointmentId: string, providerId: string, key: string = newIdempotencyKey()): Promise<void> {
  void providerId
  try {
    await checkOutAppointment(appointmentId, { 'Idempotency-Key': key })
  } catch (e) {
    throw refusal(e)
  }
}
