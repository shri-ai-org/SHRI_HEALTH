/**
 * Browser side of the session (SECURITY_MODEL §2.1, ADR-0006): reads `GET /auth/session`, keeps the
 * CSRF token for the fetch wrapper, and shows "Stay signed in" timed from the server's
 * `idleExpiresAt` and `expiresAt`, never from a browser-only timer (Thulasi's confirmation, issue #3).
 *
 * The server decides when the session ends. Before this tab warns or ends the session, it re-reads
 * `GET /auth/session` (which never counts as activity), so work in another tab keeps it alive.
 * Nobody signed in (`not-signed-in`, the first read of a fresh visit): the tab goes straight to the
 * sign-in form, with no page of its own before it (Thulasi on #85, 12 Nov). **Sign out** (the user
 * menu, or the idle warning's button) ends our session and, through it, the Keycloak session
 * (`POST /auth/logout`; core ends it at Keycloak with the session's refresh token), then goes
 * straight to the sign-in form, so the next person can sign in at once (Vimal, demo run check,
 * 12 Nov). If the logout call fails, the tab shows "You have signed out" and starts nothing. A
 * session that expired keeps its prompt and starts a new login only when the user asks, so the
 * user sees why. A signed-in tab whose session disappears on a re-read counts as `expired`, never
 * as `not-signed-in`.
 *
 * A guard against a redirect loop (Vimal on #304): the tab counts its trips to the sign-in form in
 * `sessionStorage` (a count and a time only, no patient or user data). A browser that comes back
 * still signed out twice in a row, each within a minute, stops being redirected and sees one line,
 * "Sign-in didn't complete. Try again.", whose link starts the sign-in again. Normally nobody sees
 * it. Without `sessionStorage` the tab just keeps redirecting: Keycloak always shows its form
 * (`prompt=login`), so each trip stops there. The "not signed in" page itself never shows.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IdleTimeoutWarning } from '../design-system'
import { API_BASE, ApiError, onUnauthenticated, onUserRequest, setCsrfToken } from './client'
import { getSession, logout, refreshSession } from './generated/endpoints/platform/platform'
import type { Session } from './generated/model'

/** Why nobody is signed in: shapes the words on the sign-in prompt. */
export type SignedOutReason = 'not-signed-in' | 'expired' | 'signed-out'

export type SessionState =
  | { status: 'loading' }
  // The first read failed for a reason other than "not signed in" (network, 5xx): nobody knows
  // yet whether the user is signed in, so the app offers a retry instead of a blank page.
  | { status: 'unreachable' }
  | { status: 'signed-in'; session: Session }
  | { status: 'signed-out'; reason: SignedOutReason }

