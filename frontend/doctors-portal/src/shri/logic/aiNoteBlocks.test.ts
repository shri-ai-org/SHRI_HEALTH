import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../../../src/api/client'
import {
  createCodingSuggestion,
  createVisitSummary,
  decideSuggestedCode,
  getCodingSuggestion,
  getVisitSummary,
} from '../../../../src/api/generated/endpoints/ai/ai'
import { getOperation } from '../../../../src/api/generated/endpoints/platform/platform'
import type { CodingSuggestion, SuggestedCode, VisitSummary } from '../../../../src/api/generated/model'
import {
  REASON_MAX,
  SUMMARY_TEXT_MAX,
  choiceProblem,
  decideCode,
  decideSummaryInOrder,
  decisionFailure,
  isPending,
  requestCodingSuggestion,
  requestVisitSummary,
  summaryDecisionBody,
  summaryText,
  visibleCodes,
  withCode,
  type SummaryDecisionSteps,
} from './aiNoteBlocks'

vi.mock('../../../../src/api/generated/endpoints/ai/ai', () => ({
  createVisitSummary: vi.fn(),
  getVisitSummary: vi.fn(),
  createCodingSuggestion: vi.fn(),
  getCodingSuggestion: vi.fn(),
  decideSuggestedCode: vi.fn(),
}))
vi.mock('../../../../src/api/generated/endpoints/platform/platform', () => ({ getOperation: vi.fn() }))

// Synthetic IDs and text only.
const ENC = '7a1c0d52-1f0e-4c7e-9a3b-2d4e5f6a7b8c'
const NOTE = '3b9d2f10-6c4a-4e8b-8f1d-0a2b3c4d5e6f'
const SUMMARY_ID = 'c4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'
const problem = (status: number, code: string) => new ApiError({ type: 'about:blank', title: code, status, code, requestId: 'r' } as never)
const op = (status: string, result?: string, detail?: string) => ({
  id: 'op-1',
  kind: 'ai.visit-summary',
  status,
  ...(result ? { result: { id: result } } : {}),
  ...(detail ? { error: { detail } } : {}),
})

const summary = (over: Partial<VisitSummary> = {}): VisitSummary =>
  ({
    id: SUMMARY_ID,
    patientId: 'p-1',
    encounterId: ENC,
    statements: [
      { sequence: 2, text: 'Blood pressure was 128/82 at this visit.', sources: [{ resourceType: 'Observation', resourceId: 'o-1' }] },
      { sequence: 1, text: 'Seen for lower back pain, two weeks.', sources: [{ resourceType: 'Encounter', resourceId: ENC }] },
    ],
    insufficientEvidence: false,
    aiGenerated: true,
    generatedBy: { modelName: 'stub', promptVersion: '1' },
    createdAt: '2026-11-20T17:00:00Z',
    decision: 'pending',
    ...over,
  }) as VisitSummary

const code = (id: string, over: Partial<SuggestedCode> = {}): SuggestedCode =>
  ({
    id,
    sequence: Number(id.slice(-1)),
    system: 'http://hl7.org/fhir/sid/icd-10-cm',
    code: 'M54.50',
    display: 'Low back pain, unspecified',
    rationale: 'The visit is for lower back pain.',
    confidence: 'medium',
    sources: [],
    decision: 'pending',
    ...over,
  }) as SuggestedCode

beforeEach(() => vi.clearAllMocks())

