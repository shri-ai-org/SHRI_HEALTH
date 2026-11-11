// ported from src/screens/m18/S1801.tsx:48-62 (`ringLabel`, WALL_RINGS),
// S1802.tsx:31-40 and S1809.tsx:96-102 (the paging counts), and the
// `strokeCase(id ?? '0141')` line every m18 case screen opens with — what
// the stroke screens share about one case.
//
// The narrowing the old screens did not make: the kit's per-case detail — the
// event stream (interval clocks, task board, paging log, timestamp
// conflicts), the NIHSS items as scored, the telestroke transcript, the
// thrombolysis and EVT checklists, the transfer reservation — was recorded
// for ONE case, the index case (STROKE/26-27/0141, a left M1 occlusion). The
// old screens drew it on whatever case was open, so 0142's card wore 0141's
// rings and a haemorrhage could read "ICH NO" and offer tenecteplase. Here it
// is read only for the case it belongs to (`isIndexCase`); another case says
// it has none recorded. An unknown case id says so instead of throwing, and a
// missing one no longer silently becomes 0141.

import { useParams } from 'react-router-dom'

import { ACTIVE_CASE, PAGING_LOG, maybeStrokeCase, type StrokeCase, type StrokeTask } from '@/data/stroke'
import { minutesBetween } from '@/store/stroke'

/** The rings the wall draws on a case card, in this order. */
export const WALL_RINGS = ['d2ct', 'dtn', 'dido', 'groin']

/** The short name a ring wears on the wall — readable at 3–4 m. */
export function ringLabel(key: string): string {
  switch (key) {
    case 'd2ct':
      return 'D2CT'
    case 'dtn':
      return 'DTN'
    case 'dido':
      return 'DIDO'
    case 'groin':
      return 'GROIN'
    default:
      return key.toUpperCase()
  }
}

/** Whether the kit's per-case detail — the event stream, the checklists, the transcript, the reservation — is this case's own. */
export const isIndexCase = (c: StrokeCase) => c.id === ACTIVE_CASE.id

/** "active", "closed" or "stood down", as the case cards say it. */
export const caseStatusWord = (c: StrokeCase) => (c.status === 'active' ? 'case active' : c.status === 'closed' ? 'case closed' : 'stood down')

/** The case an address names — `/stroke/case/:id/…` — or undefined for an id with no case behind it. */
export function useStrokeCaseParam(): { id: string | undefined; strokeCase: StrokeCase | undefined } {
  const { id } = useParams()
  return { id, strokeCase: maybeStrokeCase(id) }
}

/**
 * Who was paged for the case, who answered, and the median time to answer.
 * The old screen called its figure the median and computed the mean; this is
 * the median (tonight both round to 4 min).
 */
export function pagingFor(c: StrokeCase) {
  const log = isIndexCase(c) ? PAGING_LOG : []
  const acked = log.filter((x) => x.ackAt)
  const unanswered = log.filter((x) => !x.ackAt)
  const waits = acked.map((x) => minutesBetween(x.pagedAt, x.ackAt!)).sort((a, b) => a - b)
  const mid = Math.floor(waits.length / 2)
  const medianAck = waits.length === 0 ? 0 : Math.round(waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2)
  return { log, acked, unanswered, medianAck }
}

/**
 * A task's prioritisation line (AI-619), without the forecast. T-07's reason
 * is AI-209's projected breach ("DIDO projected breach in 19 min"), removed
 * with every forecast (decision 8); the data keeps it, the view does not.
 */
export function taskReason(t: StrokeTask): string | undefined {
  return t.reason && !/projected|predict/i.test(t.reason) ? t.reason : undefined
}

/**
 * A site's readiness flags, without the forecast. AI-622's equipment-failure
 * prediction ("…AI-622 predicts failure risk rising") is removed (decision 8)
 * in the view; the data keeps it. AI-816's training gaps and the recorded
 * facts stay.
 */
export function readinessFlags(flags: readonly string[]): string[] {
  return flags.filter((f) => !/AI-622|predict/i.test(f))
}
