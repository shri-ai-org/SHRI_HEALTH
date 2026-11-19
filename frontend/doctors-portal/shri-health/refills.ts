// SHRI_HEALTH data layer: patients' refill requests for the doctor (#415's API; Thulasi on #85,
// 19 Nov: the screen is Minalini's). listRefillRequests lists the clinic's open requests at the
// user's facilities, oldest first; a restricted chart the user may not open comes without its
// clinical fields (`restricted`). respondToRefillRequest approves (a draft prescription to check,
// sign and send) or declines with a reason code; MD and APP only (D110). Generated client only.
import { ApiError } from '../../src/api/client'
import { listRefillRequests, respondToRefillRequest } from '../../src/api/generated/endpoints/medications/medications'
import type { RefillRequest, RefillRequestList } from '../../src/api/generated/model'

/** The screen and its rail item are off unless the build sets VITE_FEATURE_REFILL_REQUESTS=on. */
export function refillRequestsOn(env: Record<string, unknown> = import.meta.env): boolean {
  return env.VITE_FEATURE_REFILL_REQUESTS === 'on'
}

/**
 * Why a refill is declined: the codes the API accepts (#415; the contract makes them its enum in
 * #452). The patient reads a fixed sentence for each, never the clinician's own words, so there
 * is no free-text note.
 */
export const DECLINE_REASONS = [
  { code: 'needs-visit', label: 'Needs a visit first' },
  { code: 'needs-lab-work', label: 'Needs new lab work first' },
  { code: 'no-longer-recommended', label: 'No longer recommended' },
  { code: 'contact-the-office', label: 'Patient should contact the office' },
] as const

export type DeclineReason = (typeof DECLINE_REASONS)[number]['code']

/** One request as the screen shows it. */
export interface RefillRow {
  id: string
  patientId: string
  /** Absent for a restricted chart. */
  patientName?: string
  mrn?: string
  drug?: string
  directions?: string
  note?: string
  requestedAt: string
  restricted: boolean
}

function nameOf(r: RefillRequest): string | undefined {
  const n = r.patient?.name
  if (!n) return undefined
  return [...(n.given ?? []), n.family].filter(Boolean).join(' ') || undefined
}

export function toRow(r: RefillRequest): RefillRow {
  return {
    id: r.id,
    patientId: r.patientId,
    patientName: r.restricted ? undefined : nameOf(r),
    mrn: r.restricted ? undefined : r.patient?.mrn,
    drug: r.restricted ? undefined : r.display,
    directions: r.restricted ? undefined : r.dosageText,
    note: r.restricted ? undefined : r.note,
    requestedAt: r.requestedAt,
    restricted: r.restricted,
  }
}

/** The open requests, every page (up to 10 pages of 100). A failed read throws the ApiError. */
export async function loadOpenRefills(): Promise<RefillRow[]> {
  const all: RefillRequest[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page += 1) {
    const res = await listRefillRequests({ status: 'requested', limit: 100, ...(cursor ? { cursor } : {}) })
    const data = res.data as RefillRequestList
    all.push(...data.items)
    cursor = data.nextCursor ?? undefined
    if (!cursor) break
  }
  return all.filter((r) => r.status === 'requested').map(toRow)
}

/** What reading the list came to. */
export type ListProblem = 'forbidden' | 'rate-limited' | 'error'

export function listProblem(err: unknown): ListProblem {
  if (err instanceof ApiError && err.status === 403) return 'forbidden'
  if (err instanceof ApiError && err.status === 429) return 'rate-limited'
  return 'error'
}

/** A decision's outcome, one per answer the screen handles. */
export type DecisionOutcome =
  | { kind: 'done'; newPrescriptionId?: string }
  | { kind: 'restricted' } // 403 break-glass-required
  | { kind: 'forbidden' } // 403 permission-denied (not MD or APP)
  | { kind: 'not-found' } // 404
  | { kind: 'conflict' } // 409: already answered
  | { kind: 'stale' } // 412 (the respond call takes no If-Match today; handled in case it does)
  | { kind: 'invalid' } // 422
  | { kind: 'rate-limited' } // 429
  | { kind: 'error' }

export function decisionOutcome(err: unknown): Exclude<DecisionOutcome, { kind: 'done' }> {
  if (!(err instanceof ApiError)) return { kind: 'error' }
  switch (err.status) {
    case 403:
      return err.code === 'break-glass-required' ? { kind: 'restricted' } : { kind: 'forbidden' }
    case 404:
      return { kind: 'not-found' }
    case 409:
      return { kind: 'conflict' }
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

/**
 * Approves or declines one request. `idempotencyKey` is one per decision the doctor makes, and the
 * same one on a retry of that decision (API_STANDARDS §10).
 */
export async function respondToRefill(id: string, decision: { approve: true } | { decline: DeclineReason }, idempotencyKey: string): Promise<DecisionOutcome> {
  try {
    const body = 'approve' in decision ? { decision: 'approve' as const } : { decision: 'decline' as const, reason: decision.decline }
    const res = await respondToRefillRequest(id, body, { 'Idempotency-Key': idempotencyKey })
    const data = res.data as RefillRequest
    return { kind: 'done', ...(data.newPrescriptionId ? { newPrescriptionId: data.newPrescriptionId } : {}) }
  } catch (err) {
    return decisionOutcome(err)
  }
}
