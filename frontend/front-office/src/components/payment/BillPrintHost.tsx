import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStoreValue } from '../../hooks/useStore'
import { getPaymentById } from '../../domain/selectors'
import { getFacilityById } from '../../data/facilities'
import { currentFrontOfficeUser } from '../../data/currentUser'
import { todayKey } from '../../domain/time'
import { formatClock } from '../../utils/format'
import { formatDateKey } from '../../utils/dates'
import { billNumberFor, formatRupees, isBillDue } from '../../utils/billing'
import { finishBillPrint, getBillPrintJob, subscribeBillPrint } from '../../utils/printBill'
import type { Payment } from '../../types/payment'

function timestampLabel(ts: number): string {
  return `${formatDateKey(todayKey(new Date(ts)))} · ${formatClock(ts)}`
}

/**
 * The bill as it is printed and handed to the patient — mounted once in App.
 * It is never shown on screen: when `printBill` is called it renders the bill
 * for the print dialog alone (index.css hides the page behind it), then
 * leaves again once the dialog closes.
 */
export function BillPrintHost() {
  const job = useSyncExternalStore(subscribeBillPrint, getBillPrintJob)
  const bill = useStoreValue(getPaymentById, job?.paymentId ?? '')
  const found = Boolean(bill)

  useEffect(() => {
    if (!job) return
    if (!found) {
      finishBillPrint(job)
      return
    }
    const done = () => finishBillPrint(job)
    window.addEventListener('afterprint', done)
    // A beat for the bill to lay out before the dialog snapshots the page.
    const id = window.setTimeout(() => window.print(), 50)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('afterprint', done)
    }
  }, [job, found])

  if (!job || !bill) return null
  return createPortal(
    <div data-print-root data-bill-print className="hidden print:block">
      <PrintedBill bill={bill} printedAt={job.printedAt} />
    </div>,
    document.body,
  )
}

function PrintedBill({ bill, printedAt }: { bill: Payment; printedAt: number }) {
  const facility = getFacilityById(currentFrontOfficeUser.facilityId)
  const due = isBillDue(bill)
  return (
    <article className="mx-auto max-w-xl text-ink">
      <header className="border-b border-border-soft pb-4 text-center">
        <p className="text-lg font-semibold tracking-tight">{facility.name}</p>
        <p className="text-xs text-ink-subtle">Facility code {facility.code}</p>
        <p className="mt-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">Bill</p>
      </header>

      <dl className="mt-4 space-y-1.5 text-sm">
        <Row label="Patient" value={bill.patientName} strong />
        <Row label="UHID" value={bill.patientId} />
        <Row label="Bill No." value={billNumberFor(bill)} />
        <Row label="Date" value={timestampLabel(bill.createdAt)} />
      </dl>

      <div className="mt-4 border-t border-border-soft pt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Description</p>
        <div className="space-y-1.5 text-sm">
          {bill.items.map((item) => (
            <div key={item.code} className="flex items-baseline justify-between gap-4">
              <span>{item.description}</span>
              <span className="tabular-nums">{formatRupees(item.amount)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-border-soft pt-3 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <span>Total</span>
          <span className="tabular-nums">{formatRupees(bill.totalAmount)}</span>
        </div>
        {bill.paidAmount > 0 ? (
          <div className="flex items-baseline justify-between gap-4">
            <span>Paid</span>
            <span className="tabular-nums">− {formatRupees(bill.paidAmount)}</span>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-4 border-t border-border-soft pt-2">
          <span className="font-semibold">{due ? 'To pay' : 'Balance'}</span>
          <span className="text-lg font-semibold tabular-nums">{formatRupees(bill.balance)}</span>
        </div>
      </div>

      <p className="mt-5 rounded-lg border border-border-soft px-4 py-3 text-center text-sm">
        {due
          ? `${bill.patientName}, please show this bill at the billing counter to pay.`
          : `Thank you, ${bill.patientName} — nothing is due on this bill.`}
      </p>
      <p className="mt-3 text-center text-2xs text-ink-subtle">Printed {timestampLabel(printedAt)}</p>
    </article>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className={strong ? 'text-right font-semibold' : 'text-right font-medium'}>{value}</dd>
    </div>
  )
}
