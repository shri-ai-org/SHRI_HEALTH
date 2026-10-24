import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Alert } from '../components/feedback'
import { Modal } from '../components/Modal'

export interface IdleTimeoutWarningProps {
  /** `idleExpiresAt` from `GET /auth/session` (UTC instant). Re-read it after any user request. */
  idleExpiresAt: string
  /** `expiresAt`: the 12-hour absolute limit, which cannot be extended. */
  expiresAt: string
  /**
   * Calls `POST /auth/refresh` (a user action) and re-reads the session, resolving when done. The
   * dialog shows its own busy state, and an error if the refresh fails.
   */
  onStaySignedIn: () => Promise<void>
  onSignOut: () => void
  /**
   * The local clock says a limit has passed. Re-read the session before ending it here: another
   * tab may have kept it alive. Called again if a later `idleExpiresAt` arrives and passes too.
   */
  onExpired: () => void
  /**
   * Show the idle dialog only once the session layer has re-read `GET /auth/session` inside the
   * warning window and the server still says the session ends soon (activity in another tab
   * counts; SECURITY_MODEL §2.1). Defaults to `true`.
   */
  idleWarningConfirmed?: boolean
  /** Warning shows this long before `idleExpiresAt`: 2 minutes, i.e. at 13 of 15 minutes (SECURITY_MODEL §2.1). */
  warnBeforeMs?: number
  /** Notice before the absolute limit, so people can save their work. */
  absoluteNoticeBeforeMs?: number
  /** For tests. */
  now?: () => number
}

/**
 * Idle-timeout warning timed from the server's `idleExpiresAt`, not a browser-only timer, so
 * activity in another tab counts. Also shows a notice before the absolute session limit.
 */
export function IdleTimeoutWarning({
  idleExpiresAt,
  expiresAt,
  onStaySignedIn,
  onSignOut,
  onExpired,
  idleWarningConfirmed = true,
  warnBeforeMs = 2 * 60_000,
  absoluteNoticeBeforeMs = 15 * 60_000,
  now = Date.now,
}: IdleTimeoutWarningProps) {
  const [current, setCurrent] = useState(now)
  const [staying, setStaying] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)

  async function staySignedIn() {
    setStaying(true)
    setRefreshFailed(false)
    try {
      await onStaySignedIn()
    } catch {
      setRefreshFailed(true)
    } finally {
      setStaying(false)
    }
  }
  const expiredFired = useRef(false)
  const stayRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setCurrent(now()), 1000)
    return () => window.clearInterval(timer)
  }, [now])

  const idleLeft = Date.parse(idleExpiresAt) - current
  const absoluteLeft = Date.parse(expiresAt) - current
  // The session ends at whichever limit comes first.
  const left = Math.min(idleLeft, absoluteLeft)

  useEffect(() => {
    if (left <= 0 && !expiredFired.current) {
      expiredFired.current = true
      onExpired()
    }
    if (left > 0) expiredFired.current = false
  }, [left, onExpired])

  // Staying signed in cannot move the absolute limit, so the idle dialog only appears when
  // the idle limit is the one about to end the session.
  const showIdle = idleWarningConfirmed && left > 0 && idleLeft <= warnBeforeMs && idleLeft <= absoluteLeft
  const showAbsolute = absoluteLeft > 0 && absoluteLeft <= absoluteNoticeBeforeMs

  return (
    <>
      {showAbsolute ? (
        <div className="fixed inset-x-0 top-0 z-40 px-4 pt-3">
          <div className="mx-auto max-w-2xl">
            <Alert tone="warning" title={`Your session ends in ${minutesText(absoluteLeft)}`} assertive={false}>
              Sessions last 12 hours and can&apos;t be extended. Save your work; you&apos;ll need to sign in again.
            </Alert>
          </div>
        </div>
      ) : null}
      <Modal
        open={showIdle}
        role="alertdialog"
        title="Are you still there?"
        size="sm"
        initialFocus={stayRef}
        footer={
          <>
            <Button variant="outline" onClick={onSignOut}>
              Sign out
            </Button>
            <Button ref={stayRef} loading={staying} onClick={() => void staySignedIn()}>
              Stay signed in
            </Button>
          </>
        }
      >
        <p>
          For patient privacy, you&apos;ll be signed out in{' '}
          <strong className="text-ink tabular-nums" aria-live="off">
            {clock(idleLeft)}
          </strong>{' '}
          because there has been no activity.
        </p>
        {refreshFailed ? (
          <div className="mt-3">
            <Alert tone="critical" title="Couldn't keep you signed in">
              Save your work now. Try again, or sign in again after you&apos;re signed out.
            </Alert>
          </div>
        ) : null}
      </Modal>
    </>
  )
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}