interface SessionContextValue {
  state: SessionState
  /** Re-read `GET /auth/session`, e.g. after an action that may have changed the user's clinic. */
  reload: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

/** Full-page navigation: the server sends the browser to Keycloak (`GET /auth/login`). */
export function goToSignIn(): void {
  window.location.assign(`${API_BASE}/auth/login`)
}

/** This tab's recent trips to the sign-in form: `count:time` (ms since the epoch), nothing else. */
const SIGN_IN_TRIES_KEY = 'shri.session.signInTries'
/** A return later than this after the last trip starts a new count. */
const SIGN_IN_TRY_WINDOW_MS = 60_000
/** Back still signed out after this many trips in a row: stop redirecting. */
const SIGN_IN_MAX_TRIES = 2

/** True, and the trip counted, when this tab may go to sign in on its own now. */
function mayAutoSignIn(): boolean {
  try {
    const [count = 0, at = 0] = (window.sessionStorage.getItem(SIGN_IN_TRIES_KEY) ?? '').split(':').map(Number)
    const tries = at > 0 && Date.now() - at < SIGN_IN_TRY_WINDOW_MS ? count : 0
    if (tries >= SIGN_IN_MAX_TRIES) return false
    window.sessionStorage.setItem(SIGN_IN_TRIES_KEY, `${tries + 1}:${Date.now()}`)
    return true
  } catch {
    return true // no storage: keep redirecting; Keycloak's form stops each trip (prompt=login)
  }
}

/** A sign-in the user asked for (a link or button): a new count of one trip, then the form. */
function signInAgain(): void {
  try {
    window.sessionStorage.setItem(SIGN_IN_TRIES_KEY, `1:${Date.now()}`)
  } catch {
    // no storage: nothing to count
  }
  goToSignIn()
}

/** This page load's answer from `mayAutoSignIn`, once asked, and whether it has left already. */
let autoSignInDecision: boolean | undefined
let autoSignInLeft = false

/** For tests: forget this page load's answer, as a new page load would. */
export function resetAutoSignInForTests(): void {
  autoSignInDecision = undefined
  autoSignInLeft = false
}

function forgetAutoSignIn(): void {
  try {
    window.sessionStorage.removeItem(SIGN_IN_TRIES_KEY)
  } catch {
    // nothing to forget
  }
}

/** The idle warning shows this long before `idleExpiresAt` (13 of 15 minutes; SECURITY_MODEL §2.1). */
const WARN_BEFORE_MS = 2 * 60_000

export interface SessionProviderProps {
  children: ReactNode
  /** Shown when nobody is signed in. Defaults to a sign-in prompt. */
  signedOut?: (reason: SignedOutReason) => ReactNode
  /** After a user request, wait this long before re-reading the session (several requests share one read). */
  reloadDelayMs?: number
}

export function SessionProvider({ children, signedOut, reloadDelayMs = 1000 }: SessionProviderProps) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  // Server time minus browser time, from the `Date` header, so a fast or slow browser clock
  // doesn't warn or end the session early.
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  // The `idleExpiresAt` that a re-read inside the warning window confirmed; the dialog waits for it.
  const [confirmedIdle, setConfirmedIdle] = useState<string | null>(null)
  // The status as of the last change, for the 401 listener. Set together with the state, not in an
  // effect: a 401 can arrive after sign-in but before React has run its effects, and must not be
  // ignored then.
  const statusRef = useRef<SessionState['status']>('loading')

  const signedIn = useCallback((read: SessionRead) => {
    forgetAutoSignIn()
    setCsrfToken(read.session.csrfToken)
    if (read.clockOffsetMs !== null) setClockOffsetMs(read.clockOffsetMs)
    statusRef.current = 'signed-in'
    setState({ status: 'signed-in', session: read.session })
  }, [])

  const end = useCallback((reason: SignedOutReason) => {
    setCsrfToken(null)
    setConfirmedIdle(null)
    statusRef.current = 'signed-out'
    setState({ status: 'signed-out', reason })
  }, [])

  const unreachable = useCallback(() => {
    statusRef.current = 'unreachable'
    setState({ status: 'unreachable' })
  }, [])

  const now = useCallback(() => Date.now() + clockOffsetMs, [clockOffsetMs])

  const reload = useCallback(async () => {
    const result = await readSession()
    // A session that ended under a signed-in tab is `expired`, and a tab already showing why it
    // was signed out keeps showing it: neither ever turns into the automatic redirect.
    if (result === null) {
      if (statusRef.current === 'signed-in') end('expired')
      else if (statusRef.current !== 'signed-out') end('not-signed-in')
    } else if (result !== 'unchanged') signedIn(result)
  }, [end, signedIn])

  // The first read decides what the page shows. A failed one shows "can't reach the server", not
  // nothing; a signed-in tab keeps its session through a failed re-read, as before.
  const settleFirstRead = useCallback(
    (result: SessionRead | null | 'unchanged') => {
      if (result === null) end('not-signed-in')
      else if (result === 'unchanged') unreachable()
      else signedIn(result)
    },
    [end, signedIn, unreachable],
  )

  const retryFirstRead = useCallback(async () => settleFirstRead(await readSession()), [settleFirstRead])

