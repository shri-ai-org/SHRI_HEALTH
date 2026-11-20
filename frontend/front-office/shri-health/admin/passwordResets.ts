// SHRI_HEALTH: the administrator's password-reset approvals (#85, Vimal's settled design of 18 Nov):
// pending "Forgot password?" requests from staff and patients, each approved (the sign-in service
// then emails its own reset link) or declined with an optional note. Permission
// password-resets:approve (ADM only). These screens never see a password or a reset link (D3).
//
// The contract isn't on main yet (Thulasi's core, Vimal's contract), so nothing here calls the API:
// the page takes these view models and handlers, and is wired once the generated client has the
// operations.
import { passwordHelpOn } from '../passwordHelp'

/** One pending request, as the approval screen shows it. The server masks the mobile number. */
export interface ResetRequestRow {
  id: string
  /** The opaque version for If-Match (412 when it changed). */
  version: string
  displayName: string
  /** Staff: the role, e.g. "Physician (MD)"; patients: "Patient". */
  role: string
  realm: 'staff' | 'patients'
  username?: string
  /** The last four digits only (patients who asked by mobile number). */
  mobileLast4?: string
  requestedAt: string
  expiresAt: string
}

export type ListOutcome = { kind: 'ok'; items: ResetRequestRow[] } | { kind: 'forbidden' } | { kind: 'rate-limited' } | { kind: 'error' }

/** A decision's outcome, one per answer the screen must handle. */
export type DecisionOutcome =
  | { kind: 'done' }
  | { kind: 'forbidden' } // 403
  | { kind: 'not-found' } // 404
  | { kind: 'conflict' } // 409: already decided, or expired
  | { kind: 'stale' } // 412: changed since the list was read
  | { kind: 'invalid'; message?: string } // 422: the note can't be used
  | { kind: 'rate-limited' } // 429
  | { kind: 'error' }

export interface PasswordResetHandlers {
  list(): Promise<ListOutcome>
  approve(row: ResetRequestRow): Promise<DecisionOutcome>
  decline(row: ResetRequestRow, note: string | undefined): Promise<DecisionOutcome>
}

/** The section's permission (the contract's x-permission once it exists). */
export const APPROVE_PERMISSION = 'password-resets:approve'

/**
 * Development server only, never a production build: VITE_PASSWORD_HELP_PREVIEW=on shows the section
 * to the administrator with synthetic requests, since the real /me has no password-resets:approve
 * until core serves it.
 */
export function devPreviewOn(env: Record<string, unknown> = import.meta.env): boolean {
  return env.DEV === true && env.VITE_PASSWORD_HELP_PREVIEW === 'on'
}

/** Whether the administrator sees the section: the switch is on, and they hold the permission (or the dev preview is on). */
export function showPasswordResets(permissions: ReadonlySet<string>, env: Record<string, unknown> = import.meta.env): boolean {
  return passwordHelpOn(env) && (permissions.has(APPROVE_PERMISSION) || devPreviewOn(env))
}

/** "•••-•••-0142" (screen readers get "ending in 0142" from the page), or a dash when there is none. */
export function maskedMobile(last4: string | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `•••-•••-${last4}` : '—'
}

/** What the screen says after a decision that didn't go through, and whether the list is read again. */
export function decisionProblem(outcome: Exclude<DecisionOutcome, { kind: 'done' }>): { text: string; reload: boolean } {
  switch (outcome.kind) {
    case 'forbidden':
      return { text: "Your account can't approve or decline password resets.", reload: false }
    case 'not-found':
      return { text: 'That request no longer exists. The list has been updated.', reload: true }
    case 'conflict':
      return { text: 'That request was already decided or has expired. The list has been updated.', reload: true }
    case 'stale':
      return { text: 'That request changed after the list was read. The list has been updated; check it and try again.', reload: true }
    case 'invalid':
      return { text: outcome.message ?? "That note can't be used. Shorten it and try again.", reload: false }
    case 'rate-limited':
      return { text: 'Too many actions. Wait a few minutes, then try again.', reload: false }
    case 'error':
      return { text: "Couldn't save the decision. Check your connection, then try again.", reload: false }
  }
}

/** Until the contract is on main: the list can't be read, and no decision is made up. */
export const notYetConnected: PasswordResetHandlers = {
  list: () => Promise.resolve({ kind: 'error' }),
  approve: () => Promise.resolve({ kind: 'error' }),
  decline: () => Promise.resolve({ kind: 'error' }),
}
