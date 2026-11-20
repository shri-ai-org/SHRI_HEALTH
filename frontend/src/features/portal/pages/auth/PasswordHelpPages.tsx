import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Button, Field, TextInput, type AlertTone } from '../../../../design-system'
import {
  FINAL_STATUSES,
  forgetStatusToken,
  keepStatusToken,
  PASSWORD_HELP_PATH,
  PASSWORD_HELP_STATUS_PATH,
  requestAnswer,
  takeStatusToken,
  type PasswordHelpHandlers,
  type RequestFormState,
  type ResetStatus,
  type StatusViewState,
} from '../../passwordHelp'
import { Link } from '../../router'
import { AuthLayout } from './AuthLayout'

/** The one answer after a request is accepted, whatever the account. */
export const SENT_TITLE = 'Request sent'
export const SENT_TEXT =
  "If that account can use password help, your clinic will see your request. Once it's approved, you'll get an email with a link to set a new password."

const FIELD_ID = 'password-help-identifier'

const linkClass = 'inline-flex min-h-11 items-center font-semibold text-primary-700 underline-offset-2 hover:underline'

/** Back to the portal's sign-in page (the portal root starts it). */
function BackToSignIn() {
  return (
    <Link to="/sign-in" className={linkClass}>
      Back to sign in
    </Link>
  )
}

const PROBLEM: Record<'rate-limited' | 'unavailable' | 'error', { tone: AlertTone; title: string; text: string }> = {
  'rate-limited': { tone: 'warning', title: 'Too many requests', text: 'Wait a few minutes, then try again.' },
  unavailable: { tone: 'warning', title: "Password help isn't available right now", text: "Contact your clinic's front desk." },
  error: { tone: 'critical', title: "We couldn't send your request", text: 'Check your connection, then try again.' },
}

/** `/password-help`: the form and its answer, drawn from `state`; it never calls the API. */
export function PasswordHelpRequestView({ state, onSubmit }: { state: RequestFormState; onSubmit: (identifier: string) => void }) {
  const [identifier, setIdentifier] = useState('')
  const [missing, setMissing] = useState(false)
  const answer = useRef<HTMLDivElement>(null)
  // The answer takes focus when it appears, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (state.kind !== 'editing' && state.kind !== 'sending') answer.current?.focus()
  }, [state.kind])

  function submit(e: FormEvent) {
    e.preventDefault()
    const value = identifier.trim()
    setMissing(!value)
    if (value) onSubmit(value)
    // Empty: focus goes to the field, whose error it then reads out (aria-describedby).
    else document.getElementById(FIELD_ID)?.focus()
  }

  if (state.kind === 'sent') {
    return (
      <div ref={answer} tabIndex={-1} className="space-y-4 outline-none">
        <Alert tone="success" title={SENT_TITLE}>
          {SENT_TEXT}
        </Alert>
        <p className="text-sm text-ink-muted">Requests expire after 24 hours.</p>
        <div className="flex flex-col">
          <Link to={PASSWORD_HELP_STATUS_PATH} className={linkClass}>
            Check the status of your request
          </Link>
          <BackToSignIn />
        </div>
      </div>
    )
  }

  const problem = state.kind === 'rate-limited' || state.kind === 'unavailable' || state.kind === 'error' ? PROBLEM[state.kind] : null
  return (
    <form noValidate onSubmit={submit} className="space-y-4" aria-busy={state.kind === 'sending' || undefined}>
      <div ref={answer} tabIndex={-1} className="outline-none">
        {problem ? (
          <Alert tone={problem.tone} title={problem.title}>
            {problem.text}
          </Alert>
        ) : null}
      </div>
      <Field
        id={FIELD_ID}
        label="Username or mobile number"
        hint="The username you sign in with, or the mobile number on your record."
        required
        error={missing ? 'Enter your username or mobile number.' : undefined}
      >
        {(p) => (
          <TextInput
            {...p}
            autoComplete="username"
            maxLength={255}
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value)
              if (missing && e.target.value.trim()) setMissing(false)
            }}
          />
        )}
      </Field>
      <Button type="submit" loading={state.kind === 'sending'} className="w-full" size="lg">
        Send request
      </Button>
      <BackToSignIn />
    </form>
  )
}

export function PasswordHelpRequestPage({ handlers }: { handlers: PasswordHelpHandlers }) {
  const [state, setState] = useState<RequestFormState>({ kind: 'editing' })
  function send(identifier: string) {
    setState({ kind: 'sending' })
    // A new request replaces any token this tab kept from an earlier one.
    forgetStatusToken()
    handlers.requestReset(identifier).then(
      (outcome) => {
        if (outcome.kind === 'accepted') keepStatusToken(outcome.statusToken)
        setState({ kind: requestAnswer(outcome) })
      },
      () => setState({ kind: 'error' }),
    )
  }
  return (
    <AuthLayout
      title="Forgot your password?"
      intro={state.kind === 'sent' ? undefined : "Ask your clinic to reset it. After it's approved, you'll get an email with a link to set a new password."}
    >
      <PasswordHelpRequestView state={state} onSubmit={send} />
    </AuthLayout>
  )
}

