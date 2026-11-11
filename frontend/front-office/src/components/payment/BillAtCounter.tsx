import { Link } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { BillStatusBadge } from './BillStatusBadge'
import { Button } from '../ui/Button'
import { useStoreValue } from '../../hooks/useStore'
import { getPaymentById } from '../../domain/selectors'
import { billNumberFor, formatRupees, isBillDue } from '../../utils/billing'
import { printBill } from '../../utils/printBill'
import { cn } from '../../utils/cn'

/**
 * A bill Care Entry has raised, as the billing counter has it: number,
 * amount and live status — pending until the counter records the payment.
 * Care Entry never takes the money itself: the desk prints the bill and the
 * patient pays it at the billing counter.
 */
export function BillAtCounter({ paymentId, className, readOnly = false }: { paymentId: string; className?: string; readOnly?: boolean }) {
  const bill = useStoreValue(getPaymentById, paymentId)
  if (!bill) return null
  const due = isBillDue(bill)
  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-2.5 text-left',
        due
          ? 'border-[color-mix(in_oklab,var(--color-hue-amber)_28%,var(--color-border-soft))] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--color-hue-amber)_12%,var(--color-surface-1)),color-mix(in_oklab,var(--color-hue-amber)_4%,var(--color-surface-1)))]'
          : 'border-[color-mix(in_oklab,var(--color-hue-green)_28%,var(--color-border-soft))] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--color-hue-green)_12%,var(--color-surface-1)),color-mix(in_oklab,var(--color-hue-green)_4%,var(--color-surface-1)))]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {readOnly ? (
          <span className="text-sm font-semibold text-ink">
            {billNumberFor(bill)} · {formatRupees(bill.totalAmount)}
          </span>
        ) : (
          <Link to={`/payments/${bill.paymentId}`} className="text-sm font-semibold text-primary-text hover:underline">
            {billNumberFor(bill)} · {formatRupees(bill.totalAmount)}
          </Link>
        )}
        <BillStatusBadge payment={bill} />
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {due ? <p className="text-xs text-ink-muted">{formatRupees(bill.balance)} due</p> : null}
        {due && !readOnly ? (
          <Button size="xs" variant="secondary" onClick={() => printBill(bill.paymentId)}>
            <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Print bill
          </Button>
        ) : null}
      </div>
    </div>
  )
}