describe('the visit summary read', () => {
  afterEach(() => vi.useRealTimers())

  it('shows the summary once the operation finishes (pending, then ready)', async () => {
    vi.useFakeTimers()
    vi.mocked(createVisitSummary).mockResolvedValue({ status: 202, data: op('running') } as never)
    vi.mocked(getOperation).mockResolvedValue({ status: 200, data: op('succeeded', SUMMARY_ID) } as never)
    vi.mocked(getVisitSummary).mockResolvedValue({ status: 200, data: summary() } as never)
    const read = requestVisitSummary(ENC, 'key-1')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(read).resolves.toEqual({ kind: 'ready', value: summary() })
    expect(createVisitSummary).toHaveBeenCalledWith({ encounterId: ENC }, { 'Idempotency-Key': 'key-1' })
    expect(getVisitSummary).toHaveBeenCalledWith(SUMMARY_ID)
  })

  it('AI turned off (409 feature-disabled) is "off", never an error', async () => {
    vi.mocked(createVisitSummary).mockRejectedValue(problem(409, 'feature-disabled'))
    await expect(requestVisitSummary(ENC, 'k')).resolves.toEqual({ kind: 'off' })
  })

  it('a failed operation (ai-unavailable, ai-output-rejected) is "failed", so the block offers Try again', async () => {
    vi.mocked(createVisitSummary).mockResolvedValue({ status: 202, data: op('failed', undefined, 'The AI assistant is unavailable.') } as never)
    await expect(requestVisitSummary(ENC, 'k')).resolves.toEqual({ kind: 'failed' })
    expect(getVisitSummary).not.toHaveBeenCalled()
  })

  it('a restricted chart (403 break-glass-required) goes to the Restricted chart card', async () => {
    vi.mocked(createVisitSummary).mockRejectedValue(problem(403, 'break-glass-required'))
    await expect(requestVisitSummary(ENC, 'k')).resolves.toMatchObject({ kind: 'restricted' })
  })

  it('puts the statements in order as the note text, and knows a decided summary', () => {
    expect(summaryText(summary())).toBe('Seen for lower back pain, two weeks. Blood pressure was 128/82 at this visit.')
    expect(isPending(summary())).toBe(true)
    expect(isPending(summary({ decision: undefined }))).toBe(true)
    expect(isPending(summary({ decision: 'accepted' }))).toBe(false)
  })
})

describe('deciding the visit summary: the call order', () => {
  function steps(log: string[], over: Partial<SummaryDecisionSteps> = {}): SummaryDecisionSteps {
    return {
      savePending: vi.fn(async () => {
        log.push('save')
        return NOTE
      }),
      decide: vi.fn(async (body) => {
        log.push(`decide:${JSON.stringify(body)}`)
        return summary({ decision: body.decision })
      }),
      rereadNote: vi.fn(async () => {
        log.push('reread')
      }),
      ...over,
    }
  }

  it('accept: saves the note first (If-Match), decides with the note, then reads the note again', async () => {
    const log: string[] = []
    const out = await decideSummaryInOrder({ decision: 'accepted' }, steps(log))
    expect(log).toEqual(['save', `decide:${JSON.stringify({ decision: 'accepted', noteId: NOTE })}`, 'reread'])
    expect(out.decision).toBe('accepted')
  })

  it('edit: sends the clinician’s own text with the note, then reads the note again', async () => {
    const log: string[] = []
    await decideSummaryInOrder({ decision: 'edited', text: '  Low back pain, improving.  ' }, steps(log))
    expect(log).toEqual(['save', `decide:${JSON.stringify({ decision: 'edited', noteId: NOTE, text: 'Low back pain, improving.' })}`, 'reread'])
  })

  it('reject: only decides, with a reason and no note; nothing is saved or read again', async () => {
    const log: string[] = []
    const s = steps(log)
    await decideSummaryInOrder({ decision: 'rejected', reason: 'Clinically incorrect' }, s)
    expect(log).toEqual([`decide:${JSON.stringify({ decision: 'rejected', reason: 'Clinically incorrect' })}`])
    expect(s.savePending).not.toHaveBeenCalled()
    expect(s.rereadNote).not.toHaveBeenCalled()
  })

  it('a 412 on the save stops before the decision (the store shows the saved note)', async () => {
    const log: string[] = []
    const s = steps(log, { savePending: vi.fn().mockRejectedValue(problem(412, 'precondition-failed')) })
    await expect(decideSummaryInOrder({ decision: 'accepted' }, s)).rejects.toBeInstanceOf(ApiError)
    expect(s.decide).not.toHaveBeenCalled()
    expect(s.rereadNote).not.toHaveBeenCalled()
  })

  it('a refused decision is not followed by a re-read', async () => {
    const log: string[] = []
    const s = steps(log, { decide: vi.fn().mockRejectedValue(problem(409, 'record-locked')) })
    await expect(decideSummaryInOrder({ decision: 'accepted' }, s)).rejects.toBeInstanceOf(ApiError)
    expect(s.rereadNote).not.toHaveBeenCalled()
  })

  it('keeps to the contract’s limits: text 1 to 4,000 characters, reason 1 to 500', async () => {
    expect(choiceProblem({ decision: 'edited', text: '   ' })).toMatch(/Write the summary/)
    expect(choiceProblem({ decision: 'edited', text: 'x'.repeat(SUMMARY_TEXT_MAX + 1) })).toMatch(/4,000/)
    expect(choiceProblem({ decision: 'edited', text: 'x'.repeat(SUMMARY_TEXT_MAX) })).toBeNull()
    expect(choiceProblem({ decision: 'rejected', reason: '' })).toMatch(/reason/)
    expect(choiceProblem({ decision: 'rejected', reason: 'x'.repeat(REASON_MAX + 1) })).toMatch(/500/)
    const log: string[] = []
    const s = steps(log)
    await expect(decideSummaryInOrder({ decision: 'rejected', reason: ' ' }, s)).rejects.toThrow(/reason/)
    expect(s.decide).not.toHaveBeenCalled()
    expect(() => summaryDecisionBody({ decision: 'accepted' })).toThrow(/note must be saved/)
  })

  it('says what a refusal means: 412, 409 record-locked, 409 invalid-state-transition', () => {
    expect(decisionFailure(problem(412, 'precondition-failed')).kind).toBe('changed-elsewhere')
    expect(decisionFailure(problem(409, 'record-locked'))).toMatchObject({ kind: 'signed', message: expect.stringMatching(/already signed/) })
    expect(decisionFailure(problem(409, 'invalid-state-transition'))).toMatchObject({ kind: 'already-decided', message: expect.stringMatching(/already decided/) })
    expect(decisionFailure(problem(409, 'feature-disabled')).kind).toBe('off')
    expect(decisionFailure(problem(403, 'break-glass-required')).kind).toBe('restricted')
  })
})

