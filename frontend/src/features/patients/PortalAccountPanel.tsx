import { KeyRound, Printer, Send } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import {
  createPortalInvitation,
  disablePortalAccount,
  enablePortalAccount,
  getPortalAccount,
  resetPortalSignInFactors,
  revokePortalInvitation,
} from '../../api/generated/endpoints/patients/patients'
import type { PortalAccountStatus, PortalAccountStatusStatus, PortalInvitation } from '../../api/generated/model'
import { Badge, Button, ConfirmDialog, Field, formatDateTime, isOverLimit, Modal, ProblemAlert, Spinner, Textarea, useToast, type BadgeTone, type Problem } from '../../design-system'

/** Staff times have no facility here; they show in the workstation's zone. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const REASON_LIMIT = 500

const STATUS: Record<PortalAccountStatusStatus, { label: string; tone: BadgeTone; text: string }> = {
  none: { label: 'No account', tone: 'neutral', text: 'The patient has no portal account. Issue an invitation after checking their photo ID.' },
  invited: { label: 'Invited', tone: 'info', text: 'An invitation is waiting to be used. Issuing a new one cancels it.' },
  'pending-setup': { label: 'Setting up', tone: 'info', text: 'The patient used the code and is finishing set-up (email, password, authenticator app).' },
  active: { label: 'Active', tone: 'success', text: 'The patient can sign in to the portal.' },
  disabled: { label: 'Disabled', tone: 'warning', text: 'The patient cannot sign in. Enable the account to let them sign in again.' },
  suspended: {
    label: 'Suspended: chart merged',
    tone: 'warning',
    text: 'This chart was merged into another, so nobody can sign in with this account. Issue a new invitation on the surviving chart after an ID check. Undoing the merge restores this account.',
  },
}

type Action = 'invite' | 'revoke' | 'reset' | 'disable' | 'enable'

/**
 * The patient's portal account as the front desk sees it (ADR-0013, D85, D92; inventory B8a):
 * never a password, factor or code, except the new invitation code, shown once when it is issued.
 * Issuing an invitation and resetting sign-in factors both need an in-person photo ID check.
 */
export function PortalAccountPanel({ patientId }: { patientId: string }) {
  const [account, setAccount] = useState<PortalAccountStatus | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  // The invitation being revoked, kept from when the dialog opened: a refusal reads the account
  // again behind the dialog, and the dialog must stay to show why.
  const [revoking, setRevoking] = useState<string | null>(null)
  const [issued, setIssued] = useState<PortalInvitation | null>(null)
  // Bumped after any change, to read the account again.
  const [version, setVersion] = useState(0)
  const reload = () => setVersion((v) => v + 1)

  useEffect(() => {
    let current = true
    getPortalAccount(patientId)
      .then((res) => {
        if (!current || res.status !== 200) return
        setAccount(res.data)
        setProblem(null)
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setProblem(error.problem)
        else throw error
      })
    return () => {
      current = false
    }
  }, [patientId, version])

  const done = () => {
    setAction(null)
    reload()
  }

  return (
    <section aria-labelledby="portal-account-title" className="space-y-3">
      <h2 id="portal-account-title" className="text-lg font-semibold text-ink">
        Portal account
      </h2>
      {problem ? <ProblemAlert problem={problem} /> : null}
      {!account && !problem ? <Spinner label="Loading the portal account" /> : null}
      {account ? (
        <AccountCard
          account={account}
          onAction={(a) => {
            if (a === 'revoke') setRevoking(account.invitation?.id ?? null)
            setAction(a)
          }}
        />
      ) : null}

      {action === 'invite' ? (
        <IdCheckDialog
          title={account?.status === 'invited' ? 'Issue a new invitation?' : 'Issue a portal invitation?'}
          confirmLabel="Issue invitation"
          description={account?.status === 'invited' ? 'The invitation already issued stops working.' : 'The code works once, for 72 hours.'}
          onClose={() => setAction(null)}
          onStale={reload}
          run={async () => {
            const res = await createPortalInvitation(patientId, { idChecked: true })
            if (res.status === 201) {
              setIssued(res.data)
              done()
            }
          }}
        />
      ) : null}
      {action === 'reset' ? (
        <IdCheckDialog
          title="Reset the patient's sign-in factors?"
          confirmLabel="Reset sign-in factors"
          description="The patient's authenticator app stops working for this account. They set up a new one at their next sign-in. Their password doesn't change."
          withNote
          onClose={() => setAction(null)}
          onStale={reload}
          run={async (note) => {
            const res = await resetPortalSignInFactors(patientId, { idChecked: true, ...(note ? { note } : {}) })
            if (res.status === 200) done()
          }}
          doneMessage="Sign-in factors reset"
        />
      ) : null}
      {action === 'revoke' && revoking ? <RevokeDialog patientId={patientId} invitationId={revoking} onClose={() => setAction(null)} onDone={done} onStale={reload} /> : null}
      {action === 'disable' || action === 'enable' ? (
        <ReasonDialog patientId={patientId} kind={action} onClose={() => setAction(null)} onDone={done} onStale={reload} />
      ) : null}
      {issued ? <InvitationDialog invitation={issued} onClose={() => setIssued(null)} /> : null}
    </section>
  )
}

