/**
 * SHRI_HEALTH: Refill requests (#415's API; Thulasi on #85, 19 Nov): patients ask for a refill
 * from the portal, and the doctor approves (a draft prescription to check, sign and send) or
 * declines with one of the fixed reasons the patient then reads. Oldest first. A restricted chart
 * the doctor may not open shows as "Restricted chart" with no clinical details and no actions.
 * Behind VITE_FEATURE_REFILL_REQUESTS (off by default). Generated client only; no sample data.
 */
import { Lock, Pill as PillIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { formatClinicDateTime } from '../../../shri-health/format'
import {
  DECLINE_REASONS,
  listProblem,
  loadOpenRefills,
  respondToRefill,
  type DeclineReason,
  type DecisionOutcome,
  type ListProblem,
  type RefillRow,
} from '../../../shri-health/refills'
import { ScreenFrame } from '../app/ScreenFrame'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { EmptyState } from '../ui/EmptyState'
import { Field, Select } from '../ui/forms'
import { Card, Chip, Pill } from '../ui/primitives'

export type ListState = { kind: 'loading' } | { kind: 'ok'; rows: RefillRow[] } | { kind: 'problem'; problem: ListProblem }

export interface Notice {
  tone: 'info' | 'warn' | 'crit'
  text: string
}

export type Ask = { kind: 'approve'; row: RefillRow } | { kind: 'decline'; row: RefillRow } | null

const LIST_PROBLEM: Record<ListProblem, { tone: 'warn' | 'crit'; title: string; retry: boolean }> = {
  forbidden: { tone: 'warn', title: "Your account can't see refill requests.", retry: false },
  'rate-limited': { tone: 'warn', title: 'Too many reads. Wait a few minutes, then try again.', retry: true },
  error: { tone: 'crit', title: "Couldn't read the refill requests.", retry: true },
}

/** What the doctor reads after a decision that didn't go through, and whether the list is read again. */
export function decisionProblem(outcome: Exclude<DecisionOutcome, { kind: 'done' }>): { tone: 'warn' | 'crit'; text: string; reload: boolean } {
  switch (outcome.kind) {
    case 'restricted':
      return { tone: 'warn', text: "Restricted chart: open the patient's chart with break-glass access to answer this request.", reload: false }
    case 'forbidden':
      return { tone: 'warn', text: 'Only physicians and advanced practice providers can approve or decline refills.', reload: false }
    case 'not-found':
      return { tone: 'warn', text: 'That request no longer exists. The list has been updated.', reload: true }
    case 'conflict':
      return { tone: 'warn', text: 'That request was already answered. The list has been updated.', reload: true }
    case 'stale':
      return { tone: 'warn', text: 'That request changed after the list was read. The list has been updated; check it and try again.', reload: true }
    case 'invalid':
      return { tone: 'warn', text: "That decision couldn't be saved as sent. Check the reason and try again.", reload: false }
    case 'rate-limited':
      return { tone: 'warn', text: 'Too many actions. Wait a few minutes, then try again.', reload: false }
    case 'error':
      return { tone: 'crit', text: "Couldn't save the decision. Check your connection, then try again.", reload: false }
  }
}

export interface RefillRequestsViewProps {
  list: ListState
  notice: Notice | null
  ask: Ask
  busy: boolean
  onRetry: () => void
  onAsk: (ask: Exclude<Ask, null>) => void
  onCancel: () => void
  onApprove: (row: RefillRow) => void
  onDecline: (row: RefillRow, reason: DeclineReason) => void
}

function RequestRow({ row, onAsk }: { row: RefillRow; onAsk: RefillRequestsViewProps['onAsk'] }) {
  if (row.restricted) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-[10px] py-[12px]">
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="inline-flex items-center gap-[6px] text-[14px] font-semibold text-sh-text">
            <Lock size={14} aria-hidden /> Restricted chart
          </span>
          <span className="text-[12px] text-sh-text-3">Requested {formatClinicDateTime(row.requestedAt)}</span>
        </span>
        <Link to={`/patient/${row.patientId}`} className="inline-flex min-h-[44px] items-center text-[13px] font-semibold text-sh-text underline-offset-2 hover:underline">
          Open the chart
        </Link>
      </li>
    )
  }
  const who = row.patientName ?? 'Patient'
  return (
    <li className="flex flex-wrap items-start justify-between gap-[12px] py-[12px]">
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="text-[14px] font-semibold text-sh-text">{row.drug ?? 'Medication'}</span>
        {row.directions && <span className="text-[13px] text-sh-text-2">{row.directions}</span>}
        <span className="text-[13px] text-sh-text-2">
          <Link to={`/patient/${row.patientId}`} className="font-medium text-sh-text underline-offset-2 hover:underline">
            {who}
          </Link>
          {row.mrn ? ` · ${row.mrn}` : ''}
        </span>
        {row.note && <span className="text-[12px] text-sh-text-3">Patient’s note: {row.note}</span>}
        <span className="text-[12px] tabular-nums text-sh-text-3">Requested {formatClinicDateTime(row.requestedAt)}</span>
      </span>
      <span className="flex flex-wrap gap-[8px]">
        <Pill variant="primary" size="xl" onClick={() => onAsk({ kind: 'approve', row })} aria-label={`Approve the refill of ${row.drug ?? 'this medication'} for ${who}`}>
          Approve
        </Pill>
        <Pill variant="outline" size="xl" onClick={() => onAsk({ kind: 'decline', row })} aria-label={`Decline the refill of ${row.drug ?? 'this medication'} for ${who}`}>
          Decline
        </Pill>
      </span>
    </li>
  )
}

