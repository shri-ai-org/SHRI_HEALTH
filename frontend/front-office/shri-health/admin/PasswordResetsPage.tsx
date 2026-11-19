// SHRI_HEALTH: Administration > Password resets (#85): the administrator approves or declines the
// pending "Forgot password?" requests from staff and patients. Approve asks for confirmation first;
// decline takes an optional note the requester sees. Front office styling only. The view draws from
// its props and never calls the API; the page wires it to handlers (not connected until the
// contract is on main; synthetic requests on the development preview only).
import { KeyRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Alert } from '../../src/components/ui/Alert'
import { Badge } from '../../src/components/ui/Badge'
import { Button } from '../../src/components/ui/Button'
import { Card, CardBody, CardHeader } from '../../src/components/ui/Card'
import { Modal } from '../../src/components/ui/Modal'
import { ResponsiveTable, type Column } from '../../src/components/ui/ResponsiveTable'
import { TextAreaField } from '../../src/pages/register/fields'
import { when } from './format'
import { decisionProblem, devPreviewOn, maskedMobile, notYetConnected, type DecisionOutcome, type ListOutcome, type PasswordResetHandlers, type ResetRequestRow } from './passwordResets'
import { previewResetHandlers } from './passwordResetsPreview'

export type ListState = { kind: 'loading' } | ListOutcome

/** A message above the list after a decision: what happened, in the tone it deserves. */
export interface Notice {
  tone: 'stable' | 'warning' | 'critical'
  text: string
}

/** The open dialog: confirming an approval, or declining with a note. */
export type Dialog = { kind: 'approve'; row: ResetRequestRow } | { kind: 'decline'; row: ResetRequestRow } | null

const NOTE_MAX = 300

export interface PasswordResetsViewProps {
  list: ListState
  notice: Notice | null
  dialog: Dialog
  busy: boolean
  /** A 422 on the decline note, shown on the field. */
  noteError: string | null
  onRetry: () => void
  onAsk: (dialog: Exclude<Dialog, null>) => void
  onCancel: () => void
  onApprove: (row: ResetRequestRow) => void
  onDecline: (row: ResetRequestRow, note: string | undefined) => void
}

function columns(onAsk: PasswordResetsViewProps['onAsk']): Column<ResetRequestRow>[] {
  return [
    { key: 'name', header: 'Name', mobile: 'title', cell: (r) => <span className="font-medium text-ink">{r.displayName}</span> },
    { key: 'role', header: 'Role', mobile: 'subtitle', cell: (r) => r.role },
    { key: 'realm', header: 'Signs in to', cell: (r) => <Badge tone={r.realm === 'staff' ? 'info' : 'teal'}>{r.realm === 'staff' ? 'Staff' : 'Patient portal'}</Badge> },
    { key: 'username', header: 'Username', cell: (r) => r.username ?? '—' },
    {
      key: 'mobile',
      header: 'Mobile',
      cell: (r) => (r.mobileLast4 ? <span aria-label={`ending in ${r.mobileLast4}`} className="whitespace-nowrap tabular-nums">{maskedMobile(r.mobileLast4)}</span> : '—'),
    },
    { key: 'requested', header: 'Requested', cell: (r) => <span className="tabular-nums">{when(r.requestedAt)}</span> },
    { key: 'expires', header: 'Expires', cell: (r) => <span className="tabular-nums">{when(r.expiresAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      mobile: 'actions',
      cell: (r) => (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onAsk({ kind: 'approve', row: r })} aria-label={`Approve the reset for ${r.displayName}`}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => onAsk({ kind: 'decline', row: r })} aria-label={`Decline the reset for ${r.displayName}`}>
            Decline
          </Button>
        </span>
      ),
    },
  ]
}