describe('the ICD-10-CM chips', () => {
  const suggestion = (codes: SuggestedCode[]): CodingSuggestion =>
    ({ id: 'cs-1', patientId: 'p-1', encounterId: ENC, codes, insufficientEvidence: false, aiGenerated: true, generatedBy: { modelName: 'stub', promptVersion: '1' }, createdAt: '2026-11-20T17:00:00Z' }) as unknown as CodingSuggestion

  it('none is accepted by default: every new code is pending, shown with Accept and Reject', async () => {
    vi.mocked(createCodingSuggestion).mockResolvedValue({ status: 202, data: op('succeeded', 'cs-1') } as never)
    vi.mocked(getCodingSuggestion).mockResolvedValue({ status: 200, data: suggestion([code('c-2'), code('c-1')]) } as never)
    const r = await requestCodingSuggestion(ENC, 'k')
    expect(r.kind).toBe('ready')
    if (r.kind !== 'ready') return
    expect(visibleCodes(r.value).map((c) => [c.id, c.decision])).toEqual([
      ['c-1', 'pending'],
      ['c-2', 'pending'],
    ])
    expect(decideSuggestedCode).not.toHaveBeenCalled()
  })

  it('accept sends the decision with its Idempotency-Key, and the chip shows it accepted', async () => {
    vi.mocked(decideSuggestedCode).mockResolvedValue({ status: 200, data: code('c-1', { decision: 'accepted', diagnosisId: 'd-1' }) } as never)
    const decided = await decideCode('cs-1', 'c-1', { decision: 'accepted' }, 'key-a')
    expect(decideSuggestedCode).toHaveBeenCalledWith('cs-1', 'c-1', { decision: 'accepted' }, { 'Idempotency-Key': 'key-a' })
    expect(withCode(suggestion([code('c-1'), code('c-2')]), decided).codes.map((c) => c.decision)).toEqual(['accepted', 'pending'])
  })

  it('reject needs a reason; the rejected chip is removed and its decision kept', async () => {
    await expect(decideCode('cs-1', 'c-1', { decision: 'rejected', reason: ' ' }, 'k')).rejects.toThrow(/reason/)
    expect(decideSuggestedCode).not.toHaveBeenCalled()
    vi.mocked(decideSuggestedCode).mockResolvedValue({ status: 200, data: code('c-1', { decision: 'rejected', rejectionReason: 'Not relevant to this patient' }) } as never)
    const decided = await decideCode('cs-1', 'c-1', { decision: 'rejected', reason: 'Not relevant to this patient' }, 'key-r')
    expect(decideSuggestedCode).toHaveBeenCalledWith('cs-1', 'c-1', { decision: 'rejected', reason: 'Not relevant to this patient' }, { 'Idempotency-Key': 'key-r' })
    const after = withCode(suggestion([code('c-1'), code('c-2')]), decided)
    expect(visibleCodes(after).map((c) => c.id)).toEqual(['c-2'])
    expect(after.codes.find((c) => c.id === 'c-1')?.decision).toBe('rejected')
  })
})
