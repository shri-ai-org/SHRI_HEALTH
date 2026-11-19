/**
 * Refill requests from the patient portal (#415's API; Vimal's plan of 19 Nov, item 2): the patient
 * asks for a refill of a current prescription from the Prescriptions page, and sees each request's
 * answer there. Generated client only; no sample data.
 *
 * The request carries no note: the contract on main still lists an optional `note`, but the API
 * refuses any (422 `/note`, Vimal's demo rule), and #457 drops it from the contract.
 */
import { ApiError } from '../../api/client'
import { createPortalRefillRequest, listPortalRefillRequests } from '../../api/generated/endpoints/portal/portal'
import type { PortalMedication, PortalRefillRequest, PortalRefillRequestList } from '../../api/generated/model'

/** On only in a build with VITE_FEATURE_REFILL_REQUESTS=on (and the real API). Read when called, so a test can switch it. */
export const refillRequestsOn = (): boolean => import.meta.env.VITE_FEATURE_REFILL_REQUESTS === 'on'

/** The patient's own refill requests, every page (up to 10 pages of 100). A failed read throws. */
export async function loadMyRefillRequests(): Promise<PortalRefillRequest[]> {
  const all: PortalRefillRequest[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page += 1) {
    const res = await listPortalRefillRequests({ limit: 100, ...(cursor ? { cursor } : {}) })
    const data = res.data as PortalRefillRequestList
    all.push(...data.items)
    cursor = data.nextCursor ?? undefined
    if (!cursor) break
  }
  return all
}

/** The latest request for each prescription. */
export function latestByPrescription(requests: PortalRefillRequest[]): Map<string, PortalRefillRequest> {
  const latest = new Map<string, PortalRefillRequest>()
  for (const r of requests) {
    const seen = latest.get(r.prescriptionId)
    if (!seen || r.requestedAt > seen.requestedAt) latest.set(r.prescriptionId, r)
  }
  return latest
}

/** Why a medicine has no "Request refill" button, or null when it may have one. */
export type NoRefillReason = 'reported' | 'not-active' | 'open-request' | 'not-refillable'

export function noRefillReason(med: PortalMedication, latest: PortalRefillRequest | undefined, refused: ReadonlySet<string>): NoRefillReason | null {
  if (med.source !== 'prescription') return 'reported'
  if (med.status !== 'active') return 'not-active'
  if (latest?.status === 'requested') return 'open-request'
  if (refused.has(med.id)) return 'not-refillable'
  return null
}

export const NO_REFILL_TEXT: Record<Exclude<NoRefillReason, 'open-request'>, string> = {
  reported: 'Refills for medicines you reported come from the clinic that prescribed them.',
  'not-active': 'Only current medicines can be refilled here.',
  'not-refillable': "This medicine can't be refilled online. Call your clinic.",
}

/** What asking came to, one per answer the page handles. */
export type RequestOutcome =
  | { kind: 'done'; request: PortalRefillRequest }
  | { kind: 'refused'; reason: 'not-active' | 'not-refillable' | 'refill-already-requested' | 'other' } // 409
  | { kind: 'forbidden' } // 403
  | { kind: 'not-found' } // 404
  | { kind: 'stale' } // 412 (the call takes no If-Match today; handled in case it does)
  | { kind: 'invalid' } // 422
  | { kind: 'rate-limited' } // 429
  | { kind: 'error' }

export function requestOutcome(err: unknown): Exclude<RequestOutcome, { kind: 'done' }> {
  if (!(err instanceof ApiError)) return { kind: 'error' }
  switch (err.status) {
    case 403:
      return { kind: 'forbidden' }
    case 404:
      return { kind: 'not-found' }
    case 409: {
      const code = err.problem.errors?.find((e) => e.pointer === '/prescriptionId')?.code
      return { kind: 'refused', reason: code === 'not-active' || code === 'not-refillable' || code === 'refill-already-requested' ? code : 'other' }
    }
    case 412:
      return { kind: 'stale' }
    case 422:
      return { kind: 'invalid' }
    case 429:
      return { kind: 'rate-limited' }
    default:
      return { kind: 'error' }
  }
}

/** Asks for a refill. `idempotencyKey` is one per request the patient makes, the same one on a retry. */
export async function requestRefill(prescriptionId: string, idempotencyKey: string): Promise<RequestOutcome> {
  try {
    const res = await createPortalRefillRequest({ prescriptionId }, { 'Idempotency-Key': idempotencyKey })
    return { kind: 'done', request: res.data as PortalRefillRequest }
  } catch (err) {
    return requestOutcome(err)
  }
}
