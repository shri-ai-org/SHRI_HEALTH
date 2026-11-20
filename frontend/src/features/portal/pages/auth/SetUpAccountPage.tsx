import { MailQuestion } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { newIdempotencyKey } from '../../../../api/client'
import { Alert, Button, DateInput, Field, problemCopy } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { toProblem } from '../../api/useResource'
import { Link } from '../../router'
import { ErrorSummary } from '../../ui'
import { AuthLayout } from './AuthLayout'

type FieldId = 'birth-date'

/** The one answer for every refused link (D124), so invitations, accounts and charts can't be probed. */
const COULD_NOT_USE = "We couldn't use this invitation. Check your date of birth, or ask your clinic's front desk to send a new invitation"

/**
 * The invitation token from the emailed link, `/portal/invite#t=…` (D124). It is read from the
 * URL fragment only, which the browser never sends to a server, and never from a query string
 * (D13). The page keeps it in memory and takes it out of the address bar at once.
 */
function tokenFromFragment(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('t')?.trim() ?? ''
}

/**
 * "Set up your account" (D124, amending D85 and ADR-0013 §3): the patient opened the invitation the
 * front desk emailed after an ID check, and confirms their date of birth (`POST /portal/enrollments`).
 * Our API creates the patient-realm account and answers with Keycloak's one-time set-password page,
 * where they choose a password and set up the second sign-in step; there is no second email.
 */
export function SetUpAccountPage() {
  const api = usePortalApi()
  const [token] = useState(tokenFromFragment)
  // `YYYY-MM-DD`, `null` when typed but not a real date, `''` when empty.
  const [birthDate, setBirthDate] = useState<string | null>('')
  // One key per answer: a retry after a network error resends the same request, and an edit makes
  // it a new one.
  const [key, setKey] = useState(newIdempotencyKey)
  const [errors, setErrors] = useState<Array<{ fieldId: FieldId; message: string }>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The token stays out of the address bar, the history and anything copied from it.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure(null)
    if (birthDate === null || !birthDate) {
      setErrors([{ fieldId: 'birth-date', message: 'Enter your date of birth as MM/DD/YYYY' }])
      return
    }
    setErrors([])
    setBusy(true)
    try {
      const result = await api.enroll({ invitationToken: token, birthDate }, key)
      api.openSetPassword(result.redirectUrl)
    } catch (err) {
      const p = toProblem(err)
      // Any refusal of the link or the date of birth reads the same (D124).
      if (p.status === 422) setErrors([{ fieldId: 'birth-date', message: COULD_NOT_USE }])
      else if (p.status === 429) setFailure('Too many attempts. Wait a few minutes, then try again.')
      else setFailure(problemCopy(p).message)
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Set up your account" intro="You set up your account from the invitation your clinic emailed you.">
        <div className="space-y-4">
          <Alert tone="info" title="Open the link in your invitation email">
            <p>This page needs the link from that email. If you can't find it, or it has expired, ask your clinic's front desk to send a new invitation.</p>
          </Alert>
          <p className="flex items-start gap-2 text-sm text-ink-muted">
            <MailQuestion aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
            No email? Check your spam folder.
          </p>
          <Link to="/sign-in" className="inline-flex min-h-11 items-center font-semibold text-primary-700 underline-offset-2 hover:underline">
            Already set up? Sign in
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const err = (id: FieldId) => errors.find((x) => x.fieldId === id)?.message

  return (
    <AuthLayout title="Set up your account" intro="Confirm your date of birth. Next you'll choose a password and set up a second sign-in step.">
      <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
        <ErrorSummary errors={errors} />
        {failure ? <Alert tone="critical" title="Couldn't set up your account">{failure}</Alert> : null}
        <Field id="birth-date" label="Date of birth" hint="MM/DD/YYYY" required error={err('birth-date')}>
          {(p) => (
            <DateInput
              {...p}
              value=""
              onValueChange={(v) => {
                setBirthDate(v)
                setKey(newIdempotencyKey())
              }}
            />
          )}
        </Field>
        <Button type="submit" loading={busy} className="w-full" size="lg">
          Continue
        </Button>
        <p className="text-sm text-ink-muted">
          Already set up?{' '}
          <Link to="/sign-in" className="inline-flex min-h-11 items-center font-medium text-primary-700 underline-offset-2 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  )
}
