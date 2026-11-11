// SHRI_HEALTH data layer for the chart AI (D70): AI-02's chart summary (createChartSummary, then
// getChartSummary) and the assistant's chart questions (listSuggestedQuestions, createChartQuestion,
// then getChartAnswer). Each create answers 202 with its operation; the AI gateway usually runs it in
// the request, so the operation is already finished, and it is polled only when it isn't. A refused
// or failed operation (AI off, unavailable, over budget, output rejected) becomes AiFeatureDown, so
// the screen hides the feature instead of showing a broken one.
import { ApiError, newIdempotencyKey } from '../../src/api/client'
import {
  createChartQuestion,
  createChartSummary,
  getChartAnswer,
  getChartSummary,
  listSuggestedQuestions,
} from '../../src/api/generated/endpoints/ai/ai'
import { getOperation } from '../../src/api/generated/endpoints/platform/platform'
import type { ChartAnswer, ChartQuestionPageType, ChartSummary, Operation, SuggestedQuestionList } from '../../src/api/generated/model'
import { problemCopy } from '../../src/design-system/problem/problem'
import { AiFeatureDown } from './aiStatus'

const POLL_MS = 1000
const POLL_LIMIT = 60

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The finished operation's result ID, or AiFeatureDown with the operation's own words. */
async function finished(op: Operation, what: string): Promise<string> {
  let current = op
  for (let i = 0; i < POLL_LIMIT && (current.status === 'queued' || current.status === 'running'); i++) {
    await sleep(POLL_MS)
    current = (await getOperation(current.id)).data as Operation
  }
  if (current.status === 'succeeded' && current.result) return current.result.id
  throw new AiFeatureDown(current.error?.detail ?? `The ${what} is unavailable right now.`)
}

/** A 409 feature-disabled or a 503 as AiFeatureDown; anything else unchanged. */
function asDown(error: unknown): unknown {
  if (error instanceof ApiError && (error.code === 'feature-disabled' || error.status === 503)) return new AiFeatureDown(problemCopy(error.problem).message)
  return error
}

/** AI-02: a summary of the patient's chart, each statement with its sources (D70). */
export async function summarizeChart(patientId: string, encounterId?: string): Promise<ChartSummary> {
  try {
    const res = await createChartSummary({ patientId, ...(encounterId ? { encounterId } : {}) }, { 'Idempotency-Key': newIdempotencyKey() })
    const id = await finished(res.data as Operation, 'chart summary')
    return (await getChartSummary(id)).data as ChartSummary
  } catch (error) {
    throw asDown(error)
  }
}

/** The questions offered for this kind of page (the assistant's starters). */
export async function suggestedQuestions(pageType: ChartQuestionPageType): Promise<string[]> {
  try {
    return ((await listSuggestedQuestions({ pageType })).data as SuggestedQuestionList).questions
  } catch (error) {
    throw asDown(error)
  }
}

/** One question about the patient's chart; the answer cites its sources, or says the chart doesn't hold it. */
export async function askChart(question: string, pageType: ChartQuestionPageType, patientId: string, encounterId?: string): Promise<ChartAnswer> {
  try {
    const res = await createChartQuestion(
      { question, pageType, patientId, ...(encounterId ? { encounterId } : {}) },
      { 'Idempotency-Key': newIdempotencyKey() },
    )
    const id = await finished(res.data as Operation, 'chart answer')
    return (await getChartAnswer(id)).data as ChartAnswer
  } catch (error) {
    throw asDown(error)
  }
}
