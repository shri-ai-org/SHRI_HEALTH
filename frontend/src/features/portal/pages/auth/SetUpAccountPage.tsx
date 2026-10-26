import { MailCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Alert, Button, DateInput, Field, problemCopy, TextInput } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { toProblem } from '../../api/useResource'
import { Link } from '../../router'
import { ErrorSummary } from '../../ui'
import { AuthLayout } from './AuthLayout'

type FieldId = 'invitation-code' | 'birth-date' | 'email'

/** The one answer for every failed code (ADR-0013 §3), so codes, accounts and charts can't be probed. */
const COULD_NOT_USE = "We couldn't use that code. Check the code and your date of birth, or ask your clinic's front desk for a new code"

/**
 * "Set up your account" (ADR-0013 §3, D85): the patient redeems the invitation code from the front
 * desk with their date of birth and the email they want to use (`POST /portal/enrolments`). Our API
 * creates the patient-realm account, and Keycloak emails a link to verify the email, choose a
 * password and set up the second sign-in step. Sign-in comes after that; there is no
 * self-registration in the realm.
 */
export function SetUpAccountPage() {
  const api = usePortalApi()
  const [code, setCode] = useState('')
  // `YYYY-MM-DD`, `null` when typed but not a real date, `''` when empty.
  const [birthDate, setBirthDate] = useState<string | null>('')
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<Array<{ fieldId: FieldId; message: string }>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure(null)
    const found: typeof errors = []
    if (!code.trim()) found.push({ fieldId: 'invitation-code', message: 'Enter the invitation code from your clinic' })
    if (birthDate === null || !birthDate) found.push({ fieldId: 'birth-date', message: 'Enter your date of birth as MM/DD/YYYY' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found.push({ fieldId: 'email', message: 'Enter an email address like name@example.com' })
    setErrors(found)
    if (found.length || !birthDate) return
    setBusy(true)
    try {
      await api.enrol({ invitationCode: code.trim(), birthDate, email: email.trim() })
      setSent(true)
    } catch (err) {
      const p = toProblem(err)
      // Any refusal of the code, date of birth or email reads the same.
      if (p.status === 422 || p.status === 404) setErrors([{ fieldId: 'invitation-code', message: COULD_NOT_USE }])
      else setFailure(problemCopy(p).message)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthLayout title="Check your email" intro="One more step to finish setting up your account.">
        <div className="space-y-4">
          <Alert tone="success" title="We've sent you an email">
            <p>Open the link in it within 12 hours. You'll confirm your email address, choose a password and set up a second sign-in step, such as an app on your phone or a security key.</p>
          </Alert>
          <p className="flex items-start gap-2 text-sm text-ink-muted">
            <MailCheck aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
            No email after a few minutes? Check your spam folder, or call your clinic's front desk.
          </p>
          <Link to="/sign-in" className="inline-flex min-h-11 items-center font-semibold text-primary-700 underline-offset-2 hover:underline">
            Go to sign in
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const err = (id: FieldId) => errors.find((x) => x.fieldId === id)?.message

  return (
    <AuthLayout title="Set up your account" intro="Use the invitation code your clinic's front desk gave you. You only do this once.">
      <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
        <ErrorSummary errors={errors} />
        {failure ? <Alert tone="critical" title="Couldn't set up your account">{failure}</Alert> : null}
        <Field id="invitation-code" label="Invitation code" hint="For example ABCD-1234-EFGH" required error={err('invitation-code')}>
          {(p) => <TextInput {...p} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field id="birth-date" label="Date of birth" hint="MM/DD/YYYY" required error={err('birth-date')}>
          {(p) => <DateInput {...p} value="" onValueChange={setBirthDate} />}
        </Field>
        <Field id="email" label="Email address" hint="You'll sign in with it, and we'll send the setup link there" required error={err('email')}>
          {(p) => <TextInput {...p} type="email" autoComplete="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} className="w-full" size="lg">
          Set up my account
        </Button>
        <p className="text-sm text-ink-muted">
          Already set up?{' '}
          <Link to="/sign-in" className="inline-flex min-h-11 items-center font-medium text-primary-700 underline-offset-2 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
      {import.meta.env.DEV ? (
        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-subtle">
          {/* Kept in step with MOCK_INVITATION_CODE and the mock patient; screens import nothing from the mock. */}
          Mock mode (synthetic data): code <code>TEST-CODE-1234</code> with date of birth 07/19/1984 and any email.
        </p>
      ) : null}
    </AuthLayout>
  )
}
