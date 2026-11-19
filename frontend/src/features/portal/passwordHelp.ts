/**
 * "Forgot password?" for patients (#85; Vimal's settled design of 18 Nov and his patient decision):
 * a patient with a portal password asks the clinic for a reset at `/portal/password-help`, by
 * username or the mobile number on their record; demo.admin approves or declines, and on approval
 * the sign-in service itself emails the reset link. These pages never see or handle a password or a
 * reset link (D3).
 *
 * The status page is reached with an opaque status token the request returns once. The token is
 * read from the URL fragment on arrival, the fragment is removed with replaceState, and the token is
 * kept only in this tab's sessionStorage (so a reload works) until the request is over, and sent back
 * only in a request body: never in a query string, a log or the browser history.
 *
 * The contract isn't on main yet, so nothing here calls the API: the pages take these view models
 * and handlers, and are wired once the generated client has the operations. The front office has
 * the staff pages with the same rules (front-office/shri-health/passwordHelp.ts); each app keeps its
 * own copy, as each keeps its own components.
 */

/** Demo servers only (SHRI_DEMO): the build sets VITE_FEATURE_PASSWORD_HELP=on. Read when called, so a test can switch it. */
export const passwordHelpOn = (): boolean => import.meta.env.VITE_FEATURE_PASSWORD_HELP === 'on'

/** The pages, inside the portal (`/portal/password-help`, `/portal/password-help/status`). */
export const PASSWORD_HELP_PATH = '/password-help'
export const PASSWORD_HELP_STATUS_PATH = '/password-help/status'
export const PASSWORD_HELP_PATHS = [PASSWORD_HELP_PATH, PASSWORD_HELP_STATUS_PATH]

/** What sending a request came to. `accepted` is the one answer whether or not the account exists. */
export type RequestOutcome =
  | { kind: 'accepted'; statusToken: string }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

export type RequestFormState = { kind: 'editing' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'rate-limited' } | { kind: 'unavailable' } | { kind: 'error' }

/**
 * The form's answer to an outcome. Only the three problems get their own words; every other answer
 * (accepted, or anything a server might call "created", "already open", "no such account" or
 * something new) gets the one "Request sent" answer, so nothing on the page tells whether an
 * account exists.
 */
export function requestAnswer(outcome: { kind: string }): Exclude<RequestFormState['kind'], 'editing' | 'sending'> {
  return outcome.kind === 'rate-limited' || outcome.kind === 'unavailable' || outcome.kind === 'error' ? outcome.kind : 'sent'
}

export type ResetStatus = 'waiting' | 'approved' | 'declined' | 'expired' | 'unavailable'

/** Statuses after which the request is over, so this tab forgets its token. */
export const FINAL_STATUSES: readonly ResetStatus[] = ['approved', 'declined', 'expired', 'unavailable']

/** `no-token`: opened without a token (a new tab, or the tab's storage cleared). */
export type StatusViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: ResetStatus; note?: string }
  | { kind: 'no-token' }
  | { kind: 'rate-limited' }
  | { kind: 'error' }

/** The two calls the pages need, passed in so the pages never call the API themselves. */
export interface PasswordHelpHandlers {
  /** Sends the username or mobile number in the request body. */
  requestReset(identifier: string): Promise<RequestOutcome>
  /** Sends the status token in the request body. */
  readStatus(statusToken: string): Promise<Exclude<StatusViewState, { kind: 'loading' } | { kind: 'no-token' }>>
}

const STORAGE_KEY = 'shri.portal.passwordHelp.statusToken'
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

/** The status token on arrival: from the fragment (`#status=…`), then removed from the address; otherwise the one kept for this tab. */
export function takeStatusToken(place: TokenPlace = browser()): string | null {
  const fromFragment = new URLSearchParams(place.location.hash.replace(/^#/, '')).get(FRAGMENT_KEY)
  if (place.location.hash) place.history.replaceState(place.history.state, '', place.location.pathname + place.location.search)
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

export function keepStatusToken(token: string, place: Pick<TokenPlace, 'storage'> = browser()): void {
  try {
    place.storage?.setItem(STORAGE_KEY, token)
  } catch {
    // Storage blocked: the token stays in memory for this page only.
  }
}

export function forgetStatusToken(place: Pick<TokenPlace, 'storage'> = browser()): void {
  try {
    place.storage?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing kept.
  }
}

/** Until the contract is on main: every call answers "unavailable", so a real build never shows made-up results. */
export const notYetConnected: PasswordHelpHandlers = {
  requestReset: () => Promise.resolve({ kind: 'unavailable' }),
  readStatus: () => Promise.resolve({ kind: 'ready', status: 'unavailable' }),
}