export function RefillRequestsView(props: RefillRequestsViewProps) {
  const { list, notice, ask, busy, onRetry, onAsk, onCancel, onApprove, onDecline } = props
  const [reason, setReason] = useState<DeclineReason | ''>('')
  const [reasonMissing, setReasonMissing] = useState(false)
  const noticeRef = useRef<HTMLDivElement>(null)

  // A new decline starts with no reason chosen.
  useEffect(() => {
    if (ask?.kind === 'decline') {
      setReason('')
      setReasonMissing(false)
    }
  }, [ask])
  // After a decision the notice takes focus once the dialog has gone (it keeps the page inert while
  // it closes, and the button that opened it may have left with its row).
  useEffect(() => {
    if (!notice || ask) return
    let frame = 0
    let tries = 0
    const focusWhenClosed = () => {
      if (document.querySelector('[role="dialog"],[role="alertdialog"]') && tries++ < 60) {
        frame = requestAnimationFrame(focusWhenClosed)
        return
      }
      noticeRef.current?.focus()
    }
    focusWhenClosed()
    return () => cancelAnimationFrame(frame)
  }, [notice, ask])

  let body
  if (list.kind === 'loading') {
    body = (
      <p role="status" className="py-[12px] text-[14px] text-sh-text-2">
        Reading the refill requests…
      </p>
    )
  } else if (list.kind === 'problem') {
    const p = LIST_PROBLEM[list.problem]
    body = (
      <Alert
        tone={p.tone}
        title={p.title}
        action={
          p.retry ? (
            <Pill variant="control" size="xl" onClick={onRetry}>
              Try again
            </Pill>
          ) : undefined
        }
      />
    )
  } else if (list.rows.length === 0) {
    body = <EmptyState icon={PillIcon} why="No refill requests are waiting." />
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-sh-line" aria-label="Refill requests waiting for a decision">
        {list.rows.map((row) => (
          <RequestRow key={row.id} row={row} onAsk={onAsk} />
        ))}
      </ul>
    )
  }

  const count = list.kind === 'ok' ? list.rows.length : undefined
  return (
    <ScreenFrame
      screenId="S-06-21"
      heading="Refill requests"
      sub="Patients’ refill requests from the portal, oldest first. Approving makes a draft prescription for you to check, sign and send."
      chips={count !== undefined ? <Chip num={String(count)} word="waiting" tone={count > 0 ? 'pend' : 'neu'} /> : undefined}
    >
      <Card className="flex flex-col gap-[8px]">
        <div ref={noticeRef} tabIndex={-1} aria-live="polite" className="outline-none">
          {notice && <Alert tone={notice.tone} title={notice.text} />}
        </div>
        {body}
      </Card>

      <ConfirmDialog
        open={ask?.kind === 'approve'}
        title="Approve this refill?"
        consequence={ask?.kind === 'approve' ? `A draft prescription of ${ask.row.drug ?? 'this medication'} is made for ${ask.row.patientName ?? 'the patient'} from the earlier one. Check it, then sign and send it; the safety checks run as for any prescription.` : ''}
        confirmLabel={busy ? 'Approving…' : 'Approve'}
        confirmDisabled={busy}
        onConfirm={() => ask?.kind === 'approve' && onApprove(ask.row)}
        onCancel={onCancel}
      />

      <ConfirmDialog
        open={ask?.kind === 'decline'}
        title="Decline this refill?"
        consequence={ask?.kind === 'decline' ? `${ask.row.patientName ?? 'The patient'} sees a fixed message for the reason you choose.` : ''}
        confirmLabel={busy ? 'Declining…' : 'Decline'}
        confirmDisabled={busy}
        tone="destructive"
        onConfirm={() => {
          if (ask?.kind !== 'decline') return
          if (!reason) {
            setReasonMissing(true)
            document.getElementById('refill-decline-reason')?.focus()
            return
          }
          onDecline(ask.row, reason)
        }}
        onCancel={onCancel}
      >
        <Field label="Reason" htmlFor="refill-decline-reason" required error={reasonMissing ? 'Choose a reason.' : undefined}>
          <Select
            id="refill-decline-reason"
            value={reason}
            aria-invalid={reasonMissing || undefined}
            onChange={(e) => {
              setReason(e.target.value as DeclineReason | '')
              if (e.target.value) setReasonMissing(false)
            }}
          >
            <option value="">Choose a reason</option>
            {DECLINE_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </ConfirmDialog>
    </ScreenFrame>
  )
}

