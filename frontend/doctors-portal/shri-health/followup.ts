// The follow-up request on the SHRI_HEALTH API, for the Follow-up section copied from the
// discharge flow (`src/shri/discharge/DischargeFlow.tsx`) onto the patient instructions page.
//
// Field mapping, discharge flow ⇒ contract (`FollowUpRequestPut`):
//   Date          ⇒ interval { value, unit } (counted from the visit's date, D40)
//   Clinic        ⇒ appointmentTypeId (GET /booking/appointment-types) and providerId (GET /booking/providers)
//   Note for the front office ⇒ note
//   "No follow-up needed" with a reason ⇒ no such state in the contract (a question for Vimal, #85);
//                    kept on the screen only.
//
// Connected (#161 merged): the two lists, setting and withdrawing the request.
import { ApiError, etagOf } from '../../src/api/client'
import { getEncounter, setFollowUpRequest, withdrawFollowUpRequest } from '../../src/api/generated/endpoints/encounters/encounters'
import { listBookableAppointmentTypes, listBookableProviders } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { FollowUpIntervalUnit, FollowUpRequest, FollowUpRequestPut } from '../../src/api/generated/model'
import { problemCopy } from '../../src/design-system/problem/problem'

export interface Option {
  value: string
  label: string
}

export const INTERVAL_UNITS: { value: FollowUpIntervalUnit; label: string }[] = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
]

/** The appointment types and providers the follow-up can name (both `scheduling-reference:read`). */
export async function loadFollowUpOptions(): Promise<{ types: Option[]; providers: Option[] }> {
  const [types, providers] = await Promise.all([listBookableAppointmentTypes({ limit: 100 }), listBookableProviders({ limit: 100 })])
  return {
    types: types.status === 200 ? types.data.items.map((t) => ({ value: t.id, label: t.name })) : [],
    providers: providers.status === 200 ? providers.data.items.map((p) => ({ value: p.id, label: p.displayName })) : [],
  }
}

/** Plain words for a refusal, by its Problem code. */
export function followUpError(error: unknown): string {
  if (error instanceof ApiError) return problemCopy(error.problem).message
  return error instanceof Error ? error.message : String(error)
}

export interface FollowUpDraft {
  followUp?: 'booked' | 'none'
  fuValue?: string
  fuUnit?: FollowUpIntervalUnit
  fuTypeId?: string
  fuProviderId?: string
  fuNote?: string
  fuNoneReason?: string
}

export function toFollowUpRequest(draft: FollowUpDraft): FollowUpRequestPut {
  return {
    interval: { value: Number(draft.fuValue), unit: draft.fuUnit ?? 'week' },
    ...(draft.fuTypeId ? { appointmentTypeId: draft.fuTypeId } : {}),
    ...(draft.fuProviderId ? { providerId: draft.fuProviderId } : {}),
    ...(draft.fuNote?.trim() ? { note: draft.fuNote.trim() } : {}),
  }
}

// The visit's follow-up request on the API (#161): read with the encounter (GET /encounters/{id},
// whose ETag every change sends as If-Match), set with setFollowUpRequest, withdrawn with a reason.
// A 412 means the visit changed since it was read: the next attempt reads it again.
// "No follow-up needed" has no state in the contract (SCREEN_PORT gap 41): kept in this tab only.
export type MockRequest = FollowUpDraft & { status: 'open' | 'withdrawn' | 'booked' | 'declined'; withdrawnReason?: string }
const notNeeded = new Map<string, MockRequest>()

async function readEncounter(encounterId: string): Promise<{ etag: string; followUp?: FollowUpRequest }> {
  const res = await getEncounter(encounterId)
  if (res.status !== 200) throw new Error('The visit could not be read')
  return { etag: etagOf(res) ?? '', followUp: res.data.followUp }
}

function fromRequest(r: FollowUpRequest): MockRequest {
  return {
    followUp: 'booked',
    fuValue: String(r.interval.value),
    fuUnit: r.interval.unit,
    fuTypeId: r.appointmentTypeId,
    fuProviderId: r.providerId,
    fuNote: r.note,
    status: r.status,
    withdrawnReason: r.withdrawnReason,
  }
}

/** The visit's request as the server has it (or this tab's "not needed"), for the section to open on. */
export async function loadFollowUp(encounterId: string): Promise<MockRequest | undefined> {
  const local = notNeeded.get(encounterId)
  if (local) return local
  const { followUp } = await readEncounter(encounterId)
  return followUp ? fromRequest(followUp) : undefined
}

export function followUpRequestFor(encounterId: string): MockRequest | undefined {
  return notNeeded.get(encounterId)
}

/** Sets the visit's follow-up request, replacing an open one. */
export async function saveFollowUp(encounterId: string, draft: FollowUpDraft): Promise<MockRequest> {
  if (draft.followUp === 'none') {
    const request: MockRequest = { ...draft, status: 'open' }
    notNeeded.set(encounterId, request)
    return request
  }
  notNeeded.delete(encounterId)
  const { etag } = await readEncounter(encounterId)
  const res = await setFollowUpRequest(encounterId, toFollowUpRequest(draft), { 'If-Match': etag })
  if (res.status !== 200) throw new Error('The follow-up was not saved')
  return fromRequest(res.data)
}

/** Withdraws the open request, with the clinician's reason. */
export async function withdrawFollowUp(encounterId: string, reason: string): Promise<MockRequest> {
  const local = notNeeded.get(encounterId)
  if (local) {
    notNeeded.delete(encounterId)
    return { ...local, status: 'withdrawn', withdrawnReason: reason.trim() }
  }
  const { etag } = await readEncounter(encounterId)
  const res = await withdrawFollowUpRequest(encounterId, { reason: reason.trim() }, { 'If-Match': etag })
  if (res.status !== 200) throw new Error('The follow-up was not withdrawn')
  return fromRequest(res.data)
}
