import { IndianRupee, Printer, Receipt, X } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { BillStatusBadge } from '../payment/BillStatusBadge'
import { useStoreValue } from '../../hooks/useStore'
import { getBillsForPatient } from '../../domain/selectors'
import { todayKey } from '../../domain/time'
import { billNumberFor, billServicesSummary, formatRupees } from '../../utils/billing'
import { formatDateKey } from '../../utils/dates'
import { printBill } from '../../utils/printBill'
import { formatClock } from '../../utils/format'
import { cn } from '../../utils/cn'
import type { Payment } from '../../types/payment'

/**
 * The patient's bills, with the amount still to be paid at the top. The
 * amount is the profile header's own figure — it also counts a current stay's
 * bed charges not yet billed — so the two never disagree. Care Entry takes no
 * money: the printed bill is what the patient takes to the billing counter.
 */
export function PatientBillingCard({ patientId, due, onClose }: { patientId: string; due: number; onClose?: () => void }) {
  const all = useStoreValue(getBillsForPatient, patientId)
  // Bills still to pay come first; the rest stay newest first.
  const bills = [...all.filter(isPending), ...all.filter((bill) => !isPending(bill))]
  const paid = bills.reduce((sum, bill) => sum + (bill.status === 'Refunded' ? 0 : bill.paidAmount), 0)

  return (
    <Card accentTone="stable">
      <CardHeader
        icon={IndianRupee}
        iconTone="stable"
        title="Payment History"
        action={
          onClose ? (
            <button type="button" onClick={onClose} aria-label="Close payment history" title="Close" className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle hover:bg-surface-2 hover:text-ink">
              <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </button>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-3 border-b border-border-soft px-4 py-4 sm:grid-cols-3 sm:px-5">
        <div className={cn('rounded-xl border px-4 py-3', due > 0 ? 'border-critical-fg/30 bg-critical-bg' : 'border-success-fg/30 bg-success-bg')}>
          <p className="text-xs font-medium text-ink-muted">Pending amount</p>
          <p className={cn('mt-0.5 text-2xl font-bold tabular-nums', due > 0 ? 'text-critical-fg' : 'text-success-fg')}>{formatRupees(due)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 px-4 py-3">
          <p className="text-xs font-medium text-ink-muted">Payment received</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{formatRupees(paid)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 px-4 py-3">
          <p className="text-xs font-medium text-ink-muted">Bills</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{bills.length}</p>
          <p className="text-xs text-ink-muted">{bills.filter(isPending).length} pending</p>
        </div>
      </div>
      {bills.length === 0 ? (
        <EmptyState icon={Receipt} title="No bills" />
      ) : (
        <ul className="divide-y divide-border-soft" aria-label="Bills">
          {bills.map((bill) => (
            <BillRow key={bill.paymentId} bill={bill} />
          ))}
        </ul>
      )}
    </Card>
  )
}

/** A bill with money still owed on it — the one the desk acts on. */
function isPending(bill: Payment): boolean {
  return bill.balance > 0 && bill.status !== 'Cancelled' && bill.status !== 'Refunded'
}

/**
 * One bill on one line: what it was for, its number and date, the amount and
 * its status, and printing. A pending bill stands out — tinted, its amount due
 * in red, and a solid print icon (the printed bill is what the patient takes
 * to the billing counter). A settled bill stays quiet, with a light print icon
 * to reprint it.
 */
function BillRow({ bill }: { bill: Payment }) {
  const pending = isPending(bill)
  const number = billNumberFor(bill)
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5',
        pending && 'bg-[color-mix(in_oklab,var(--color-hue-amber)_9%,var(--color-surface-1))] shadow-[inset_3px_0_0_var(--color-hue-amber)]',
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-sm font-semibold text-ink" title={billServicesSummary(bill)}>
          {billServicesSummary(bill)}
        </p>
        <p className="truncate text-xs tabular-nums text-ink-muted">
          {number} · {formatDateKey(todayKey(new Date(bill.createdAt)))} · {formatClock(bill.createdAt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums text-ink">{formatRupees(bill.totalAmount)}</p>
          {pending ? <p className="text-xs font-semibold tabular-nums text-critical-fg">{formatRupees(bill.balance)} due</p> : null}
        </div>
        <BillStatusBadge payment={bill} />
        {/* Print: solid blue for a bill still to pay, light for one already settled. */}
        <button
          type="button"
          onClick={() => printBill(bill.paymentId)}
          aria-label={`Print bill ${number}`}
          title="Print bill"
          className={cn(
            'focus-ring flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
            pending
              ? 'bg-primary-600 text-on-primary shadow-card-sm hover:bg-primary-700'
              : 'bg-[color-mix(in_oklab,var(--color-hue-blue)_14%,var(--color-surface-1))] text-[var(--color-hue-blue)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hue-blue)_30%,transparent)] hover:bg-[var(--color-hue-blue)] hover:text-white',
          )}
        >
          <Printer className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}
