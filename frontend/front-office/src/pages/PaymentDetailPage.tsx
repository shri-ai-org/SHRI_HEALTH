import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Printer, Receipt as ReceiptIcon } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { BillStatusBadge } from '../components/payment/BillStatusBadge'
import { useStoreValue } from '../hooks/useStore'
import { useToast } from '../hooks/useToast'
import { getPaymentById } from '../domain/selectors'
import { formatClock } from '../utils/format'
import { formatDateKey } from '../utils/dates'
import { todayKey } from '../domain/time'
import { billNumberFor, formatRupees, isBillDue } from '../utils/billing'
import { printBill } from '../utils/printBill'

function timestampLabel(ts: number): string {
  return `${formatDateKey(todayKey(new Date(ts)))} · ${formatClock(ts)}`
}

/** One bill's full picture, to view: its items, every payment the billing
 *  counter recorded against it, and its status. Care Entry takes no money —
 *  a bill with payment pending is printed for the patient to pay at the
 *  billing counter. */
export function PaymentDetailPage() {
  const { paymentId } = useParams<{ paymentId: string }>()
  const navigate = useNavigate()
  const { notify } = useToast()

  const payment = useStoreValue(getPaymentById, paymentId ?? '')

  const [printed, setPrinted] = useState(false)

  if (!payment) {
    return (
      <div>
        <PageHeader title="Bill not found" />
        <div className="mt-5 sm:mt-6">
          <Card accentTone="stable" className="max-w-xl">
            <CardBody>
              <EmptyState
                icon={ReceiptIcon}
                title="No such bill"
                action={<Button size="sm" onClick={() => navigate('/billing?filter=all')}>Payments</Button>}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }

  const due = isBillDue(payment)

  function print() {
    if (!payment) return
    printBill(payment.paymentId)
    setPrinted(true)
    notify(`Bill printed for ${payment.patientName}`, { detail: `${billNumberFor(payment)} · ${formatRupees(payment.balance)}` })
  }

  const linkedTo = payment.admissionId
    ? 'Inpatient admission'
    : payment.appointmentId
      ? 'Outpatient appointment'
      : payment.estimateId
        ? `Estimate ${payment.estimateId}`
        : null

  return (
    <div>
      <PageHeader
        eyebrow="Bill"
        title={billNumberFor(payment)}
        subtitle={
          <>
            <Link to={`/patients/${payment.patientId}`} className="text-primary-text hover:underline">
              {payment.patientName}
            </Link>{' '}
            · {payment.patientId}
          </>
        }
        actions={
          payment.transactions.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => navigate(`/payments/${payment.paymentId}/receipt`)}>
              <ReceiptIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
              Receipt
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">

        <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card accentTone="stable" className="min-w-0">
            <CardHeader title="Bill items" subtitle={linkedTo ?? undefined} action={<BillStatusBadge payment={payment} />} />
            <div className="divide-y divide-border-soft">
              {payment.items.map((item) => (
                <div key={item.code} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <span className="text-ink">{item.description}</span>
                  <span className="font-medium tabular-nums text-ink">{formatRupees(item.amount)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between px-5 py-3">
                <span className="text-sm font-semibold text-ink">Total</span>
                <span className="text-base font-semibold tabular-nums text-ink">{formatRupees(payment.totalAmount)}</span>
              </div>
            </div>

            <CardHeader title="Payments at the billing counter" />
            {payment.transactions.length === 0 && payment.failedAttempts.length === 0 ? (
              <EmptyState title="No payment recorded yet" />
            ) : (
              <div className="divide-y divide-border-soft">
                {[
                  ...payment.transactions.map((txn) => ({
                    id: txn.transactionId,
                    at: txn.collectedAt,
                    detail: txn.method,
                    amount: txn.amount,
                    failed: false,
                  })),
                  ...payment.failedAttempts.map((attempt) => ({
                    id: attempt.attemptId,
                    at: attempt.attemptedAt,
                    detail: `${attempt.method} · ${attempt.reason}`,
                    amount: attempt.amount,
                    failed: true,
                  })),
                ]
                  .sort((a, b) => a.at - b.at)
                  .map((row) => (
                    <div key={row.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="text-ink">{row.id}</p>
                        <p className="text-xs text-ink-muted">
                          {timestampLabel(row.at)} · {row.detail}
                        </p>
                      </div>
                      <span className={row.failed ? 'font-medium tabular-nums text-critical-fg line-through' : 'font-medium tabular-nums text-success-fg'}>
                        {formatRupees(row.amount)}
                      </span>
                    </div>
                  ))}
              </div>
            )}

            {payment.refund ? (
              <>
                <CardHeader title="Refund" />
                <CardBody className="text-sm">
                  <p className="text-ink">
                    {payment.refund.refundId} · {formatRupees(payment.refund.amount)}
                    {payment.refund.methods.length > 0 ? ` to ${payment.refund.methods.join(' + ')}` : ''} · {timestampLabel(payment.refund.refundedAt)}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">{payment.refund.reason}</p>
                </CardBody>
              </>
            ) : null}

            {payment.status === 'Cancelled' ? (
              <CardBody className="text-sm text-ink-muted">
                Cancelled {payment.cancelledAt ? timestampLabel(payment.cancelledAt) : ''} — {payment.cancelReason}
              </CardBody>
            ) : null}
          </Card>

          <div className="min-w-0">
            <Card accentTone="stable">
              <CardHeader title="Summary" />
              <CardBody className="flex flex-col gap-3">
                <dl className="space-y-2 text-sm">
                  <Row label="Total" value={formatRupees(payment.totalAmount)} />
                  <Row label="Paid" value={formatRupees(payment.paidAmount)} />
                  <Row label="Due" value={formatRupees(payment.balance)} />
                  <Row label="Raised" value={timestampLabel(payment.createdAt)} />
                </dl>
                <div className="flex flex-col gap-2 border-t border-border-soft pt-3">
                  {due ? (
                    <Button variant={printed ? 'outline' : 'secondary'} onClick={print}>
                      <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
                      {printed ? 'Print again' : 'Print bill'}
                    </Button>
                  ) : payment.status === 'Paid' || payment.status === 'Partially Paid' ? (
                    <p className="text-sm font-medium text-success-fg">Payment received</p>
                  ) : (
                    <p className="text-xs text-ink-subtle">This bill is {payment.status.toLowerCase()}.</p>
                  )}
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
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
