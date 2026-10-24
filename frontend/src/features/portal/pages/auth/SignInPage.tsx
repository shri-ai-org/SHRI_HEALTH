import { Eye, EyeOff } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Alert, Button, Field, TextInput, problemCopy } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { PortalSession } from '../../api/types'
import { toProblem } from '../../api/useResource'
import { Link } from '../../router'
import { ErrorSummary } from '../../ui'
import { AuthLayout } from './AuthLayout'

export type SignedOutReason = 'signed-out' | 'expired'

export function SignInPage({ reason, onSignedIn }: { reason?: SignedOutReason; onSignedIn: (s: PortalSession) => void }) {
  const api = usePortalApi()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [failure, setFailure] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!username.trim()) found.push({ fieldId: 'username', message: 'Enter your username' })
    if (!password) found.push({ fieldId: 'password', message: 'Enter your password' })
    setErrors(found)
    setFailure(null)
    if (found.length) return
    setBusy(true)
    try {
      onSignedIn(await api.signIn(username.trim(), password))
    } catch (err) {
      const p = toProblem(err)
      // Never say which part was wrong: that would tell an attacker the username exists.
      setFailure(p.code === 'unauthenticated' ? "That username and password don't match our records. Check them and try again." : problemCopy(p).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message

  return (
    <AuthLayout title="Sign in" intro="Welcome back. Sign in to see your health information.">
      <form noValidate onSubmit={submit} className="space-y-4">
        {reason === 'expired' ? <Alert tone="info" title="You were signed out after 15 minutes without activity, to protect your information." /> : null}
        {reason === 'signed-out' ? <Alert tone="success" title="You have signed out." /> : null}
        <ErrorSummary errors={errors} />
        {failure ? <Alert tone="critical" title="Couldn't sign you in">{failure}</Alert> : null}

        <Field id="username" label="Username" required error={err('username')}>
          {(p) => <TextInput {...p} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />}
        </Field>
        <div>
          <Field id="password" label="Password" required error={err('password')}>
            {(p) => (
              <div className="relative">
                <TextInput
                  {...p}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="tap-target absolute top-0 right-0 inline-flex items-center justify-center rounded-lg text-ink-muted hover:text-ink"
                >
                  {showPassword ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
                </button>
              </div>
            )}
          </Field>
        </div>

        <Button type="submit" loading={busy} className="w-full" size="lg">
          Sign in
        </Button>

        <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
          <Link to="/forgot-username" className="inline-flex min-h-11 items-center font-medium text-primary-700 underline-offset-2 hover:underline">
            Forgot Username?
          </Link>
          <Link to="/forgot-password" className="inline-flex min-h-11 items-center font-medium text-primary-700 underline-offset-2 hover:underline">
            Forgot Password?
          </Link>
        </p>
      </form>

      <div className="mt-6 border-t border-border-soft pt-5 text-center text-sm text-ink-muted">
        New User?{' '}
        <Link to="/register" className="inline-flex min-h-11 items-center font-semibold text-primary-700 underline-offset-2 hover:underline">
          Registration
        </Link>
      </div>

      {import.meta.env.DEV ? (
        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-subtle">
          Mock mode (synthetic data): any username and password sign in. The password <code>wrong-password</code> shows the failed sign-in.
        </p>
      ) : null}
    </AuthLayout>
  )
}
