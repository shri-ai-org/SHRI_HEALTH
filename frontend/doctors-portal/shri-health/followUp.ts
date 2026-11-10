// The doctor's follow-up request on the SHRI_HEALTH API (demo step 10, D98), for the follow-up
// screen (`src/shri/notes/FollowUpPage.tsx`). Connected:
//   loadFollowUp        ⇐ getEncounter(encounterId): the visit's `followUp` and its ETag; the
//                          bookable visit types and providers for the two optional fields
//   saveFollowUp        ⇒ setFollowUpRequest(encounterId, body), If-Match = the encounter's ETag;
//                          a 412 means the visit changed: the screen reads it again
//   withdrawFollowUp    ⇒ withdrawFollowUpRequest(encounterId, { reason }), If-Match as above;
//                          only the clinician who asked, and only while it is open (409 otherwise)
// Neither operation takes an Idempotency-Key (the contract has none: PUT replaces, and withdraw
// is guarded by If-Match). Booking the revisit is the front desk's (D67); declining is theirs too.
import { ApiError, etagOf } from '../../src/api/client'
import {
  getEncounter,
  setFollowUpRequest,
  withdrawFollowUpRequest,
} from '../../src/api/generated/endpoints/encounters/encounters'
import {
  listBookableAppointmentTypes,
  listBookableProviders,
} from '../../src/api/generated/endpoints/scheduling/scheduling'
import type {
  FollowUpIntervalUnit,
  FollowUpRequest,
  FollowUpRequestPut,
} from '../../src/api/generated/model'
import { isProblem, problemCopy } from '../../src/design-system/problem/problem'

export type Unit = FollowUpIntervalUnit

export interface Option {
  id: string
  label: string
}

export interface FollowUpState {
  encounterId: string
  patientId: string
  /** The visit's status: a follow-up is asked for while it is open or just finished. */
  encounterStatus: string
  followUp: FollowUpRequest | null
  /** The encounter's ETag: If-Match for the next change. */
  etag: string
}

export interface FollowUpChoices {
  types: Option[]
  providers: Option[]
}

/** A refusal the screen shows as it is: the copy for its Problem code, and the field it names. */
export class FollowUpRefusal extends Error {
  readonly status: number
  readonly code: string | null
  readonly pointer: string | null

  constructor(message: string, status: number, code: string | null, pointer: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.pointer = pointer
  }
}

/** Every API failure as a FollowUpRefusal, worded by problemCopy (the code, never the title). */
export function refusal(e: unknown): FollowUpRefusal {
  if (e instanceof FollowUpRefusal) return e
  if (e instanceof ApiError) {
    const problem = e.problem
    const copy = problemCopy(problem)
    const first = isProblem(problem) && Array.isArray(problem.errors) ? problem.errors[0] : null
    const pointer = first && typeof first.pointer === 'string' ? first.pointer : null
    return new FollowUpRefusal(copy.message, e.status, problem.code ?? null, pointer)
  }
  return new FollowUpRefusal(e instanceof Error ? e.message : String(e), 0, null)
}

export async function loadFollowUp(encounterId: string): Promise<FollowUpState> {
  try {
    const res = await getEncounter(encounterId)
    if (res.status !== 200) throw new Error('The visit could not be read')
    const etag = etagOf(res)
    if (!etag) throw new Error('The visit has no version to change it against')
    return {
      encounterId,
      patientId: res.data.patientId,
      encounterStatus: res.data.status,
      followUp: res.data.followUp ?? null,
      etag,
    }
  } catch (e) {
    throw refusal(e)
  }
}

/** The bookable visit types and providers, for the optional "kind of visit" and "with whom". */
export async function loadChoices(): Promise<FollowUpChoices> {
  try {
    const [types, providers] = await Promise.all([
      listBookableAppointmentTypes({ limit: 100 }),
      listBookableProviders({ limit: 100 }),
    ])
    return {
      types: types.status === 200 ? types.data.items.map((t) => ({ id: t.id, label: t.name })) : [],
      providers: providers.status === 200
        ? providers.data.items.map((p) => ({ id: p.id, label: p.displayName }))
        : [],
    }
  } catch (e) {
    throw refusal(e)
  }
}

export interface FollowUpForm {
  value: number
  unit: Unit
  appointmentTypeId: string
  providerId: string
  note: string
}

export function toBody(form: FollowUpForm): FollowUpRequestPut {
  const body: FollowUpRequestPut = { interval: { value: form.value, unit: form.unit } }
  if (form.appointmentTypeId) body.appointmentTypeId = form.appointmentTypeId
  if (form.providerId) body.providerId = form.providerId
  if (form.note.trim()) body.note = form.note.trim()
  return body
}

/** Asks for (or changes) the revisit; returns the request and the encounter's new ETag. */
export async function saveFollowUp(state: FollowUpState, form: FollowUpForm
): Promise<FollowUpState> {
  try {
    const res = await setFollowUpRequest(state.encounterId, toBody(form), { 'If-Match': state.etag })
    if (res.status !== 200) throw new Error('The follow-up was not saved')
    return { ...state, followUp: res.data, etag: etagOf(res) ?? state.etag }
  } catch (e) {
    throw refusal(e)
  }
}

export async function withdrawFollowUp(state: FollowUpState, reason: string
): Promise<FollowUpState> {
  try {
    const res = await withdrawFollowUpRequest(state.encounterId, { reason: reason.trim() },
                                              { 'If-Match': state.etag })
    if (res.status !== 200) throw new Error('The follow-up was not withdrawn')
    return { ...state, followUp: res.data, etag: etagOf(res) ?? state.etag }
  } catch (e) {
    throw refusal(e)
  }
}

/** "2 weeks", "1 month": the interval as the screen and the desk read it. */
export function intervalLabel(value: number, unit: Unit): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}
