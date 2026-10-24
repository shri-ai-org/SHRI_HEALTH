/**
 * Problem Details from the API (RFC 9457, API_STANDARDS §9). Screens switch on `code`, never on
 * `title` or `detail`. The code list mirrors contracts/openapi/components/schemas/ProblemCode.yaml;
 * new codes may arrive at any time, so unknown codes get a safe generic message.
 */

export const PROBLEM_CODES = [
  'malformed-request',
  'invalid-cursor',
  'idempotency-key-missing',
  'unauthenticated',
  'session-expired',
  'permission-denied',
  'csrf-check-failed',
  'break-glass-required',
  'not-found',
  'method-not-allowed',
  'not-acceptable',
  'invalid-state-transition',
  'record-locked',
  'booking-conflict',
  'possible-duplicate',
  'patient-merged',
  'idempotency-request-in-progress',
  'feature-disabled',
  'consent-required',
  'gone',
  'precondition-failed',
  'payload-too-large',
  'unsupported-media-type',
  'validation-failed',
  'business-rule-violation',
  'idempotency-key-reused',
  'file-not-ready',
  'precondition-required',
  'rate-limited',
  'internal-error',
  'upstream-error',
  'service-unavailable',
  'upstream-timeout',
  'ai-unavailable',
  'ai-output-rejected',
  'partner-rejected',
  'partner-timeout',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]

export interface FieldError {
  in: 'body' | 'query' | 'path' | 'header'
  pointer?: string
  name?: string
  code: string
}

/** The Problem object; `code` is a string because the server may add codes later. */
export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code: string
  requestId?: string
  errors?: FieldError[]
  [extension: string]: unknown
}

export type Tone = 'info' | 'warning' | 'critical'

/**
 * What the screen does with the error. Most codes are messages; some open a dedicated flow that
 * the screen must handle (break-glass dialog, record-changed view, sign-in, duplicate review).
 */
export type ProblemAction =
  | 'show-message'
  | 'sign-in'
  | 'break-glass'
  | 'record-changed'
  | 'review-duplicates'
  | 'open-merged-record'
  | 'fix-fields'
  | 'retry-later'

export interface ProblemCopy {
  title: string
  message: string
  tone: Tone
  action: ProblemAction
}

