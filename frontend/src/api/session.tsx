/**
 * Browser side of the session (SECURITY_MODEL §2.1, ADR-0006): reads `GET /auth/session`, keeps the
 * CSRF token for the fetch wrapper, and shows "Stay signed in" timed from the server's
 * `idleExpiresAt` and `expiresAt`, never from a browser-only timer (Thulasi's confirmation, issue #3).
 *
 * The server decides when the session ends. Before this tab warns or ends the session, it re-reads
 * `GET /auth/session` (which never counts as activity), so work in another tab keeps it alive.
 * When the session has ended, the tab shows a sign-in prompt and starts a new login only when the
 * user asks: an automatic redirect could sign the same user back in through Keycloak on a shared
 * workstation, which would defeat the automatic sign-out.
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
  | { status: 'signed-in'; session: Session }
  | { status: 'signed-out'; reason: SignedOutReason }

interface SessionContextValue {
  state: SessionState
  /** Re-read `GET /auth/session`, e.g. after an action that may have changed the user's clinic. */
  reload: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

/** Full-page navigation: the server sends the browser to Keycloak (`GET /auth/login`). Only on a user's click. */
export function goToSignIn(): void {
  window.location.assign(`${API_BASE}/auth/login`)
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

  const now = useCallback(() => Date.now() + clockOffsetMs, [clockOffsetMs])

  const reload = useCallback(async () => {
    const result = await readSession()
    if (result === null) end('not-signed-in')
    else if (result !== 'unchanged') signedIn(result)
  }, [end, signedIn])

  useEffect(() => {
    let cancelled = false
    void readSession().then((result) => {
      if (cancelled) return
      if (result === null) end('not-signed-in')
      else if (result !== 'unchanged') signedIn(result)
    })
    return () => {
      cancelled = true
    }
  }, [end, signedIn])

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
    try {
      await logout()
    } catch {
      // The server session may already be gone; this tab signs out either way.
    }
    end('signed-out')
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
        (signedOut?.(state.reason) ?? <SignInPrompt reason={state.reason} />)
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

const PROMPT: Record<SignedOutReason, { title: string; text: string }> = {
  'not-signed-in': { title: 'Sign in to Shri Health', text: "You're not signed in." },
  expired: {
    title: 'You were signed out',
    text: 'For patient privacy, you were signed out after a period of inactivity or at the end of your session.',
  },
  'signed-out': { title: 'You have signed out', text: 'Sign in again to continue.' },
}

function SignInPrompt({ reason }: { reason: SignedOutReason }) {
  const { title, text } = PROMPT[reason]
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-ink-muted">{text}</p>
      <div className="mt-6">
        <Button onClick={goToSignIn}>Sign in</Button>
      </div>
    </main>
  )
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside <SessionProvider>')
  return value
}