const STATUS: Record<ResetStatus, { tone: AlertTone; title: string; text: string; newRequest: boolean }> = {
  waiting: { tone: 'info', title: 'Waiting for your clinic', text: 'Your request was sent. Check back here, or wait for an email. Requests expire after 24 hours.', newRequest: false },
  approved: { tone: 'success', title: 'Approved', text: 'Check your email for a link to set a new password.', newRequest: false },
  declined: { tone: 'warning', title: 'Declined', text: 'Your clinic declined this request.', newRequest: true },
  expired: { tone: 'warning', title: 'Expired', text: 'This request has expired. Requests expire after 24 hours.', newRequest: true },
  unavailable: { tone: 'info', title: "This request can't be shown", text: "It may have ended, or password help may be unavailable. Contact your clinic's front desk.", newRequest: true },
}

/** `/password-help/status`: information only, drawn from `state`; no password field and no reset link. */
export function PasswordHelpStatusView({ state, onRefresh }: { state: StatusViewState; onRefresh: () => void }) {
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (state.kind !== 'loading') region.current?.focus()
  }, [state.kind])

  let body
  if (state.kind === 'loading') {
    body = (
      <p role="status" className="text-sm text-ink-muted">
        Checking your request…
      </p>
    )
  } else if (state.kind === 'no-token') {
    body = (
      <Alert tone="info" title="No request to show">
        Open this page from the link shown after you sent your request, in the same browser tab.
      </Alert>
    )
  } else if (state.kind === 'rate-limited' || state.kind === 'error') {
    body = (
      <Alert
        tone={state.kind === 'error' ? 'critical' : 'warning'}
        title={state.kind === 'error' ? "We couldn't check your request" : 'Too many checks'}
        actions={
          <Button variant="secondary" onClick={onRefresh}>
            Try again
          </Button>
        }
      >
        {state.kind === 'error' ? 'Check your connection, then try again.' : 'Wait a few minutes, then try again.'}
      </Alert>
    )
  } else {
    const shown = STATUS[state.status]
    body = (
      <Alert
        tone={shown.tone}
        title={shown.title}
        actions={
          state.status === 'waiting' ? (
            <Button variant="secondary" onClick={onRefresh}>
              Check again
            </Button>
          ) : undefined
        }
      >
        {shown.text}
        {state.status === 'declined' && state.note ? (
          <span className="mt-2 block">
            <strong>Note from your clinic:</strong> {state.note}
          </span>
        ) : null}
      </Alert>
    )
  }

  const newRequest = state.kind === 'no-token' || (state.kind === 'ready' && STATUS[state.status].newRequest)
  return (
    <div aria-busy={state.kind === 'loading' || undefined} className="space-y-4">
      <div ref={region} tabIndex={-1} className="outline-none">
        {body}
      </div>
      <div className="flex flex-col">
        {newRequest ? (
          <Link to={PASSWORD_HELP_PATH} className={linkClass}>
            Send a new request
          </Link>
        ) : null}
        <BackToSignIn />
      </div>
    </div>
  )
}

export function PasswordHelpStatusPage({ handlers }: { handlers: PasswordHelpHandlers }) {
  const [token, setToken] = useState(() => takeStatusToken())
  const [state, setState] = useState<StatusViewState>(token ? { kind: 'loading' } : { kind: 'no-token' })
  // A token can also arrive while the page is open (only the fragment changes, so nothing reloads).
  useEffect(() => {
    const arrived = () => {
      const next = takeStatusToken()
      if (!next) return
      setState({ kind: 'loading' })
      setToken(next)
    }
    window.addEventListener('hashchange', arrived)
    return () => window.removeEventListener('hashchange', arrived)
  }, [])
  // Reads the status; the caller has already shown "Checking your request…".
  const load = useCallback(
    (t: string) =>
      handlers.readStatus(t).then(
        (next) => {
          // A request that is over needs no token: this tab forgets it (the page keeps showing the answer).
          if (next.kind === 'ready' && FINAL_STATUSES.includes(next.status)) forgetStatusToken()
          setState(next)
        },
        () => setState({ kind: 'error' }),
      ),
    [handlers],
  )
  useEffect(() => {
    if (token) void load(token)
  }, [load, token])
  function refresh() {
    if (!token) return
    setState({ kind: 'loading' })
    void load(token)
  }
  return (
    <AuthLayout title="Your password reset request">
      <PasswordHelpStatusView state={state} onRefresh={refresh} />
    </AuthLayout>
  )
}
