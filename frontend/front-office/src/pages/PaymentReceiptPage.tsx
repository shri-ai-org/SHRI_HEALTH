import { useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { BillStatusBadge } from '../components/payment/BillStatusBadge'
import { EmptyState } from '../components/ui/EmptyState'
import { useStoreValue } from '../hooks/useStore'
import { getPaymentById } from '../domain/selectors'
import { getFacilityById } from '../data/facilities'
import { currentFrontOfficeUser } from '../data/currentUser'
import { formatClock } from '../utils/format'
import { formatDateKey } from '../utils/dates'
import { todayKey } from '../domain/time'
import { formatRupees } from '../utils/billing'

function timestampLabel(ts: number): string {
  return `${formatDateKey(todayKey(new Date(ts)))} · ${formatClock(ts)}`
}

interface ReceiptLocationState {
  autoPrint?: boolean
}

/** The printable receipt. Reachable from a payment's acknowledgement and
 *  from the bill itself — the same view either way, so what staff hand a
 *  patient always matches what's on record. */
export function PaymentReceiptPage() {
  const { paymentId } = useParams<{ paymentId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const payment = useStoreValue(getPaymentById, paymentId ?? '')
  const facility = getFacilityById(currentFrontOfficeUser.facilityId)
  const autoPrint = (location.state as ReceiptLocationState | null)?.autoPrint

  useEffect(() => {
    if (autoPrint && payment) {
      const id = window.setTimeout(() => window.print(), 200)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [autoPrint, payment])

  if (!payment) {
    return (
      <div>
        <PageHeader title="Receipt not found" />
        <div className="mt-5 sm:mt-6">
          <Card accentTone="stable" className="max-w-xl">
            <CardBody>
              <EmptyState
                title="No such receipt"
                action={<Button size="sm" onClick={() => navigate('/billing?filter=all')}>Payments</Button>}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }

  const latestTransaction = payment.transactions[payment.transactions.length - 1] ?? null

  return (
    <div>
      <PageHeader
        title="Payment Receipt"
        subtitle={payment.receiptNo}
        actions={
          <Button size="sm" onClick={() => window.print()} className="print:hidden">
            <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
            Print
          </Button>
        }
      />

      <div className="mt-5 sm:mt-6">
        <Card accentTone="stable" className="mx-auto max-w-xl">
          <CardBody className="flex flex-col gap-4">
            <div className="border-b border-border-soft pb-4 text-center">
              <p className="text-lg font-semibold tracking-tight text-ink">{facility.name}</p>
              <p className="text-xs text-ink-subtle">Facility code {facility.code}</p>
              <p className="mt-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">Payment Receipt</p>
            </div>

            <dl className="space-y-2 text-sm">
              <Row label="Receipt No." value={payment.receiptNo} />
              {latestTransaction ? <Row label="Transaction" value={latestTransaction.transactionId} /> : null}
              <Row label="Date" value={timestampLabel(latestTransaction?.collectedAt ?? payment.createdAt)} />
              <Row label="Patient" value={payment.patientName} />
              <Row label="UHID" value={payment.patientId} />
            </dl>

            <div className="border-t border-border-soft pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Description</p>
              <div className="space-y-1.5 text-sm">
                {payment.items.map((item) => (
                  <div key={item.code} className="flex items-center justify-between">
                    <span className="text-ink">{item.description}</span>
                    <span className="tabular-nums text-ink">{formatRupees(item.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border-soft pt-3">
              <span className="text-sm font-semibold text-ink">Total Paid</span>
              <span className="text-lg font-semibold tabular-nums text-ink">{formatRupees(payment.paidAmount)}</span>
            </div>
            {payment.balance > 0 ? (
              <div className="flex items-center justify-between text-sm text-warning-fg">
                <span>Balance Due</span>
                <span className="tabular-nums">{formatRupees(payment.balance)}</span>
              </div>
            ) : null}

            <div className="flex items-center justify-between border-t border-border-soft pt-3 text-sm">
              <span className="text-ink-muted">Payment Method</span>
              <span className="font-medium text-ink">{latestTransaction?.method ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-muted">Status</span>
              <BillStatusBadge payment={payment} />
            </div>

            {payment.refund ? (
              <div className="rounded-lg border border-info-fg/25 bg-info-bg px-3 py-2.5 text-xs text-info-fg">
                Refunded {formatRupees(payment.refund.amount)} on {timestampLabel(payment.refund.refundedAt)} — {payment.refund.reason}
              </div>
            ) : null}

          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  )
}
