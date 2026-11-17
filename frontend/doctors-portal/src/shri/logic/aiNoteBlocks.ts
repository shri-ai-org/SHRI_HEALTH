// SHRI_HEALTH: the consultation note's two AI blocks on the API (D70, D119), item 5 of the demo plan.
// - The AI visit summary at the top of the note: createVisitSummary (202, an operation), then
//   getVisitSummary; the clinician accepts, edits or rejects it with decideVisitSummary (#406).
//   Accepted or edited puts the text at the top of the draft note's first section as a new
//   version of the note, so the note's unsaved sections are saved first (If-Match) and the note is
//   read again afterwards for its new ETag. Rejected needs a reason and changes nothing on the note.
// - The ICD-10-CM chips under the Assessment: createCodingSuggestion (202), then
//   getCodingSuggestion; each code is accepted (it becomes a visit diagnosis) or rejected with a
//   reason, one at a time, with decideSuggestedCode (#404). Nothing is accepted by default.
// Every decision carries an Idempotency-Key, one per decision, so a retry after a network error
// reuses it. A refusal comes back as a plain outcome, never sample text: AI off (409
// feature-disabled), AI unavailable (ai-unavailable, ai-output-rejected), a restricted chart
// (403 break-glass-required, the route's sealed card) or the problem's own words.
// What was asked for is remembered per visit in this tab (IDs only), as there is no list read.

import { ApiError } from '../../../../src/api/client'
import {
  createCodingSuggestion,
  createVisitSummary,
  decideSuggestedCode,
  getCodingSuggestion,
  getVisitSummary,
} from '../../../../src/api/generated/endpoints/ai/ai'
import type { CodingSuggestion, Operation, SuggestedCode, SuggestedCodeDecision, VisitSummary, VisitSummaryDecision } from '../../../../src/api/generated/model'
import { problemCopy } from '../../../../src/design-system/problem/problem'
import { finished } from '../../../shri-health/aiChart'
import { AiFeatureDown } from '../../../shri-health/aiStatus'

/** The contract's limits on an edited summary and on a rejection's reason. */
export const SUMMARY_TEXT_MAX = 4000
export const REASON_MAX = 500

export const AI_OFF = 'AI suggestions are turned off'
export const SUMMARY_FAILED = "The AI summary couldn't be prepared. Try again."
export const CODES_FAILED = "The ICD-10 suggestions couldn't be prepared. Try again."

/** A read of an AI block: its result, or why there is none. */
export type AiRead<T> =
  | { kind: 'ready'; value: T }
  /** 409 feature-disabled: AI or the feature is off for the clinic. */
  | { kind: 'off' }
  /** ai-unavailable or ai-output-rejected (or the gateway is down): try again. */
  | { kind: 'failed' }
  /** 403 break-glass-required: the route's Restricted chart card shows instead. */
  | { kind: 'restricted'; error: ApiError }
  | { kind: 'error'; message: string }

export const isRestricted = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 403 && e.code === 'break-glass-required'

/** What a refused or failed AI read means for the block. */
export function classify<T>(error: unknown): AiRead<T> {
  if (error instanceof ApiError && error.code === 'feature-disabled') return { kind: 'off' }
  if (error instanceof AiFeatureDown || (error instanceof ApiError && (error.status === 503 || error.code === 'ai-unavailable' || error.code === 'ai-output-rejected'))) return { kind: 'failed' }
  if (isRestricted(error)) return { kind: 'restricted', error }
  return { kind: 'error', message: messageOf(error) }
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return problemCopy(error.problem).message
  return error instanceof Error ? error.message : 'Something went wrong.'
}

async function read<T>(load: () => Promise<T>): Promise<AiRead<T>> {
  try {
    return { kind: 'ready', value: await load() }
  } catch (error) {
    return classify<T>(error)
  }
}

// ---- the visit summary ----

/** Asks for a new summary of the visit and waits for it (the operation is polled while it runs). */
export function requestVisitSummary(encounterId: string, idempotencyKey: string): Promise<AiRead<VisitSummary>> {
  return read(async () => {
    const res = await createVisitSummary({ encounterId }, { 'Idempotency-Key': idempotencyKey })
    const id = await finished(res.data as Operation, 'visit summary')
    return (await getVisitSummary(id)).data as VisitSummary
  })
}

/** Reads a summary asked for earlier (after a reload, or after a 409 says it was already decided). */
export function readVisitSummary(id: string): Promise<AiRead<VisitSummary>> {
  return read(async () => (await getVisitSummary(id)).data as VisitSummary)
}

/** The summary's text as it goes in the note: its statements, in order. */
export const summaryText = (s: Pick<VisitSummary, 'statements'>): string =>
  [...s.statements]
    .sort((a, b) => a.sequence - b.sequence)
    .map((st) => st.text.trim())
    .join(' ')

/** Undecided: no decision yet, or `pending`. */
export const isPending = (s: Pick<VisitSummary, 'decision'>): boolean => s.decision === undefined || s.decision === 'pending'

export type SummaryChoice = { decision: 'accepted' } | { decision: 'edited'; text: string } | { decision: 'rejected'; reason: string }

/** Why a choice can't be sent yet, in plain words; null when it can. */
export function choiceProblem(choice: SummaryChoice): string | null {
  if (choice.decision === 'edited') {
    const t = choice.text.trim()
    if (t === '') return 'Write the summary before putting it in the note.'
    if (t.length > SUMMARY_TEXT_MAX) return `Keep the summary to ${SUMMARY_TEXT_MAX.toLocaleString('en-US')} characters or fewer.`
  }
  if (choice.decision === 'rejected') {
    const r = choice.reason.trim()
    if (r === '') return 'Give a reason for rejecting it.'
    if (r.length > REASON_MAX) return `Keep the reason to ${REASON_MAX} characters or fewer.`
  }
  return null
}

