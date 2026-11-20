// /password-help/status: where a password-reset request stands. Information only: no password
// field and no link that sets a password (the reset link comes by email, from the sign-in service).
// Reached with the request's status token, taken from the fragment on arrival (then removed from the
// address) or from this tab's storage, and sent back only in a request body.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import type { Tone } from '../../utils/tone'
import { PasswordHelpLayout } from './PasswordHelpLayout'
import { FINAL_STATUSES, forgetStatusToken, PASSWORD_HELP_PATH, takeStatusToken, type PasswordHelpHandlers, type ResetStatus, type StatusViewState } from '../../../shri-health/passwordHelp'

const STATUS: Record<ResetStatus, { tone: Tone; title: string; text: string; newRequest: boolean }> = {
  waiting: { tone: 'info', title: 'Waiting for the administrator', text: 'Your request was sent. Check back here, or wait for an email. Requests expire after 24 hours.', newRequest: false },
  approved: { tone: 'stable', title: 'Approved', text: 'Check your email for a link to set a new password.', newRequest: false },
  declined: { tone: 'warning', title: 'Declined', text: 'Your administrator declined this request.', newRequest: true },
  expired: { tone: 'warning', title: 'Expired', text: 'This request has expired. Requests expire after 24 hours.', newRequest: true },
  unavailable: { tone: 'info', title: "This request can't be shown", text: 'It may have ended, or password help may be unavailable. Contact your administrator.', newRequest: true },
}

const linkClass = 'focus-ring inline-flex min-h-11 items-center rounded font-semibold text-primary-text underline-offset-2 hover:underline'

/** Draws `state`; it never calls the API. */
export function StatusView({ state, onRefresh, signInHref }: { state: StatusViewState; onRefresh: () => void; signInHref: string }) {
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (state.kind !== 'loading') region.current?.focus()
  }, [state.kind])

  let body
  if (state.kind === 'loading') {
    body = <p className="text-sm text-ink-muted">Checking your request…</p>
  } else if (state.kind === 'no-token') {
    body = (
      <Alert tone="info" title="No request to show">
        <p>Open this page from the link shown after you sent your request, in the same browser tab.</p>
      </Alert>
    )
  } else if (state.kind === 'rate-limited' || state.kind === 'error') {
    body = (
      <div className="space-y-4">
        <Alert tone={state.kind === 'error' ? 'critical' : 'warning'} title={state.kind === 'error' ? "We couldn't check your request" : 'Too many checks'}>
          <p>{state.kind === 'error' ? 'Check your connection, then try again.' : 'Wait a few minutes, then try again.'}</p>
        </Alert>
        <Button variant="secondary" onClick={onRefresh}>
          Try again
        </Button>
      </div>
    )
  } else {
    const shown = STATUS[state.status]
    body = (
      <div className="space-y-4">
        <Alert tone={shown.tone} title={shown.title}>
          <p>{shown.text}</p>
          {state.status === 'declined' && state.note ? (
            <p className="mt-2">
              <strong>Note from your administrator:</strong> {state.note}
            </p>
          ) : null}
        </Alert>
        {state.status === 'waiting' ? (
          <Button variant="secondary" onClick={onRefresh}>
            Check again
          </Button>
        ) : null}
      </div>
    )
  }

  const newRequest = state.kind === 'no-token' || (state.kind === 'ready' && STATUS[state.status].newRequest)
  return (
    <div aria-busy={state.kind === 'loading' || undefined} className="space-y-4">
      <div ref={region} tabIndex={-1} role="status" aria-live="polite" className="outline-none">
        {body}
      </div>
      <div className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
        {newRequest ? (
          <Link to={PASSWORD_HELP_PATH} className={linkClass}>
            Send a new request
          </Link>
        ) : null}
        <a href={signInHref} className={linkClass}>
          Back to sign in
        </a>
      </div>
    </div>
  )
}

/** The page: takes the token once, then reads the status through `handlers`. */
export function StatusPage({ handlers, signInHref }: { handlers: PasswordHelpHandlers; signInHref: string }) {
  const [token, setToken] = useState(() => takeStatusToken())
  const [state, setState] = useState<StatusViewState>(token ? { kind: 'loading' } : { kind: 'no-token' })
  // A token can also arrive while the page is open (only the fragment changes, so nothing reloads):
  // take it, and remove it from the address, the same way.
  useEffect(() => {
    const arrived = () => {
      const next = takeStatusToken()
      if (next) setToken(next)
    }
    window.addEventListener('hashchange', arrived)
    return () => window.removeEventListener('hashchange', arrived)
  }, [])
  const read = useCallback(() => {
    if (!token) return
    setState({ kind: 'loading' })
    handlers.readStatus(token).then(
      (next) => {
        // A request that is over needs no token: this tab forgets it (the page keeps showing the answer).
        if (next.kind === 'ready' && FINAL_STATUSES.includes(next.status)) forgetStatusToken()
        setState(next)
      },
      () => setState({ kind: 'error' }),
    )
  }, [handlers, token])
  useEffect(() => {
    read()
  }, [read])
  return (
    <PasswordHelpLayout title="Your password reset request">
      <StatusView state={state} onRefresh={read} signInHref={signInHref} />
    </PasswordHelpLayout>
  )
}
