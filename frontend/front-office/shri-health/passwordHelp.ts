// SHRI_HEALTH: "Forgot password?" for staff (#85, Vimal's settled design of 18 Nov). A staff member
// asks the administrator for a reset at /password-help; demo.admin approves or declines in the
// admin area, and on approval Keycloak itself emails the reset link. These screens never see or
// handle a password or a reset link (D3).
//
// The status page is reached with an opaque status token the request returns once. The token lives
// in the URL fragment only on arrival: it is read, the fragment is removed with replaceState, and it
// is kept in this tab's sessionStorage (so a reload still works) and sent back only in a request
// body, never in a query string, a log or the browser history.
//
// The contract isn't on main yet (Thulasi, due Mon 23 Nov), so nothing here calls the API: the
// screens take these view models and handlers, and they are wired once the generated client has
// the operations.

/** On demo servers only (SHRI_DEMO): the build sets VITE_FEATURE_PASSWORD_HELP=on (#85, point 3). */
export function passwordHelpOn(env: Record<string, unknown> = import.meta.env): boolean {
  return env.VITE_FEATURE_PASSWORD_HELP === 'on'
}

/** Where the pages live, under the app's base path. */
export const PASSWORD_HELP_PATH = '/password-help'
export const PASSWORD_HELP_STATUS_PATH = '/password-help/status'

/** What sending a request came to. `accepted` is the one answer whether or not the account exists. */
export type RequestOutcome =
  | { kind: 'accepted'; statusToken: string }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

/** The request form's state. */
export type RequestFormState =
  | { kind: 'editing' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

/**
 * The form's answer to an outcome. Only the three problems get their own words; every other answer
 * (accepted, or anything the server might call "created", "already open", "no such account" or
 * something new) gets the one "Request sent" answer, so nothing on the page tells whether an
 * account exists.
 */
export function requestAnswer(outcome: { kind: string }): Exclude<RequestFormState['kind'], 'editing' | 'sending'> {
  return outcome.kind === 'rate-limited' || outcome.kind === 'unavailable' || outcome.kind === 'error' ? outcome.kind : 'sent'
}

/** A request's status, as the server reports it. */
export type ResetStatus = 'waiting' | 'approved' | 'declined' | 'expired' | 'unavailable'

/** Statuses after which the request is over, so this tab forgets its token. */
export const FINAL_STATUSES: readonly ResetStatus[] = ['approved', 'declined', 'expired', 'unavailable']

/** The status page's state. `no-token`: opened without a token (a new tab, or the tab's storage cleared). */
export type StatusViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: ResetStatus; requestedAt?: Date; expiresAt?: Date; note?: string }
  | { kind: 'no-token' }
  | { kind: 'rate-limited' }
  | { kind: 'error' }

/** The two calls the screens need, passed in so the screens never call the API themselves. */
export interface PasswordHelpHandlers {
  /** Sends the username in the request body. */
  requestReset(username: string): Promise<RequestOutcome>
  /** Sends the status token in the request body. */
  readStatus(statusToken: string): Promise<Exclude<StatusViewState, { kind: 'loading' } | { kind: 'no-token' }>>
}

const STORAGE_KEY = 'shri.passwordHelp.statusToken'
const FRAGMENT_KEY = 'status'

interface TokenPlace {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>
  history: Pick<History, 'replaceState' | 'state'>
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

function browser(): TokenPlace {
  let storage: TokenPlace['storage'] = null
  try {
    storage = window.sessionStorage
  } catch {
    storage = null
  }
  return { location: window.location, history: window.history, storage }
}

/** An opaque token: URL-safe characters only, and long enough to be one. Anything else is ignored. */
function plausible(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(token)
}

/**
 * The status token on arrival: from the fragment (#status=…) if there is one, which is then removed
 * from the address bar and history entry at once; otherwise the one kept for this tab.
 */
export function takeStatusToken(place: TokenPlace = browser()): string | null {
  const fragment = new URLSearchParams(place.location.hash.replace(/^#/, ''))
  const fromFragment = fragment.get(FRAGMENT_KEY)
  if (place.location.hash) {
    // The address keeps its path and query, never the fragment.
    place.history.replaceState(place.history.state, '', place.location.pathname + place.location.search)
  }
  if (plausible(fromFragment)) {
    keepStatusToken(fromFragment, place)
    return fromFragment
  }
  try {
    const kept = place.storage?.getItem(STORAGE_KEY)
    return plausible(kept) ? kept : null
  } catch {
    return null
  }
}

/** Keeps the token for this tab only, so the status page survives a reload. */
export function keepStatusToken(token: string, place: Pick<TokenPlace, 'storage'> = browser()): void {
  try {
    place.storage?.setItem(STORAGE_KEY, token)
  } catch {
    // Storage blocked: the token stays in memory for this page only.
  }
}

/** Forgets the token (a new request, or the request has ended). */
export function forgetStatusToken(place: Pick<TokenPlace, 'storage'> = browser()): void {
  try {
    place.storage?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing kept.
  }
}

/**
 * The handlers until the contract is on main: every call answers "unavailable", so a real build
 * never shows made-up results. (The pages are off in real builds unless the flag is on.)
 */
export const notYetConnected: PasswordHelpHandlers = {
  requestReset: () => Promise.resolve({ kind: 'unavailable' }),
  readStatus: () => Promise.resolve({ kind: 'ready', status: 'unavailable' }),
}