const COPY: Record<ProblemCode, ProblemCopy> = {
  'malformed-request': { title: 'Request not understood', message: 'Something went wrong sending this. Try again; if it keeps happening, contact support with the reference below.', tone: 'critical', action: 'show-message' },
  'invalid-cursor': { title: 'List out of date', message: 'This list changed or expired. Reload it to see the latest.', tone: 'warning', action: 'show-message' },
  'idempotency-key-missing': { title: 'Request not sent', message: 'Something went wrong sending this. Try again.', tone: 'critical', action: 'show-message' },
  unauthenticated: { title: 'Sign in required', message: 'Your session has ended. Sign in again to continue.', tone: 'warning', action: 'sign-in' },
  'session-expired': { title: 'Session expired', message: 'You were signed out after a period of inactivity. Sign in again to continue.', tone: 'warning', action: 'sign-in' },
  'permission-denied': { title: 'Not available for your role', message: "Your role doesn't include this action. Ask your practice administrator if you need it.", tone: 'warning', action: 'show-message' },
  'csrf-check-failed': { title: 'Security check failed', message: 'Reload the page and try again.', tone: 'critical', action: 'show-message' },
  'break-glass-required': { title: 'Restricted chart', message: 'This chart is restricted. You can open it by giving a reason; the access is recorded and reviewed.', tone: 'warning', action: 'break-glass' },
  'not-found': { title: 'Not found', message: "We couldn't find this record. It may have been removed or you may not have access to it.", tone: 'warning', action: 'show-message' },
  'method-not-allowed': { title: 'Action not available', message: "This action isn't available here.", tone: 'critical', action: 'show-message' },
  'not-acceptable': { title: 'Action not available', message: "This action isn't available here.", tone: 'critical', action: 'show-message' },
  'invalid-state-transition': { title: "Can't do that right now", message: "This record's status doesn't allow that action. Reload to see its current status.", tone: 'warning', action: 'show-message' },
  'record-locked': { title: 'Record is signed', message: 'Signed records cannot be edited. Add an addendum instead.', tone: 'info', action: 'show-message' },
  'booking-conflict': { title: 'Time no longer available', message: 'That time was just booked or overlaps another appointment. Choose another time.', tone: 'warning', action: 'show-message' },
  'possible-duplicate': { title: 'Possible duplicate patient', message: 'This patient may already be registered. Review the matches before creating a new record.', tone: 'warning', action: 'review-duplicates' },
  'patient-merged': { title: 'Patient record merged', message: 'This record was merged into another one. Open the current record to continue.', tone: 'info', action: 'open-merged-record' },
  'idempotency-request-in-progress': { title: 'Still working', message: 'Your earlier request is still being processed. Wait a moment before trying again.', tone: 'info', action: 'retry-later' },
  'feature-disabled': { title: 'Feature turned off', message: 'This feature is turned off for your practice.', tone: 'info', action: 'show-message' },
  'consent-required': { title: 'Consent needed', message: "The patient's consent is needed before this can be done. Record the consent first.", tone: 'warning', action: 'show-message' },
  gone: { title: 'No longer available', message: 'This feature has been retired. Reload the page.', tone: 'warning', action: 'show-message' },
  'precondition-failed': { title: 'Record changed', message: 'Someone else changed this record while you were working. Review the latest version before saving.', tone: 'warning', action: 'record-changed' },
  'payload-too-large': { title: 'File too large', message: 'This file is larger than allowed. Choose a smaller file.', tone: 'warning', action: 'show-message' },
  'unsupported-media-type': { title: 'File type not supported', message: "This file type isn't accepted here.", tone: 'warning', action: 'show-message' },
  'validation-failed': { title: 'Check the highlighted fields', message: 'Some information is missing or not in the right format.', tone: 'critical', action: 'fix-fields' },
  'business-rule-violation': { title: "Can't save this", message: 'Some information conflicts with practice rules. Check the highlighted fields.', tone: 'critical', action: 'fix-fields' },
  'idempotency-key-reused': { title: 'Request not sent', message: 'Something went wrong sending this. Start the action again.', tone: 'critical', action: 'show-message' },
  'file-not-ready': { title: 'File not ready', message: 'The file is still being checked or could not be used. Wait a moment, or upload it again.', tone: 'warning', action: 'retry-later' },
  'precondition-required': { title: 'Reload needed', message: 'Reload this record before saving changes.', tone: 'warning', action: 'record-changed' },
  'rate-limited': { title: 'Too many requests', message: 'Please wait a moment and try again.', tone: 'warning', action: 'retry-later' },
  'internal-error': { title: 'Something went wrong', message: 'An unexpected error occurred. Try again; if it keeps happening, contact support with the reference below.', tone: 'critical', action: 'retry-later' },
  'upstream-error': { title: 'Partner service problem', message: 'An outside service returned an error. Try again later.', tone: 'critical', action: 'retry-later' },
  'service-unavailable': { title: 'Temporarily unavailable', message: 'The system is busy or under maintenance. Try again in a few minutes.', tone: 'warning', action: 'retry-later' },
  'upstream-timeout': { title: 'Partner service not responding', message: "An outside service didn't respond in time. Try again later.", tone: 'warning', action: 'retry-later' },
  'ai-unavailable': { title: 'AI assistant unavailable', message: "The AI assistant isn't available right now. You can continue without it.", tone: 'info', action: 'show-message' },
  'ai-output-rejected': { title: 'AI draft not usable', message: "The AI draft didn't pass safety checks and wasn't shown. Continue without it.", tone: 'info', action: 'show-message' },
  'partner-rejected': { title: 'Rejected by partner', message: 'The receiving partner rejected this. Review the details and try again.', tone: 'critical', action: 'show-message' },
  'partner-timeout': { title: 'Partner not responding', message: "The receiving partner didn't respond in time. Try again later.", tone: 'warning', action: 'retry-later' },
}

const UNKNOWN: ProblemCopy = {
  title: 'Something went wrong',
  message: 'Try again; if it keeps happening, contact support with the reference below.',
  tone: 'critical',
  action: 'show-message',
}

export function isKnownProblemCode(code: string): code is ProblemCode {
  return (PROBLEM_CODES as readonly string[]).includes(code)
}

/** Screen copy for a Problem. Never uses the server's text, which may change. */
export function problemCopy(problem: Pick<Problem, 'code'>): ProblemCopy {
  return isKnownProblemCode(problem.code) ? COPY[problem.code] : UNKNOWN
}

/** Narrows an unknown thrown value or response body to a Problem. */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.code === 'string' && typeof v.status === 'number' && typeof v.title === 'string'
}

/** Field error → the form field it belongs to: a JSON pointer `/address/postalCode` or a parameter name. */
export function fieldKey(error: FieldError): string {
  return error.pointer ?? error.name ?? ''
}

const FIELD_MESSAGES: Record<string, string> = {
  required: 'This is required.',
  'unknown-field': 'This field is not accepted.',
  'invalid-format': 'This is not in the right format.',
  'invalid-type': 'This is not the right kind of value.',
  'too-short': 'This is too short.',
  'too-long': 'This is too long.',
  'out-of-range': 'This value is out of range.',
  'not-allowed-value': 'Choose one of the listed options.',
  'invalid-reference': "This refers to a record that isn't available here.",
  'conflicting-fields': 'This conflicts with another field.',
  'not-editable': 'This can no longer be changed.',
}

/** Message for one field error code (API_STANDARDS §9.2); the submitted value is never echoed. */
export function fieldErrorMessage(code: string): string {
  return FIELD_MESSAGES[code] ?? 'Check this field.'
}