/** One Idempotency-Key per decision, kept for a retry of that same decision. */
function keyFor(keys: Map<string, string>, id: string): string {
  let key = keys.get(id)
  if (!key) {
    key = crypto.randomUUID()
    keys.set(id, key)
  }
  return key
}

export function RefillRequestsPage({
  load = loadOpenRefills,
  respond = respondToRefill,
}: {
  load?: typeof loadOpenRefills
  respond?: typeof respondToRefill
}) {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ask, setAsk] = useState<Ask>(null)
  const [busy, setBusy] = useState(false)
  const keys = useRef(new Map<string, string>())

  const read = useCallback(
    () =>
      load().then(
        (rows) => setList({ kind: 'ok', rows }),
        (err: unknown) => setList({ kind: 'problem', problem: listProblem(err) }),
      ),
    [load],
  )
  useEffect(() => {
    void read()
  }, [read])

  function decide(row: RefillRow, decision: { approve: true } | { decline: DeclineReason }, done: string) {
    // A different decision on the same request is a new action, with its own key.
    const keyId = `${row.id}:${'approve' in decision ? 'approve' : decision.decline}`
    setBusy(true)
    void respond(row.id, decision, keyFor(keys.current, keyId)).then((outcome) => {
      setBusy(false)
      setAsk(null)
      if (outcome.kind === 'done') {
        keys.current.delete(keyId)
        setList((current) => (current.kind === 'ok' ? { kind: 'ok', rows: current.rows.filter((r) => r.id !== row.id) } : current))
        setNotice({ tone: 'info', text: done })
        return
      }
      const problem = decisionProblem(outcome)
      if (problem.reload) keys.current.delete(keyId)
      setNotice({ tone: problem.tone, text: problem.text })
      if (problem.reload) void read()
    })
  }

  return (
    <RefillRequestsView
      list={list}
      notice={notice}
      ask={ask}
      busy={busy}
      onRetry={() => {
        setList({ kind: 'loading' })
        void read()
      }}
      onAsk={setAsk}
      onCancel={() => setAsk(null)}
      onApprove={(row) =>
        decide(row, { approve: true }, `Approved. A draft prescription of ${row.drug ?? 'the medication'} for ${row.patientName ?? 'the patient'} is ready to check, sign and send.`)
      }
      onDecline={(row, reason) => decide(row, { decline: reason }, `Declined. ${row.patientName ?? 'The patient'} will see the reason in the portal.`)}
    />
  )
}
