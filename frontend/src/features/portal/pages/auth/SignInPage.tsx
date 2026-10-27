import { LogIn } from 'lucide-react'
import { useState } from 'react'
import { Alert, Button } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { Link } from '../../router'
import { AuthLayout } from './AuthLayout'

/**
 * `expired`: the idle limit passed (the timer, confirmed with the server). `ended`: the server
 * ended the session for another reason it doesn't say (a `401`: staff disabled the account, D92,
 * or it ended elsewhere), so the message makes no claim about why.
 */
export type SignedOutReason = 'signed-out' | 'expired' | 'ended'

/**
 * Sign-in happens at the patient Keycloak realm, with multi-factor (D85): this page only starts it,
 * with a full-page move to `GET /portal/auth/login`. Passwords, reset and username recovery belong
 * to the realm, so nothing here asks for them (D3).
 */
export function SignInPage({ reason }: { reason?: SignedOutReason }) {
  const api = usePortalApi()
  const [busy, setBusy] = useState(false)

  return (
    <AuthLayout title="Sign in" intro="Welcome. Sign in to see your health information.">
      <div className="space-y-4">
        {reason === 'expired' ? <Alert tone="info" title="You were signed out after 15 minutes without activity, to protect your information." /> : null}
        {reason === 'ended' ? <Alert tone="info" title="Your session has ended. Please sign in again." /> : null}
        {reason === 'signed-out' ? <Alert tone="success" title="You have signed out." /> : null}

        <p className="text-sm text-ink-muted">You'll sign in on our secure sign-in page, then confirm it's you with an authenticator app on your phone.</p>
        <Button
          loading={busy}
          className="w-full"
          size="lg"
          icon={<LogIn aria-hidden="true" size={18} />}
          onClick={() => {
            // The page is leaving for the sign-in page; the button stays busy until it does.
            setBusy(true)
            api.startSignIn()
          }}
        >
          Sign in
        </Button>
        <p className="text-sm text-ink-muted">Forgot your password? Choose "Forgot password" on the sign-in page.</p>
      </div>

      <div className="mt-6 border-t border-border-soft pt-5 text-sm text-ink-muted">
        <p className="font-semibold text-ink">New to the portal?</p>
        <p className="mt-1">Ask your clinic's front desk for an invitation code. They'll check your ID first.</p>
        <Link to="/set-up-account" className="mt-1 inline-flex min-h-11 items-center font-semibold text-primary-700 underline-offset-2 hover:underline">
          Set up your account
        </Link>
      </div>
    </AuthLayout>
  )
}