/** The body decideVisitSummary takes: noteId for accepted and edited only, text for edited, reason for rejected. */
export function summaryDecisionBody(choice: SummaryChoice, noteId?: string): VisitSummaryDecision {
  const problem = choiceProblem(choice)
  if (problem) throw new Error(problem)
  if (choice.decision === 'rejected') return { decision: 'rejected', reason: choice.reason.trim() }
  if (!noteId) throw new Error('The note must be saved before the summary can go in it.')
  return choice.decision === 'edited' ? { decision: 'edited', noteId, text: choice.text.trim() } : { decision: 'accepted', noteId }
}

/** The steps of a decision, done by the note's store in its one-at-a-time queue (shri-health/clinical.ts). */
export interface SummaryDecisionSteps {
  /** Saves the note's unsaved sections (If-Match), making the note if there is none yet; its ID. */
  savePending: () => Promise<string>
  decide: (body: VisitSummaryDecision) => Promise<VisitSummary>
  /** Reads the note again (GET /notes/{noteId}): its version, ETag and first section changed. */
  rereadNote: () => Promise<void>
}

/**
 * The call order (#406): accepted or edited saves the note first, then decides, then reads the note
 * again before any other save or Sign; rejected only decides. A failing step stops the ones after it.
 */
export async function decideSummaryInOrder(choice: SummaryChoice, steps: SummaryDecisionSteps): Promise<VisitSummary> {
  const problem = choiceProblem(choice)
  if (problem) throw new Error(problem)
  if (choice.decision === 'rejected') return steps.decide(summaryDecisionBody(choice))
  const noteId = await steps.savePending()
  const summary = await steps.decide(summaryDecisionBody(choice, noteId))
  await steps.rereadNote()
  return summary
}

export type DecisionFailure =
  /** 412: the note changed elsewhere; the store showed the saved version, so decide again. */
  | { kind: 'changed-elsewhere'; message: string }
  /** 409 record-locked: the note is signed, so the summary can't go in it. */
  | { kind: 'signed'; message: string }
  /** 409 invalid-state-transition: already decided (or the note is entered in error): read the summary again. */
  | { kind: 'already-decided'; message: string }
  | { kind: 'restricted'; error: ApiError }
  | { kind: 'off' }
  | { kind: 'error'; message: string }

export function decisionFailure(error: unknown): DecisionFailure {
  if (error instanceof ApiError) {
    if (error.status === 412) return { kind: 'changed-elsewhere', message: 'The note changed elsewhere. The saved version is shown; decide again.' }
    if (error.code === 'record-locked') return { kind: 'signed', message: 'The note is already signed, so the summary can no longer go in it.' }
    if (error.code === 'invalid-state-transition') return { kind: 'already-decided', message: 'This was already decided. Its decision is shown.' }
    if (error.code === 'feature-disabled') return { kind: 'off' }
    if (isRestricted(error)) return { kind: 'restricted', error }
  }
  return { kind: 'error', message: messageOf(error) }
}

// ---- the ICD-10-CM chips ----

export function requestCodingSuggestion(encounterId: string, idempotencyKey: string): Promise<AiRead<CodingSuggestion>> {
  return read(async () => {
    const res = await createCodingSuggestion({ encounterId }, { 'Idempotency-Key': idempotencyKey })
    const id = await finished(res.data as Operation, 'coding suggestion')
    return (await getCodingSuggestion(id)).data as CodingSuggestion
  })
}

export function readCodingSuggestion(id: string): Promise<AiRead<CodingSuggestion>> {
  return read(async () => (await getCodingSuggestion(id)).data as CodingSuggestion)
}

/** The chips shown: every code not rejected, in the model's order. A rejected one is gone (its decision is kept). */
export const visibleCodes = (s: Pick<CodingSuggestion, 'codes'>): SuggestedCode[] => s.codes.filter((c) => c.decision !== 'rejected').sort((a, b) => a.sequence - b.sequence)

export type CodeChoice = { decision: 'accepted' } | { decision: 'rejected'; reason: string }

/** One code's decision: accepted becomes a visit diagnosis; rejected needs a reason. */
export async function decideCode(codingSuggestionId: string, codeId: string, choice: CodeChoice, idempotencyKey: string): Promise<SuggestedCode> {
  const body: SuggestedCodeDecision =
    choice.decision === 'rejected' ? { decision: 'rejected', reason: requiredReason(choice.reason) } : { decision: 'accepted' }
  return (await decideSuggestedCode(codingSuggestionId, codeId, body, { 'Idempotency-Key': idempotencyKey })).data as SuggestedCode
}

function requiredReason(reason: string): string {
  const problem = choiceProblem({ decision: 'rejected', reason })
  if (problem) throw new Error(problem)
  return reason.trim()
}

/** A code with its decision applied, the others unchanged. */
export const withCode = (s: CodingSuggestion, code: SuggestedCode): CodingSuggestion => ({ ...s, codes: s.codes.map((c) => (c.id === code.id ? code : c)) })

// ---- what was asked for, per visit, in this tab (IDs only) ----

type Kind = 'visit-summary' | 'coding-suggestion'
const storageKey = (kind: Kind, encounterId: string) => `shri.ai.${kind}.${encounterId}`

export function rememberedId(kind: Kind, encounterId: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(kind, encounterId))
  } catch {
    return null
  }
}

export function remember(kind: Kind, encounterId: string, id: string): void {
  try {
    sessionStorage.setItem(storageKey(kind, encounterId), id)
  } catch {
    // Without storage, a reload asks again; nothing is lost on the server.
  }
}
