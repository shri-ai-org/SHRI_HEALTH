import { useState, type FormEvent } from 'react'
import { Alert, Button, DateInput, Field, isValidZip, PhoneInput, problemCopy, TextInput } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { toProblem } from '../../api/useResource'
import { useRouter } from '../../router'
import { ErrorSummary } from '../../ui'
import { AuthLayout } from './AuthLayout'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The same answer whether or not an account matched, so the page cannot be used to find accounts. */
function SentNotice({ what }: { what: string }) {
  const { navigate } = useRouter()
  return (
    <>
      <Alert tone="success" title="Check your email">
        If the details match a portal account, we've sent {what}. It can take a few minutes; check your spam folder too.
      </Alert>
      <Button className="mt-5 w-full" size="lg" onClick={() => navigate('/sign-in')}>
        OK
      </Button>
    </>
  )
}

/** Old "Username Recovery": first name, last name, date of birth, email, ZIP code and phone. */
export function ForgotUsernamePage() {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [d, setD] = useState({ firstName: '', lastName: '', birthDate: '' as string | null, email: '', postalCode: '', phone: '' as string | null })
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((x) => ({ ...x, [k]: v }))
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!d.firstName.trim()) found.push({ fieldId: 'fu-first', message: 'Enter your first name' })
    if (!d.lastName.trim()) found.push({ fieldId: 'fu-last', message: 'Enter your last name' })
    if (!d.birthDate) found.push({ fieldId: 'fu-dob', message: 'Enter your date of birth as MM/DD/YYYY' })
    if (!EMAIL.test(d.email.trim())) found.push({ fieldId: 'fu-email', message: 'Enter a valid email address' })
    if (!isValidZip(d.postalCode.trim())) found.push({ fieldId: 'fu-zip', message: 'Enter a valid ZIP code' })
    if (!d.phone) found.push({ fieldId: 'fu-phone', message: 'Enter a valid 10-digit phone number' })
    setErrors(found)
    if (found.length || !d.birthDate || !d.phone) return
    setBusy(true)
    setFailure(null)
    try {
      await api.requestUsernameReminder({ firstName: d.firstName.trim(), lastName: d.lastName.trim(), birthDate: d.birthDate, email: d.email.trim(), postalCode: d.postalCode.trim(), phone: d.phone })
      setSent(true)
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Username Recovery" intro="Recover your patient portal username. Please enter your personal information.">
      {sent ? (
        <SentNotice what="your username" />
      ) : (
        <form noValidate onSubmit={submit} className="space-y-4">
          <ErrorSummary errors={errors} />
          {failure ? <Alert tone="critical" title="Couldn't send the email">{failure}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="fu-first" label="First Name" required error={err('fu-first')}>
              {(p) => <TextInput {...p} autoComplete="given-name" value={d.firstName} onChange={(e) => set('firstName', e.target.value)} />}
            </Field>
            <Field id="fu-last" label="Last Name" required error={err('fu-last')}>
              {(p) => <TextInput {...p} autoComplete="family-name" value={d.lastName} onChange={(e) => set('lastName', e.target.value)} />}
            </Field>
            <Field id="fu-dob" label="Date of Birth" hint="MM/DD/YYYY" required error={err('fu-dob')}>
              {(p) => <DateInput {...p} autoComplete="bday" value="" onValueChange={(v) => set('birthDate', v)} />}
            </Field>
            <Field id="fu-email" label="Email" required error={err('fu-email')}>
              {(p) => <TextInput {...p} type="email" autoComplete="email" value={d.email} onChange={(e) => set('email', e.target.value)} />}
            </Field>
            <Field id="fu-zip" label="ZIP Code" required error={err('fu-zip')}>
              {(p) => <TextInput {...p} inputMode="numeric" autoComplete="postal-code" maxLength={10} value={d.postalCode} onChange={(e) => set('postalCode', e.target.value)} />}
            </Field>
            <Field id="fu-phone" label="Phone Number" required error={err('fu-phone')}>
              {(p) => <PhoneInput {...p} value="" onValueChange={(v) => set('phone', v)} />}
            </Field>
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => navigate('/sign-in')}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} size="lg">
              Submit
            </Button>
          </div>
        </form>
      )}
    </AuthLayout>
  )
}

/** Old "Need help with your password?": the portal email, then a reset link. */
export function ForgotPasswordPage() {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found = EMAIL.test(email.trim()) ? [] : [{ fieldId: 'fp-email', message: 'Enter a valid email address' }]
    setErrors(found)
    if (found.length) return
    setBusy(true)
    setFailure(null)
    try {
      await api.requestPasswordReset({ email: email.trim() })
      setSent(true)
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Need help with your password?" intro="Enter the email address you use for the patient portal, and we'll send you a link to reset your password.">
      {sent ? (
        <SentNotice what="a reset link (it works for 1 hour)" />
      ) : (
        <form noValidate onSubmit={submit} className="space-y-4">
          <ErrorSummary errors={errors} />
          {failure ? <Alert tone="critical" title="Couldn't send the email">{failure}</Alert> : null}
          <Field id="fp-email" label="Email" required error={errors[0]?.message}>
            {(p) => <TextInput {...p} type="email" autoComplete="email" placeholder="Your email address" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => navigate('/sign-in')}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} size="lg">
              Send My Reset Link
            </Button>
          </div>
        </form>
      )}
    </AuthLayout>
  )
}
