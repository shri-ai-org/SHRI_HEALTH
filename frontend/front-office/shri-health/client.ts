// SHRI_HEALTH data layer: the API helpers care-entry's screens import, over SHRI_HEALTH's own
// client (CSRF, Idempotency-Key, If-Match, Problem errors). Errors are worded by their Problem
// code (problemCopy), never by the server's title.
import { ApiError } from '../../src/api/client'
import { problemCopy } from '../../src/design-system/problem/problem'

export { ApiError, newIdempotencyKey } from '../../src/api/client'

/** Plain words for a refusal, for the toasts and alerts the screens already have. */
export function problemMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error)
  if (error.networkError) return 'The server did not answer. Check the connection and try again.'
  const ref = error.problem.requestId ? ` (reference ${error.problem.requestId})` : ''
  return `${problemCopy(error.problem).message}${ref}`
}
