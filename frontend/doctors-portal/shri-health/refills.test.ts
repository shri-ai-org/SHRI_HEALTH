import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../src/api/client'
import { decisionOutcome, listProblem, loadOpenRefills, respondToRefill, toRow } from './refills'

// Refill requests for the doctor (#415's API): the list, the decisions and how each answer reads.
// Plain stand-ins for the generated client, not vi.fn, so a refusal can reject. Synthetic only.
const calls: { list: unknown[]; respond: unknown[] } = { list: [], respond: [] }
let listAnswers: Array<() => Promise<unknown>> = []
let respondAnswer: () => Promise<unknown> = () => Promise.resolve({ status: 200, data: { id: 'rr1', newPrescriptionId: 'rx-new' } })
vi.mock('../../src/api/generated/endpoints/medications/medications', () => ({
  listRefillRequests: (params: unknown) => {
    calls.list.push(params)
    return (listAnswers.shift() ?? (() => Promise.resolve({ status: 200, data: { items: [] } })))()
  },
  respondToRefillRequest: (...args: unknown[]) => {
    calls.respond.push(args)
    return respondAnswer()
  },
}))

const problem = (status: number, code: string) => new ApiError({ type: 'about:blank', title: code, status, code } as never, new Headers())
const item = (over: Record<string, unknown>) => ({
  id: 'rr1',
  type: 'renewal',
  status: 'requested',
  patientId: 'p1',
  patient: { id: 'p1', name: { given: ['Example'], family: 'Patient' }, mrn: 'RFM-000099', restricted: false, active: true },
  prescriptionId: 'rx1',
  display: 'omeprazole 20 MG Delayed Release Oral Capsule',
  dosageText: '1 capsule by mouth daily',
  requestedAt: '2026-11-19T17:30:00Z',
  note: 'Down to my last week.',
  restricted: false,
  ...over,
})

beforeEach(() => {
  calls.list = []
  calls.respond = []
  listAnswers = []
})

describe('the list', () => {
  it('reads every page of open requests and keeps only the open ones', async () => {
    listAnswers = [
      () => Promise.resolve({ status: 200, data: { items: [item({ id: 'a' })], nextCursor: 'next' } }),
      () => Promise.resolve({ status: 200, data: { items: [item({ id: 'b' }), item({ id: 'c', status: 'approved' })] } }),
    ]
    const rows = await loadOpenRefills()
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(calls.list).toEqual([{ status: 'requested', limit: 100 }, { status: 'requested', limit: 100, cursor: 'next' }])
  })

  it('keeps no clinical detail of a restricted chart', () => {
    const row = toRow(item({ restricted: true, patient: undefined, display: undefined, dosageText: undefined, note: undefined }) as never)
    expect(row).toEqual({ id: 'rr1', patientId: 'p1', patientName: undefined, mrn: undefined, drug: undefined, directions: undefined, note: undefined, requestedAt: '2026-11-19T17:30:00Z', restricted: true })
  })

  it('names the patient and the drug otherwise', () => {
    expect(toRow(item({}) as never)).toMatchObject({ patientName: 'Example Patient', mrn: 'RFM-000099', drug: 'omeprazole 20 MG Delayed Release Oral Capsule' })
  })

  it('reads a refused, limited or failed list as its own problem', () => {
    expect(listProblem(problem(403, 'permission-denied'))).toBe('forbidden')
    expect(listProblem(problem(429, 'rate-limited'))).toBe('rate-limited')
    expect(listProblem(problem(500, 'internal-error'))).toBe('error')
    expect(listProblem(new Error('offline'))).toBe('error')
  })
})

describe('the decisions', () => {
  it('approves with the decision only and the given Idempotency-Key, and returns the draft', async () => {
    const out = await respondToRefill('rr1', { approve: true }, '11111111-1111-4111-8111-111111111111')
    expect(out).toEqual({ kind: 'done', newPrescriptionId: 'rx-new' })
    expect(calls.respond).toEqual([['rr1', { decision: 'approve' }, { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' }]])
  })

  it('declines with a reason code, never free text', async () => {
    await respondToRefill('rr1', { decline: 'needs-visit' }, '22222222-2222-4222-8222-222222222222')
    expect(calls.respond[0]).toEqual(['rr1', { decision: 'decline', reason: 'needs-visit' }, { 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' }])
  })

  it.each([
    [problem(403, 'break-glass-required'), 'restricted'],
    [problem(403, 'permission-denied'), 'forbidden'],
    [problem(404, 'not-found'), 'not-found'],
    [problem(409, 'invalid-state-transition'), 'conflict'],
    [problem(412, 'precondition-failed'), 'stale'],
    [problem(422, 'validation-failed'), 'invalid'],
    [problem(429, 'rate-limited'), 'rate-limited'],
    [problem(500, 'internal-error'), 'error'],
    [new Error('offline'), 'error'],
  ])('reads %s as %s', async (err, kind) => {
    expect(decisionOutcome(err).kind).toBe(kind)
    respondAnswer = () => Promise.reject(err)
    expect((await respondToRefill('rr1', { approve: true }, '33333333-3333-4333-8333-333333333333')).kind).toBe(kind)
    respondAnswer = () => Promise.resolve({ status: 200, data: { id: 'rr1' } })
  })
})
