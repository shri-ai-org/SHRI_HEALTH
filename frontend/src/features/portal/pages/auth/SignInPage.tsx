import { LogIn } from 'lucide-react'
import { useState } from 'react'
import { Alert, Button, problemCopy } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { PortalSession } from '../../api/types'
import { toProblem } from '../../api/useResource'
import { AuthLayout } from './AuthLayout'

export type SignedOutReason = 'signed-out' | 'expired'

/**
 * Sign-in happens at the patient Keycloak realm, with multi-factor (D85): this page only starts it.
 * Passwords, reset and username recovery belong to the realm, so nothing here asks for them (D3).
 */
export function SignInPage({ reason, onSignedIn }: { reason?: SignedOutReason; onSignedIn: (s: PortalSession) => void }) {
  const api = usePortalApi()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function signIn() {
    setBusy(true)
    setFailure(null)
    try {
      onSignedIn(await api.signIn())
    } catch (err) {
      setFailure(problemCopy(toProblem(err)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Sign in" intro="Welcome. Sign in to see your health information.">
      <div className="space-y-4">
        {reason === 'expired' ? <Alert tone="info" title="You were signed out after 15 minutes without activity, to protect your information." /> : null}
        {reason === 'signed-out' ? <Alert tone="success" title="You have signed out." /> : null}
        {failure ? <Alert tone="critical" title="Couldn't start sign-in">{failure}</Alert> : null}

        <p className="text-sm text-ink-muted">You'll sign in on our secure sign-in page, then confirm it's you with your phone or a security key.</p>
        <Button loading={busy} className="w-full" size="lg" icon={<LogIn aria-hidden="true" size={18} />} onClick={() => void signIn()}>
          Sign in
        </Button>
        <p className="text-sm text-ink-muted">Forgot your password? Choose "Forgot password" on the sign-in page.</p>
      </div>

      <div className="mt-6 border-t border-border-soft pt-5 text-sm text-ink-muted">
        <p className="font-semibold text-ink">New to the portal?</p>
        <p className="mt-1">Ask your clinic's front desk for an invitation code. They'll check your ID first. Then sign in here, and you'll enter the code once to open your record.</p>
      </div>

      {import.meta.env.DEV ? (
        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-subtle">Mock mode (synthetic data): Sign in stands for a completed sign-in at the patient realm.</p>
      ) : null}
    </AuthLayout>
  )
}