export function PasswordResetsView(props: PasswordResetsViewProps) {
  const { list, notice, dialog, busy, noteError, onRetry, onAsk, onCancel, onApprove, onDecline } = props
  const [note, setNote] = useState('')
  const noticeRef = useRef<HTMLDivElement>(null)
  // After a decision the notice takes focus, so keyboard and screen-reader users land on the result.
  // The dialog keeps the page inert until its closing animation ends (and the button that opened it
  // may be gone with its row), so focus moves once the dialog has left, within about a second.
  useEffect(() => {
    if (!notice || dialog) return
    let frame = 0
    let tries = 0
    const focusWhenClosed = () => {
      if (document.querySelector('[role="dialog"]') && tries++ < 60) {
        frame = requestAnimationFrame(focusWhenClosed)
        return
      }
      noticeRef.current?.focus()
    }
    focusWhenClosed()
    return () => cancelAnimationFrame(frame)
  }, [notice, dialog])
  // A new decline starts with an empty note.
  useEffect(() => {
    if (dialog?.kind === 'decline') setNote('')
  }, [dialog])

  let body
  if (list.kind === 'loading') {
    body = (
      <p role="status" className="text-sm text-ink-muted">
        Reading the requests…
      </p>
    )
  } else if (list.kind === 'forbidden') {
    body = <Alert tone="warning" title="Your account can't see password reset requests." />
  } else if (list.kind === 'rate-limited' || list.kind === 'error') {
    body = (
      <div className="space-y-3">
        <Alert tone={list.kind === 'error' ? 'critical' : 'warning'} title={list.kind === 'error' ? "Couldn't read the requests." : 'Too many reads. Wait a few minutes, then try again.'} />
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  } else if (list.items.length === 0) {
    body = <p className="text-sm text-ink-muted">No requests are waiting.</p>
  } else {
    body = <ResponsiveTable rows={list.items} columns={columns(onAsk)} rowKey={(r) => r.id} caption="Password reset requests waiting for a decision" />
  }

  return (
    <Card>
      <CardHeader icon={KeyRound} title="Password resets" subtitle="Requests from staff and patients who forgot their password. Approving one has the sign-in service email them a link to set a new password; requests expire after 24 hours." />
      <CardBody className="space-y-4">
        <div ref={noticeRef} tabIndex={-1} aria-live="polite" className="outline-none">
          {notice ? <Alert tone={notice.tone} title={notice.text} /> : null}
        </div>
        {body}
      </CardBody>

      <Modal
        open={dialog?.kind === 'approve'}
        onClose={busy ? undefined : onCancel}
        title="Approve this password reset?"
        description={dialog?.kind === 'approve' ? `${dialog.row.displayName} will get an email from the sign-in service with a link to set a new password. Check who is asking before you approve.` : undefined}
        footer={
          <>
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => dialog?.kind === 'approve' && onApprove(dialog.row)}>
              Approve
            </Button>
          </>
        }
      />

      <Modal
        open={dialog?.kind === 'decline'}
        onClose={busy ? undefined : onCancel}
        title="Decline this password reset?"
        description={dialog?.kind === 'decline' ? `${dialog.row.displayName} will see that the request was declined, with your note if you add one.` : undefined}
        footer={
          <>
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => dialog?.kind === 'decline' && onDecline(dialog.row, note.trim() || undefined)}>
              Decline
            </Button>
          </>
        }
      >
        <TextAreaField id="password-reset-note" name="note" label="Note for the requester (optional)" value={note} onChange={setNote} maxLength={NOTE_MAX} error={noteError ?? undefined} />
      </Modal>
    </Card>
  )
}

/** The page: reads the list and makes decisions through `handlers`. */
export function PasswordResetsPanel({ handlers }: { handlers: PasswordResetHandlers }) {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)

  const load = useCallback(() => handlers.list().then(setList, () => setList({ kind: 'error' })), [handlers])
  useEffect(() => {
    void load()
  }, [load])

  function retry() {
    setList({ kind: 'loading' })
    void load()
  }

  function settle(row: ResetRequestRow, outcome: DecisionOutcome, done: string) {
    setBusy(false)
    if (outcome.kind === 'invalid') {
      setNoteError(decisionProblem(outcome).text)
      return
    }
    setDialog(null)
    if (outcome.kind === 'done') {
      setList((current) => (current.kind === 'ok' ? { kind: 'ok', items: current.items.filter((r) => r.id !== row.id) } : current))
      setNotice({ tone: 'stable', text: done })
      return
    }
    const problem = decisionProblem(outcome)
    setNotice({ tone: outcome.kind === 'error' ? 'critical' : 'warning', text: problem.text })
    if (problem.reload) void load()
  }

  function decide(row: ResetRequestRow, run: () => Promise<DecisionOutcome>, done: string) {
    setBusy(true)
    setNoteError(null)
    run().then(
      (outcome) => settle(row, outcome, done),
      () => settle(row, { kind: 'error' }, done),
    )
  }

  return (
    <PasswordResetsView
      list={list}
      notice={notice}
      dialog={dialog}
      busy={busy}
      noteError={noteError}
      onRetry={retry}
      onAsk={(d) => {
        setNoteError(null)
        setDialog(d)
      }}
      onCancel={() => setDialog(null)}
      onApprove={(row) => decide(row, () => handlers.approve(row), `Approved. ${row.displayName} will get an email with a link to set a new password.`)}
      onDecline={(row, note) => decide(row, () => handlers.decline(row, note), `Declined. ${row.displayName} will see that the request was declined.`)}
    />
  )
}

/** The admin area's section: the handlers aren't connected until the contract is on main; the development preview uses synthetic requests. */
export function PasswordResetsPage() {
  // `import.meta.env.DEV` is false in every production build, so the preview and its synthetic
  // requests are left out of the bundle.
  const [handlers] = useState<PasswordResetHandlers>(() => (import.meta.env.DEV && devPreviewOn() ? previewResetHandlers() : notYetConnected))
  return <PasswordResetsPanel handlers={handlers} />
}
