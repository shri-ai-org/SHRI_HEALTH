import { useState, type FormEvent } from 'react'
import { Alert, Button, Field, problemCopy, TextInput } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { PortalSession } from '../../api/types'
import { toProblem } from '../../api/useResource'
import { ErrorSummary } from '../../ui'
import { AuthLayout } from './AuthLayout'

/**
 * "Activate your account": the signed-in realm account is linked to the patient's chart once, with
 * the invitation code the front desk gave them after checking their ID (D85). Never by name and
 * date of birth. Nothing else in the portal opens until this is done.
 */
export function ActivatePage({ onActivated, onSignOut }: { onActivated: (s: PortalSession) => void; onSignOut: () => void }) {
  const api = usePortalApi()
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFailure(null)
    if (!code.trim()) return setErrors([{ fieldId: 'invitation-code', message: 'Enter the invitation code from your clinic' }])
    setErrors([])
    setBusy(true)
    try {
      onActivated(await api.activateAccount(code.trim()))
    } catch (err) {
      const p = toProblem(err)
      // One message for a wrong, used or expired code, so codes can't be probed.
      if (p.errors?.some((x) => x.pointer === '/invitationCode')) {
        setErrors([{ fieldId: 'invitation-code', message: "That code didn't work. Check it, or ask the front desk for a new one" }])
      } else {
        setFailure(problemCopy(p).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const err = errors.find((x) => x.fieldId === 'invitation-code')?.message

  return (
    <AuthLayout title="Activate your account" intro="Enter the invitation code your clinic gave you. You only do this once.">
      <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
        <ErrorSummary errors={errors} />
        {failure ? <Alert tone="critical" title="Couldn't activate your account">{failure}</Alert> : null}
        <Field id="invitation-code" label="Invitation code" hint="For example ABCD-1234-EFGH" required error={err}>
          {(p) => <TextInput {...p} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} className="w-full" size="lg">
          Activate
        </Button>
        <p className="text-sm text-ink-muted">
          No code, or it expired? Call your clinic's front desk.{' '}
          <button type="button" onClick={onSignOut} className="inline-flex min-h-11 items-center font-medium text-primary-700 underline-offset-2 hover:underline">
            Sign out
          </button>
        </p>
      </form>
      {import.meta.env.DEV ? (
        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-subtle">
          {/* Kept in step with MOCK_INVITATION_CODE; screens import nothing from the mock. */}
          Mock mode (synthetic data): the code <code>TEST-CODE-1234</code> activates the account.
        </p>
      ) : null}
    </AuthLayout>
  )
}
