/**
 * Browser side of the session (SECURITY_MODEL §2.1, ADR-0006): reads `GET /auth/session`, keeps the
 * CSRF token for the fetch wrapper, and shows "Stay signed in" timed from the server's
 * `idleExpiresAt` and `expiresAt`, never from a browser-only timer (Thulasi's confirmation, issue #3).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IdleTimeoutWarning } from '../design-system'
import { API_BASE, ApiError, onUserRequest, setCsrfToken } from './client'
import { getSession, logout, refreshSession } from './generated/endpoints/platform/platform'
import type { Session } from './generated/model'

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; session: Session }
  | { status: 'signed-out' }

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

export interface SessionProviderProps {
  children: ReactNode
  /** Shown when nobody is signed in. Defaults to a sign-in button. */
  signedOut?: ReactNode
  /** After a user request, wait this long before re-reading the session (several requests share one read). */
  reloadDelayMs?: number
}

export function SessionProvider({ children, signedOut, reloadDelayMs = 1000 }: SessionProviderProps) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  const apply = useCallback((session: Session | null) => {
    setCsrfToken(session?.csrfToken ?? null)
    setState(session ? { status: 'signed-in', session } : { status: 'signed-out' })
  }, [])

  const reload = useCallback(async () => {
    const result = await readSession()
    if (result !== 'unchanged') apply(result)
  }, [apply])

  useEffect(() => {
    let cancelled = false
    void readSession().then((result) => {
      if (!cancelled && result !== 'unchanged') apply(result)
    })
    return () => {
      cancelled = true
    }
  }, [apply])

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

  const staySignedIn = useCallback(async () => {
    // A user action: extends the idle timer. It cannot move the 12-hour `expiresAt`.
    const res = await refreshSession()
    if (res.status === 200) apply(res.data)
  }, [apply])

  const signOut = useCallback(async () => {
    try {
      await logout()
    } finally {
      apply(null)
      goToSignIn()
    }
  }, [apply])

  const value = useMemo(() => ({ state, reload, signOut }), [state, reload, signOut])

  return (
    <SessionContext.Provider value={value}>
      {state.status === 'signed-in' ? (
        <>
          {children}
          <IdleTimeoutWarning
            idleExpiresAt={state.session.idleExpiresAt}
            expiresAt={state.session.expiresAt}
            onStaySignedIn={staySignedIn}
            onSignOut={() => void signOut()}
            onExpired={() => {
              apply(null)
              goToSignIn()
            }}
          />
        </>
      ) : state.status === 'signed-out' ? (
        (signedOut ?? <SignInPrompt />)
      ) : null}
    </SessionContext.Provider>
  )
}

/**
 * The session, `null` when nobody is signed in, or `'unchanged'` when the read failed for another
 * reason (network, 5xx): the current state stays and the next request tries again.
 */
async function readSession(): Promise<Session | null | 'unchanged'> {
  try {
    const res = await getSession()
    return res.status === 200 ? res.data : 'unchanged'
  } catch (error) {
    return error instanceof ApiError && (error.status === 401 || error.status === 403) ? null : 'unchanged'
  }
}

function SignInPrompt() {
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold text-ink">Sign in to Shri Health</h1>
      <p className="mt-2 text-ink-muted">Your session has ended or you haven&apos;t signed in yet.</p>
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
