import { Smartphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { PortalSession } from '../../../../api/generated/model'
import { Alert, Button, DateInput, Field, problemCopy, TextInput } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { toProblem } from '../../api/useResource'
import { ErrorSummary } from '../../ui'

type FieldId = 'demo-mobile' | 'demo-birth-date'

/** The one answer for every refusal (D121), so charts can't be probed. */
const COULD_NOT = "We couldn't sign you in with those details. Check your mobile number and date of birth, or ask your clinic's front desk."

/**
 * Demo sign-in (D121, demo servers only, synthetic patients): a newly registered patient signs in
 * with the mobile number on their chart and their date of birth, with no code and no password
 * (`POST /portal/auth/demo-sign-in`). The server opens the portal session (an HttpOnly cookie) and
 * returns it; `onSignedIn` takes the patient into the portal. Shown only in a build with
 * `VITE_FEATURE_DEMO_SIGN_IN=on` (demoSignInOn); the server refuses it everywhere else too.
 */
export function DemoSignInForm({ onSignedIn }: { onSignedIn: (session: PortalSession) => void }) {
  const api = usePortalApi()
  const [mobile, setMobile] = useState('')
  // `YYYY-MM-DD`, `null` when typed but not a real date, `''` when empty.
  const [birthDate, setBirthDate] = useState<string | null>('')
  const [errors, setErrors] = useState<Array<{ fieldId: FieldId; message: string }>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure(null)
    const found: typeof errors = []
    const digits = mobile.replace(/[^0-9]/g, '')
    if (digits.length < 10 || digits.length > 15) found.push({ fieldId: 'demo-mobile', message: 'Enter your mobile number, for example (408) 555-0142' })
    if (birthDate === null || !birthDate) found.push({ fieldId: 'demo-birth-date', message: 'Enter your date of birth as MM/DD/YYYY' })
    setErrors(found)
    if (found.length || !birthDate) return
    setBusy(true)
    try {
      onSignedIn(await api.demoSignIn({ mobileNumber: mobile.trim(), birthDate }))
    } catch (err) {
      const p = toProblem(err)
      // Every refusal is the one 401 (#458, #461); 422 is kept for a server that still answers it, so
      // the two can merge in either order. Neither says which detail was wrong.
      if (p.status === 401 || p.status === 422) setErrors([{ fieldId: 'demo-mobile', message: COULD_NOT }])
      else if (p.status === 429) setFailure('Too many attempts. Wait a few minutes, then try again.')
      else setFailure(problemCopy(p).message)
    } finally {
      setBusy(false)
    }
  }

  const err = (id: FieldId) => errors.find((x) => x.fieldId === id)?.message

  return (
    <section aria-labelledby="demo-sign-in-heading" className="space-y-4">
      <div>
        <h2 id="demo-sign-in-heading" className="flex items-center gap-2 text-base font-semibold text-ink">
          <Smartphone aria-hidden="true" size={18} />
          Demo sign-in
        </h2>
        <p className="mt-1 text-sm text-ink-muted">New patient? Sign in with the mobile number you gave the front desk and your date of birth.</p>
      </div>
      <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
        <ErrorSummary errors={errors} />
        {failure ? <Alert tone="critical" title="Couldn't sign you in">{failure}</Alert> : null}
        <Field id="demo-mobile" label="Mobile number" hint="For example (408) 555-0142" required error={err('demo-mobile')}>
          {(p) => <TextInput {...p} type="tel" inputMode="tel" autoComplete="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} />}
        </Field>
        <Field id="demo-birth-date" label="Date of birth" hint="MM/DD/YYYY" required error={err('demo-birth-date')}>
          {(p) => <DateInput {...p} value="" onValueChange={setBirthDate} />}
        </Field>
        <Button type="submit" loading={busy} className="w-full" size="lg">
          Sign in with my mobile number
        </Button>
      </form>
    </section>
  )
}
