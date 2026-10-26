import { useState } from 'react'
import { ApiError } from '../../../api/client'
import { markCoverageEnteredInError } from '../../../api/generated/endpoints/patients/patients'
import type { Coverage } from '../../../api/generated/model'
import { Button, Field, isOverLimit, Modal, ProblemAlert, Textarea, useToast, type Problem } from '../../../design-system'

const REASON_LIMIT = 500

/**
 * Marks a coverage recorded by mistake (D45): it stays in the record but is never used for
 * eligibility or claims. The reason is required and treated as patient data.
 */
export function EnteredInErrorDialog({
  patientId,
  coverage,
  onClose,
  onMarked,
}: {
  patientId: string
  coverage: Coverage
  onClose: () => void
  onMarked: () => void
}) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    const text = reason.trim()
    if (!text) return setError('Explain what was wrong with this coverage.')
    if (isOverLimit(text, REASON_LIMIT)) return setError(`Shorten the reason to ${REASON_LIMIT} characters or fewer.`)
    setError(null)
    setBusy(true)
    try {
      const res = await markCoverageEnteredInError(patientId, coverage.id, { reason: text })
      if (res.status === 200) {
        toast.show('Coverage marked entered in error')
        onMarked()
      }
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem)
      else throw e
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title="Mark this coverage entered in error?"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Mark entered in error
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>
          {coverage.payerName ?? 'This coverage'}, member ID {coverage.memberId}, will never be used for eligibility or claims. It stays in the record. A coverage that simply
          ended is not an error.
        </p>
        <Field label="Reason" hint="For example: wrong patient, or duplicate entry" required error={error ?? undefined}>
          {(p) => <Textarea {...p} value={reason} limit={REASON_LIMIT} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </Modal>
  )
}
