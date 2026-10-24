import { ShieldAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../components/Button'
import { Alert } from '../components/feedback'
import { isOverLimit, Textarea } from '../components/inputs'
import { Modal } from '../components/Modal'

/** `reasonText` is at most 500 characters (platform.yaml, `BreakGlassRequest`). */
const REASON_TEXT_LIMIT = 500

/** Reason codes for `POST /patients/{patientId}/break-glass` (SECURITY_MODEL §5.2). */
export type BreakGlassReasonCode = 'emergency-care' | 'continuity-of-care' | 'patient-request' | 'other'

export interface BreakGlassRequest {
  reasonCode: BreakGlassReasonCode
  reasonText?: string
}

const REASONS: Array<{ code: BreakGlassReasonCode; label: string; hint: string }> = [
  { code: 'emergency-care', label: 'Emergency care', hint: 'The patient needs urgent care now.' },
  { code: 'continuity-of-care', label: 'Continuity of care', hint: "I'm involved in this patient's current care." },
  { code: 'patient-request', label: 'Patient request', hint: 'The patient asked me to look at their record.' },
  { code: 'other', label: 'Other', hint: 'Explain the reason below.' },
]

export interface BreakGlassDialogProps {
  open: boolean
  busy?: boolean
  /** Message from a failed request, already turned into words (e.g. by problemCopy). */
  error?: string | undefined
  onSubmit: (request: BreakGlassRequest) => void
  onCancel: () => void
}

/**
 * Shown on `403 break-glass-required`. The user states why they need a restricted chart; access is
 * granted for this patient only, for 4 hours, audited, and the privacy officer is told
 * (SECURITY_MODEL §5.2). A note is required when the reason is "Other".
 */
export function BreakGlassDialog({ open, busy = false, error, onSubmit, onCancel }: BreakGlassDialogProps) {
  const [reasonCode, setReasonCode] = useState<BreakGlassReasonCode | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [triedSubmit, setTriedSubmit] = useState(false)
  const noteId = useId()
  const noteErrorId = useId()

  const noteRequired = reasonCode === 'other'
  const noteMissing = noteRequired && reasonText.trim() === ''
  const noteTooLong = isOverLimit(reasonText.trim(), REASON_TEXT_LIMIT)
  const reasonMissing = reasonCode === null

  function submit() {
    setTriedSubmit(true)
    if (reasonCode === null || noteMissing || noteTooLong) return
    const text = reasonText.trim()
    onSubmit(text ? { reasonCode, reasonText: text } : { reasonCode })
  }

  return (
    <Modal
      open={open}
      title="Open a restricted chart"
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={busy} icon={<ShieldAlert aria-hidden="true" size={16} />} onClick={submit}>
            Open chart
          </Button>
        </>
      }
    >
      <p>
        This chart is restricted. Your access will be <strong className="text-ink">recorded and reviewed</strong> by the
        privacy officer. It lasts 4 hours, for this patient only.
      </p>
      <fieldset className="mt-4" aria-describedby={triedSubmit && reasonMissing ? noteErrorId : undefined}>
        <legend className="text-sm font-semibold text-ink">Reason for access</legend>
        <div className="mt-2 flex flex-col gap-1">
          {REASONS.map((r) => (
            <label key={r.code} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
              <input
                type="radio"
                name="break-glass-reason"
                value={r.code}
                checked={reasonCode === r.code}
                onChange={() => setReasonCode(r.code)}
                className="mt-1 size-4"
              />
              <span>
                <span className="block text-sm font-medium text-ink">{r.label}</span>
                <span className="block text-xs text-ink-subtle">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor={noteId} className="text-sm font-medium text-ink-muted">
          Note{noteRequired ? <span className="sr-only"> (required)</span> : <span className="text-xs font-normal text-ink-subtle"> (optional)</span>}
          {noteRequired ? <span aria-hidden="true" className="ml-1 text-critical-fg">*</span> : null}
        </label>
        <Textarea
          id={noteId}
          value={reasonText}
          limit={REASON_TEXT_LIMIT}
          onChange={(e) => setReasonText(e.target.value)}
          aria-invalid={triedSubmit && (noteMissing || noteTooLong) ? true : undefined}
          aria-describedby={triedSubmit && (noteMissing || reasonMissing || noteTooLong) ? noteErrorId : undefined}
        />
        {triedSubmit && (reasonMissing || noteMissing || noteTooLong) ? (
          <p id={noteErrorId} className="text-xs font-medium text-critical-fg">
            {reasonMissing
              ? 'Choose a reason.'
              : noteMissing
                ? 'Explain the reason for "Other".'
                : `Shorten the note to ${REASON_TEXT_LIMIT} characters or fewer.`}
          </p>
        ) : null}
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="critical" title="Access not granted">
            {error}
          </Alert>
        </div>
      ) : null}
    </Modal>
  )
}