  useEffect(() => {
    let cancelled = false
    void readSession().then((result) => {
      if (!cancelled) settleFirstRead(result)
    })
    return () => {
      cancelled = true
    }
  }, [settleFirstRead])

  // A user request may have extended the idle timer on the server: re-read the new expiries.
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const stop = onUserRequest(() => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void reload(), reloadDelayMs)
    })
    return () => {
      stop()
      window.clearTimeout(timer.current)
    }
  }, [reload, reloadDelayMs])

  // Any call answered 401 (user or background): the server has ended the session.
  useEffect(
    () =>
      onUnauthenticated(() => {
        if (statusRef.current === 'signed-in') end('expired')
      }),
    [end],
  )

  // When the warning is due, ask the server first: another tab may have kept the session alive.
  const idleExpiresAt = state.status === 'signed-in' ? state.session.idleExpiresAt : null
  useEffect(() => {
    if (idleExpiresAt === null) return
    let cancelled = false
    const due = Date.parse(idleExpiresAt) - WARN_BEFORE_MS - now()
    const handle = window.setTimeout(
      () => {
        void readSession().then((result) => {
          if (cancelled) return
          if (result === null) return end('expired')
          if (result === 'unchanged') return setConfirmedIdle(idleExpiresAt) // can't ask: warn on the time we have
          signedIn(result)
          // A later time means activity elsewhere: this effect runs again for it. The same time
          // (within a second, for rounding) or an earlier one is confirmed, so the dialog may show.
          if (Date.parse(result.session.idleExpiresAt) <= Date.parse(idleExpiresAt) + 1000) {
            setConfirmedIdle(result.session.idleExpiresAt)
          }
        })
      },
      Math.max(0, due),
    )
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [idleExpiresAt, now, end, signedIn])

  // The local clock says a limit has passed: end the session here only if the server agrees.
  const checkingExpiry = useRef(false)
  const onExpired = useCallback(async () => {
    if (checkingExpiry.current) return
    checkingExpiry.current = true
    try {
      const result = await readSession()
      if (result === null || result === 'unchanged') return end('expired') // a failed read fails closed
      const t = Date.now() + (result.clockOffsetMs ?? clockOffsetMs)
      const alive = Date.parse(result.session.idleExpiresAt) > t && Date.parse(result.session.expiresAt) > t
      if (alive) signedIn(result)
      else end('expired')
    } finally {
      checkingExpiry.current = false
    }
  }, [clockOffsetMs, end, signedIn])

  const staySignedIn = useCallback(async () => {
    // A user action: extends the idle timer. It cannot move the 12-hour `expiresAt`.
    const res = await refreshSession()
    if (res.status === 200) signedIn({ session: res.data, clockOffsetMs: offsetFrom(res.headers) })
  }, [signedIn])

  const signOut = useCallback(async () => {
    let ended = false
    try {
      await logout()
      ended = true
    } catch {
      // The server session may already be gone; this tab signs out either way.
    }
    end('signed-out')
    // Both sessions are over: the sign-in form, for this user or the next (Keycloak always asks,
    // prompt=login). Not a trip the redirect-loop guard counts.
    if (ended) goToSignIn()
  }, [end])

  const value = useMemo(() => ({ state, reload, signOut }), [state, reload, signOut])

  return (
    <SessionContext.Provider value={value}>
      {state.status === 'signed-in' ? (
        <>
          {children}
          <IdleTimeoutWarning
            idleExpiresAt={state.session.idleExpiresAt}
            expiresAt={state.session.expiresAt}
            idleWarningConfirmed={confirmedIdle === state.session.idleExpiresAt}
            warnBeforeMs={WARN_BEFORE_MS}
            now={now}
            onStaySignedIn={staySignedIn}
            onSignOut={() => void signOut()}
            onExpired={() => void onExpired()}
          />
        </>
      ) : state.status === 'signed-out' ? (
        (signedOut?.(state.reason) ??
        (state.reason === 'not-signed-in' ? <AutoSignIn /> : <SignInPrompt reason={state.reason} />))
      ) : state.status === 'unreachable' ? (
        <UnreachablePrompt onRetry={retryFirstRead} />
      ) : null}
    </SessionContext.Provider>
  )
}

