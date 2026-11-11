import { useState } from 'react'
import { BedDouble, XCircle } from 'lucide-react'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { Alert } from '../ui/Alert'
import { useToast } from '../../hooks/useToast'
import { useStoreValue } from '../../hooks/useStore'
import { getAdmissionBilling } from '../../domain/admissionSelectors'
import { cancelAdmission } from '../../domain/admissionActions'
import { formatRupees, stayDays } from '../../utils/billing'
import { formatClock } from '../../utils/format'
import { formatDateKey } from '../../utils/dates'
import { todayKey } from '../../domain/time'
import type { Admission } from '../../types/admission'
import { inputClass } from '../../utils/formClasses'

/**
 * The patient's current admission — or the request waiting for a bed — on
 * the profile itself: where they are, since when, who admitted them, the
 * running bill, and the one thing that can undo it.
 */
export function CurrentAdmissionCard({ admission, now }: { admission: Admission; now: number }) {
  const { notify } = useToast()
  const billing = useStoreValue(getAdmissionBilling, admission.admissionId, now)
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const admitted = admission.status === 'Admitted'
  const since = admission.admittedAt ?? admission.createdAt

  function handleCancel(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      cancelAdmission(admission.admissionId, reason)
      notify('Admission cancelled', { detail: admission.admissionNumber })
      setCancelling(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card accentTone={admitted ? 'info' : 'warning'}>
      <CardHeader
        icon={BedDouble}
        iconTone={admitted ? 'info' : 'warning'}
        title={admitted ? `Inpatient · ${admission.wardLabel} · ${admission.bedNumber}` : 'Admission waiting for a bed'}
        subtitle={`${admission.admissionNumber} · ${admission.doctorName} · ${admission.department}`}
        action={<Badge status={admission.status} />}
      />
      <CardBody className="flex flex-col gap-2 !py-3">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
          <Fact label={admitted ? 'Admitted' : 'Requested'} value={`${formatDateKey(todayKey(new Date(since)))} · ${formatClock(since)}`} />
          {admitted ? <Fact label="Stay" value={`Day ${stayDays(since, now)}`} /> : <Fact label="Type" value={admission.admissionType} />}
          <Fact
            label="Payer"
            value={
              admission.paymentType === 'Self Pay'
                ? 'Self pay'
                : [admission.paymentType, admission.insuranceProvider, admission.policyNumber].filter(Boolean).join(' · ')
            }
          />
          {/* No bed yet, no bill yet — a stay is billed from the day it starts. */}
          {admitted && billing ? (
            <Fact
              label="Running bill"
              value={
                billing.pending > 0 ? `${formatRupees(billing.pending)} due of ${formatRupees(billing.total)}` : `${formatRupees(billing.total)} paid`
              }
            />
          ) : null}
          <Fact label="Reason" value={admission.reason} />
          {/* The attendant is optional at admission: shown only with a name or a mobile. */}
          {admission.attendant.name.trim() || admission.attendant.phone.trim() ? (
            <div className="min-w-0">
              <dt className="text-xs text-ink-muted">Attendant</dt>
              <dd className="truncate font-medium text-ink">
                {admission.attendant.name.trim() ? `${admission.attendant.name} (${admission.attendant.relationship})` : admission.attendant.relationship}
                {admission.attendant.phone.trim() ? (
                  <>
                    {' · '}
                    <a href={`tel:${admission.attendant.phone.replace(/[^0-9+]/g, '')}`} className="focus-ring tap-reach rounded text-primary-text hover:underline">
                      {admission.attendant.phone}
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="-mb-1 flex justify-end">
          <Button size="xs" variant="ghost" onClick={() => setCancelling(true)}>
            <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
            Cancel admission
          </Button>
        </div>
      </CardBody>

      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel this admission"
        description={admitted ? 'The bed becomes available. A paid deposit stays on the bill for a refund.' : 'The request is withdrawn.'}
      >
        <form onSubmit={handleCancel} className="flex flex-col gap-3">
          {error ? <Alert tone="critical">{error}</Alert> : null}
          <label className="text-xs font-medium text-ink-muted" htmlFor="cancel-admission-reason">
            Reason
          </label>
          <input
            id="cancel-admission-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Admitted in error"
            className={inputClass}
          />
          <div className="flex justify-end pt-1">
            <Button type="submit" variant="danger" disabled={!reason.trim()}>
              Cancel admission
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  )
}
