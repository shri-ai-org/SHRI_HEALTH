// /password-help: a staff member asks the administrator for a password reset. One field, the
// username, sent only in the request body. After sending, the same answer whether or not the
// account exists, and for a second open request too: nothing here says whether an account exists.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { TextField } from '../register/fields'
import { PasswordHelpLayout } from './PasswordHelpLayout'
import {
  forgetStatusToken,
  keepStatusToken,
  PASSWORD_HELP_STATUS_PATH,
  requestAnswer,
  type PasswordHelpHandlers,
  type RequestFormState,
} from '../../../shri-health/passwordHelp'

/** The one answer after a request is accepted, whatever the account. */
export const SENT_TITLE = 'Request sent'
export const SENT_TEXT =
  "If that account can use password help, your administrator will see your request. Once it's approved, you'll get an email with a link to set a new password."

const PROBLEM: Record<Exclude<RequestFormState['kind'], 'editing' | 'sending' | 'sent'>, { title: string; text: string }> = {
  'rate-limited': { title: 'Too many requests', text: 'Wait a few minutes, then try again.' },
  unavailable: { title: "Password help isn't available right now", text: 'Contact your administrator.' },
  error: { title: "We couldn't send your request", text: 'Check your connection, then try again.' },
}

/** The form and its answer, drawn from `state`; it never calls the API. */
export function RequestView({ state, onSubmit, signInHref }: { state: RequestFormState; onSubmit: (username: string) => void; signInHref: string }) {
  const [username, setUsername] = useState('')
  const [missing, setMissing] = useState(false)
  const answer = useRef<HTMLDivElement>(null)
  // The answer takes focus when it appears, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (state.kind !== 'editing' && state.kind !== 'sending') answer.current?.focus()
  }, [state.kind])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = username.trim()
    setMissing(!value)
    if (value) onSubmit(value)
  }

  if (state.kind === 'sent') {
    return (
      <div ref={answer} tabIndex={-1} className="space-y-4 outline-none" role="status" aria-live="polite">
        <Alert tone="stable" title={SENT_TITLE}>
          <p>{SENT_TEXT}</p>
        </Alert>
        <p className="text-sm text-ink-muted">Requests expire after 24 hours.</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link to={PASSWORD_HELP_STATUS_PATH} className="focus-ring inline-flex min-h-11 items-center rounded font-semibold text-primary-text underline-offset-2 hover:underline">
            Check the status of your request
          </Link>
        </div>
        <p className="text-sm">
          <a href={signInHref} className="focus-ring inline-flex min-h-11 items-center rounded font-semibold text-primary-text underline-offset-2 hover:underline">
            Back to sign in
          </a>
        </p>
      </div>
    )
  }

  const problem = state.kind in PROBLEM ? PROBLEM[state.kind as keyof typeof PROBLEM] : null
  return (
    <form noValidate onSubmit={submit} className="space-y-5" aria-busy={state.kind === 'sending' || undefined}>
      <div ref={answer} tabIndex={-1} className="outline-none" aria-live="polite">
        {problem ? (
          <Alert tone={state.kind === 'error' ? 'critical' : 'warning'} title={problem.title}>
            <p>{problem.text}</p>
          </Alert>
        ) : null}
      </div>
      <TextField
        id="password-help-username"
        name="username"
        label="Username"
        required
        value={username}
        onChange={(value) => {
          setUsername(value)
          if (missing && value.trim()) setMissing(false)
        }}
        maxLength={255}
        error={missing ? 'Enter your username.' : undefined}
        hint="The name you use to sign in."
      />
      <Button type="submit" fullWidth size="lg" loading={state.kind === 'sending'}>
        Send request
      </Button>
      <p className="text-center text-sm">
        <a href={signInHref} className="focus-ring inline-flex min-h-11 items-center rounded font-semibold text-primary-text underline-offset-2 hover:underline">
          Back to sign in
        </a>
      </p>
    </form>
  )
}

/** The page: sends the request through `handlers` and keeps the status token for this tab. */
export function RequestPage({ handlers, signInHref }: { handlers: PasswordHelpHandlers; signInHref: string }) {
  const [state, setState] = useState<RequestFormState>({ kind: 'editing' })
  const send = (username: string) => {
    setState({ kind: 'sending' })
    // A new request replaces any token this tab kept from an earlier one.
    forgetStatusToken()
    handlers.requestReset(username).then(
      (outcome) => {
        if (outcome.kind === 'accepted') keepStatusToken(outcome.statusToken)
        setState({ kind: requestAnswer(outcome) })
      },
      () => setState({ kind: 'error' }),
    )
  }
  return (
    <PasswordHelpLayout
      title="Forgot your password?"
      intro={
        state.kind === 'sent'
          ? undefined
          : "Ask your administrator to reset it. Enter your username and send the request; after it's approved, you'll get an email with a link to set a new password."
      }
    >
      <RequestView state={state} onSubmit={send} signInHref={signInHref} />
    </PasswordHelpLayout>
  )
}