interface SessionRead {
  session: Session
  /** Server minus browser time in ms, or `null` when the response had no usable `Date` header. */
  clockOffsetMs: number | null
}

/**
 * The session, `null` when nobody is signed in, or `'unchanged'` when the read failed for another
 * reason (network, 5xx).
 */
async function readSession(): Promise<SessionRead | null | 'unchanged'> {
  try {
    const res = await getSession()
    return res.status === 200 ? { session: res.data, clockOffsetMs: offsetFrom(res.headers) } : 'unchanged'
  } catch (error) {
    return error instanceof ApiError && (error.status === 401 || error.status === 403) ? null : 'unchanged'
  }
}

/** `Date` has one-second resolution, so differences under 2 s are treated as none. */
function offsetFrom(headers: Headers): number | null {
  const date = headers.get('Date')
  if (!date) return null
  const server = Date.parse(date)
  if (Number.isNaN(server)) return null
  const offset = server - Date.now()
  return Math.abs(offset) < 2000 ? 0 : offset
}

/** A session that ended here: why, and a sign-in on the user's click. Nobody signed in has no page. */
type EndedReason = Exclude<SignedOutReason, 'not-signed-in'>

const PROMPT: Record<EndedReason, { title: string; text: string }> = {
  expired: {
    title: 'You were signed out',
    text: 'For patient privacy, you were signed out after a period of inactivity or at the end of your session.',
  },
  'signed-out': { title: 'You have signed out', text: 'Sign in again to continue.' },
}

function SignInPrompt({ reason }: { reason: EndedReason }) {
  const { title, text } = PROMPT[reason]
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-ink-muted">{text}</p>
      <div className="mt-6">
        <Button onClick={signInAgain}>Sign in</Button>
      </div>
    </main>
  )
}

/** Nobody signed in: straight to the sign-in form, once (see the guard above); else the prompt. */
function AutoSignIn() {
  // Decided once per page load: React's development double render must not count as a return.
  autoSignInDecision ??= mayAutoSignIn()
  const leaving = autoSignInDecision
  useEffect(() => {
    // Once per page load: React's development double effect must not send the browser twice.
    if (leaving && !autoSignInLeft) {
      autoSignInLeft = true
      goToSignIn()
    }
  }, [leaving])
  if (!leaving) return <SignInDidNotComplete />
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <p role="status" className="text-ink-muted">
        Taking you to sign in…
      </p>
    </main>
  )
}

/** Back still signed out twice in a row: one line, and a link that starts the sign-in again. */
function SignInDidNotComplete() {
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <p className="text-ink">
        Sign-in didn’t complete.{' '}
        <a
          href={`${API_BASE}/auth/login`}
          onClick={(e) => {
            e.preventDefault()
            signInAgain()
          }}
          className="font-semibold text-primary-700 underline underline-offset-2"
        >
          Try again
        </a>
        .
      </p>
    </main>
  )
}

/** The first session read failed (network, 5xx). Retrying reads it again; nothing signs in on its own. */
function UnreachablePrompt({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [tries, setTries] = useState(0)
  async function retry() {
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
      setTries((n) => n + 1)
    }
  }
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold text-ink">Can’t reach Shri Health</h1>
      <p className="mt-2 text-ink-muted">The server didn’t answer. Check your connection, then try again.</p>
      {tries > 0 ? (
        <p role="status" className="mt-2 text-sm text-ink-muted">
          Still no answer. If this keeps happening, contact your practice’s support.
        </p>
      ) : null}
      <div className="mt-6">
        <Button loading={busy} onClick={() => void retry()}>
          Try again
        </Button>
      </div>
    </main>
  )
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside <SessionProvider>')
  return value
}