function AccountCard({ account, onAction }: { account: PortalAccountStatus; onAction: (a: Action) => void }) {
  const s = STATUS[account.status]
  const enrolled = account.status === 'active' || account.status === 'pending-setup'
  const facts: Array<[string, ReactNode]> = [
    ...(enrolled || account.status === 'disabled' ? ([['Sign-in email', account.email ?? 'Email unavailable']] as Array<[string, ReactNode]>) : []),
    ...(account.status === 'invited' && account.invitation
      ? ([
          ['Invitation issued', formatDateTime(account.invitation.issuedAt, LOCAL_TZ)],
          ['Expires', formatDateTime(account.invitation.expiresAt, LOCAL_TZ)],
        ] as Array<[string, ReactNode]>)
      : []),
    ...(account.enrolledAt ? ([['Enrolled', formatDateTime(account.enrolledAt, LOCAL_TZ)]] as Array<[string, ReactNode]>) : []),
    ...(account.factorsResetAt ? ([['Sign-in factors last reset', formatDateTime(account.factorsResetAt, LOCAL_TZ)]] as Array<[string, ReactNode]>) : []),
    ...(account.disabledAt ? ([['Disabled', formatDateTime(account.disabledAt, LOCAL_TZ)]] as Array<[string, ReactNode]>) : []),
  ]

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.tone}>{s.label}</Badge>
        <p className="text-sm text-ink-muted">{s.text}</p>
      </div>
      {facts.length ? (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          {facts.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-ink-subtle">{term}</dt>
              <dd className="text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {account.status === 'none' || account.status === 'invited' ? (
          <Button variant="outline" icon={<Send aria-hidden="true" size={16} />} onClick={() => onAction('invite')}>
            {account.status === 'invited' ? 'Issue new invitation' : 'Issue invitation'}
          </Button>
        ) : null}
        {account.status === 'invited' && account.invitation ? (
          <Button variant="ghost" onClick={() => onAction('revoke')}>
            Revoke invitation
          </Button>
        ) : null}
        {enrolled ? (
          <Button variant="outline" icon={<KeyRound aria-hidden="true" size={16} />} onClick={() => onAction('reset')}>
            Reset sign-in factors
          </Button>
        ) : null}
        {/* D92: disable and enable are ADM only; the server refuses anyone else with a 403. */}
        {enrolled || account.status === 'suspended' ? (
          <Button variant="ghost" onClick={() => onAction('disable')}>
            Disable account
          </Button>
        ) : null}
        {account.status === 'disabled' ? (
          <Button variant="outline" onClick={() => onAction('enable')}>
            Enable account
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The front desk confirms the photo ID check in person before an invitation or a factor reset (ADR-0013 §2, §3). */
function IdCheckDialog({
  title,
  confirmLabel,
  description,
  withNote = false,
  doneMessage,
  run,
  onClose,
  onStale,
}: {
  title: string
  confirmLabel: string
  description: string
  withNote?: boolean
  doneMessage?: string
  run: (note: string) => Promise<void>
  onClose: () => void
  onStale: () => void
}) {
  const toast = useToast()
  const [checked, setChecked] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const checkRef = useRef<HTMLInputElement>(null)

  async function confirm() {
    if (!checked) return setError("Check the patient's photo ID in person first.")
    if (isOverLimit(note.trim(), REASON_LIMIT)) return setError(`Shorten the note to ${REASON_LIMIT} characters or fewer.`)
    setError(null)
    setProblem(null)
    setBusy(true)
    try {
      await run(note.trim())
      if (doneMessage) toast.show(doneMessage)
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      setProblem(e.problem)
      if (e.status === 409) onStale()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      initialFocus={checkRef}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>{description}</p>
        <label className="flex items-start gap-2 text-sm">
          <input ref={checkRef} type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} aria-describedby={error ? 'id-check-error' : undefined} />
          I checked the patient's photo ID in person.
        </label>
        {error ? (
          <p id="id-check-error" className="text-sm text-critical-fg">
            {error}
          </p>
        ) : null}
        {withNote ? (
          <Field label="Note" hint="Optional. Never the ID number.">
            {(p) => <Textarea {...p} value={note} limit={REASON_LIMIT} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        ) : null}
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </Modal>
  )
}

function RevokeDialog({ patientId, invitationId, onClose, onDone, onStale }: { patientId: string; invitationId: string; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  return (
    <ConfirmDialog
      open
      title="Revoke this invitation?"
      confirmLabel="Revoke invitation"
      cancelLabel="Keep it"
      confirmVariant="danger"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true)
        setProblem(null)
        revokePortalInvitation(patientId, invitationId)
          .then((res) => {
            if (res.status === 200) {
              toast.show('Invitation revoked')
              onDone()
            }
          })
          .catch((e: unknown) => {
            if (!(e instanceof ApiError)) throw e
            setProblem(e.problem)
            if (e.status === 409) onStale()
          })
          .finally(() => setBusy(false))
      }}
    >
      <div className="space-y-3">
        <p>The code stops working at once, for example when the printout was lost.</p>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </ConfirmDialog>
  )
}

/** Disable or enable (D92): a reason is required and audited; it is never shown to the patient. */
function ReasonDialog({ patientId, kind, onClose, onDone, onStale }: { patientId: string; kind: 'disable' | 'enable'; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  async function confirm() {
    const text = reason.trim()
    if (!text) return setError(kind === 'disable' ? 'Say why the account is being disabled.' : 'Say why the account is being enabled again.')
    if (isOverLimit(text, REASON_LIMIT)) return setError(`Shorten the reason to ${REASON_LIMIT} characters or fewer.`)
    setError(null)
    setProblem(null)
    setBusy(true)
    try {
      const res = kind === 'disable' ? await disablePortalAccount(patientId, { reason: text }) : await enablePortalAccount(patientId, { reason: text })
      if (res.status === 200) {
        toast.show(kind === 'disable' ? 'Portal account disabled' : 'Portal account enabled')
        onDone()
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      setProblem(e.problem)
      if (e.status === 409) onStale()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={kind === 'disable' ? 'Disable the portal account?' : 'Enable the portal account?'}
      onClose={onClose}
      initialFocus={reasonRef}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={kind === 'disable' ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()}>
            {kind === 'disable' ? 'Disable account' : 'Enable account'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>
          {kind === 'disable'
            ? 'The patient is signed out of the portal at once and cannot sign in until the account is enabled again.'
            : 'The patient can sign in again with their existing password and authenticator app.'}
        </p>
        <Field label="Reason" hint="Recorded for audit; the patient never sees it" required error={error ?? undefined}>
          {(p) => <Textarea {...p} ref={reasonRef} value={reason} limit={REASON_LIMIT} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </Modal>
  )
}

/**
 * The new code, shown once (it is in the issue response only): print it for the patient now. It
 * is never stored in the browser; closing the dialog drops it.
 */
function InvitationDialog({ invitation, onClose }: { invitation: PortalInvitation; onClose: () => void }) {
  const expires = formatDateTime(invitation.expiresAt, LOCAL_TZ)
  return (
    <Modal
      open
      title="Portal invitation"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
          <Button icon={<Printer aria-hidden="true" size={16} />} onClick={() => printInvitation(invitation.code, expires)}>
            Print invitation
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>Give the patient this code. It works once, until {expires}. This is the only time it is shown.</p>
        <p className="rounded-lg bg-surface-2 py-4 text-center font-mono text-2xl font-semibold tracking-widest text-ink" aria-label={`Invitation code ${invitation.code.split('').join(' ')}`}>
          {invitation.code}
        </p>
        <p className="text-sm text-ink-muted">The patient goes to the portal, chooses "Set up your account" and enters the code, their date of birth and their email.</p>
      </div>
    </Modal>
  )
}

/** A plain page with only the code and the steps (no patient data), printed from its own window. */
function printInvitation(code: string, expires: string) {
  const w = window.open('', '_blank', 'width=640,height=520')
  if (!w) return
  const doc = w.document
  doc.title = 'Portal invitation'
  const add = (tag: string, text: string, style = '') => {
    const el = doc.createElement(tag)
    el.textContent = text
    if (style) el.setAttribute('style', style)
    doc.body.append(el)
  }
  doc.body.setAttribute('style', 'font-family: system-ui, sans-serif; margin: 2rem')
  add('h1', 'Your patient portal invitation', 'font-size: 1.4rem')
  add('p', 'Your invitation code:')
  add('p', code, 'font-family: monospace; font-size: 2rem; letter-spacing: 0.2em; font-weight: 600')
  add('p', `It works once, until ${expires}.`)
  add('p', 'Go to the patient portal, choose "Set up your account", and enter this code, your date of birth and your email address. We then email you a link to choose a password and set up an authenticator app.')
  add('p', 'Keep this paper private. If you lose it, ask the front desk for a new code.')
  w.focus()
  w.print()
}
