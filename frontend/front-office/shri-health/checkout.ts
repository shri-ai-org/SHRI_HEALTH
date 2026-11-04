// Check-out at the desk on the SHRI_HEALTH API (D98), for the check-out sheet
// (`src/flows/checkout/CheckOutFlow.tsx`; Minalini's exception of 2026-11-04).
//
// Every call here is mock until #161 merges: its backend serves them, main doesn't yet.
// TODO(#161), per call:
//   the follow-up        ⇐ the appointment's `followUp` (FollowUpSummary: interval, type, provider,
//                           note, status, version), from getAppointment
//   declineFollowUp      ⇒ declineFollowUpRequest(encounterId, { reason }, { 'If-Match': `"${version}"`,
//                           'Idempotency-Key': key }); a 412 means it changed: read the appointment again
//   afterVisitSummaryUrl ⇒ getAfterVisitSummaryDownloadUrl(encounterId): a one-time link (D105);
//                           a restricted chart needs break-glass first (D109: 403 break-glass-required)
//   checkOut             ⇒ checkOutAppointment(appointmentId, { 'Idempotency-Key': key }); 409
//                           invalid-state-transition names `/followUp` while the follow-up is open
// The mock keeps its state per appointment in this tab only.
import { newIdempotencyKey } from './client'

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

interface MockVisit {
  followUp: DeskFollowUp | null
  checkedOut: boolean
}

const visits = new Map<string, MockVisit>()
const pause = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms))

/** A field the server named in its refusal, so the sheet can point at its section. */
export class DeskRefusal extends Error {
  readonly pointer?: '/followUp' | '/status'
  constructor(message: string, pointer?: '/followUp' | '/status') {
    super(message)
    this.pointer = pointer
  }
}

function visit(appointmentId: string, providerId: string): MockVisit {
  let v = visits.get(appointmentId)
  if (!v) {
    // TODO(#161): the clinician's request comes from the appointment; mock: two weeks with the same doctor.
    v = {
      followUp: { interval: { value: 2, unit: 'week' }, appointmentTypeName: 'Follow-up visit', providerId, note: 'Fasting lipid panel before the visit', status: 'open' },
      checkedOut: false,
    }
    visits.set(appointmentId, v)
  }
  return v
}

export function intervalLabel(i: DeskFollowUp['interval']): string {
  const unit = i.value === 1 ? i.unit : `${i.unit}s`
  return `In ${i.value} ${unit}`
}

export async function loadCheckOut(appointmentId: string, providerId: string): Promise<MockVisit> {
  await pause(600)
  return { ...visit(appointmentId, providerId) }
}

export async function declineFollowUp(appointmentId: string, providerId: string, reason: string, key: string = newIdempotencyKey()): Promise<DeskFollowUp> {
  void key
  await pause()
  const v = visit(appointmentId, providerId)
  if (!v.followUp || v.followUp.status !== 'open') throw new DeskRefusal('The follow-up is no longer open. Close this and open check-out again.', '/followUp')
  v.followUp = { ...v.followUp, status: 'declined', declinedReason: reason.trim() }
  return v.followUp
}

/** Marks the revisit booked (the booking itself is bookAppointment with followUpOfEncounterId, on main). */
export function markRevisitBooked(appointmentId: string, providerId: string, bookedAppointmentId: string): void {
  const v = visit(appointmentId, providerId)
  if (v.followUp) v.followUp = { ...v.followUp, status: 'booked', bookedAppointmentId }
}

export async function afterVisitSummaryUrl(appointmentId: string): Promise<string | null> {
  void appointmentId
  await pause()
  // TODO(#161): the one-time link; there is none to open until then.
  return null
}

export async function checkOut(appointmentId: string, providerId: string, key: string = newIdempotencyKey()): Promise<void> {
  void key
  await pause()
  const v = visit(appointmentId, providerId)
  if (v.followUp?.status === 'open') throw new DeskRefusal('Book the revisit or decline the follow-up first.', '/followUp')
  if (v.checkedOut) throw new DeskRefusal('The patient is already checked out.', '/status')
  v.checkedOut = true
}
