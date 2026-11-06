import type { ReactNode } from 'react'
import { initialsOf } from '../../utils/format'
import { Avatar } from '../ui/Avatar'
import { Link } from 'react-router-dom'
import { Receipt } from 'lucide-react'
import { EmptyState } from '../ui/EmptyState'
import { BillStatusBadge } from './BillStatusBadge'
import { formatClock } from '../../utils/format'
import { formatDateKey } from '../../utils/dates'
import { todayKey } from '../../domain/time'
import { cn } from '../../utils/cn'
import { billNumberFor, formatRupees } from '../../utils/billing'
import type { Payment } from '../../types/payment'
import { PatientStatusIcons } from '../patient/PatientStatusIcons'
import { ResponsiveTable } from '../ui/ResponsiveTable'
import type { Column } from '../ui/ResponsiveTable'
import { usePatientCareStatus } from '../../hooks/useCareStatus'

/** The bill list — the Billing page passes in whichever bills its filter
 *  selects, plus the row action. */
export function PaymentsTable({
  payments,
  emptyTitle = 'No payments to show',
  emptyDescription,
  renderActions,
  showBalance = false,
}: {
  payments: Payment[]
  emptyTitle?: string
  emptyDescription?: string
  renderActions?: (payment: Payment) => ReactNode
  showBalance?: boolean
}) {
  const care = usePatientCareStatus()
  if (payments.length === 0) {
    return <EmptyState icon={Receipt} title={emptyTitle} description={emptyDescription} />
  }

  const columns: Column<Payment>[] = [
    {
      key: 'bill',
      header: 'Bill no.',
      className: 'whitespace-nowrap',
      mobile: 'subtitle',
      sortValue: (payment) => billNumberFor(payment),
      cell: (payment) => (
        <Link
          to={`/payments/${payment.paymentId}`}
          onClick={(event) => event.stopPropagation()}
          className="focus-ring tap-reach rounded font-medium text-primary-text hover:underline"
        >
          {billNumberFor(payment)}
        </Link>
      ),
    },
    {
      key: 'patient',
      header: 'Patient / UHID',
      mobile: 'title',
      sortValue: (payment) => payment.patientName,
      cell: (payment) => (
        <span className="flex min-w-0 items-center gap-2.5">
          {/* In the table only — a phone card keeps the room for the name. */}
          <span className="hidden shrink-0 tbl:inline-flex">
            <Avatar name={payment.patientName} initials={initialsOf(payment.patientName)} size="sm" />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5 text-ink tbl:max-w-[14rem]">
              <span className="truncate" title={payment.patientName}>
                {payment.patientName}
              </span>
              <PatientStatusIcons status={care[payment.patientId]} />
            </span>
            <span className="block text-2xs font-normal text-ink-subtle">{payment.patientId}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'when',
      header: 'Bill date',
      className: 'whitespace-nowrap text-ink-muted',
      sortValue: (payment) => payment.createdAt,
      cell: (payment) => (
        <>
          <span className="tbl:block">{formatDateKey(todayKey(new Date(payment.createdAt)))}</span>
          <span className="tbl:hidden"> · </span>
          <span className="tabular-nums tbl:block tbl:text-xs tbl:text-ink-subtle">{formatClock(payment.createdAt)}</span>
        </>
      ),
    },
    {
      key: 'description',
      header: 'Visit / service',
      className: 'text-ink-muted',
      cell: (payment) => (
        <span className="flex min-w-0 items-center gap-2">
          {/* OPD or IPD at a glance: a stay's bill, or a visit's. */}
          {payment.admissionId || payment.appointmentId ? (
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-2xs font-bold tracking-wide',
                payment.admissionId ? 'bg-therapy-bg text-therapy-fg' : 'bg-info-bg text-info-fg',
              )}
              title={payment.admissionId ? 'Inpatient (IPD)' : 'Outpatient (OPD)'}
            >
              {payment.admissionId ? 'IPD' : 'OPD'}
            </span>
          ) : null}
          <span className="block min-w-0 tbl:max-w-[10rem] tbl:truncate 2xl:max-w-[16rem]" title={payment.items.map((i) => i.description).join(', ')}>
            {payment.items.map((item) => item.description).join(', ')}
          </span>
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Bill amount',
      numeric: true,
      className: 'whitespace-nowrap font-medium text-ink',
      sortValue: (payment) => payment.totalAmount,
      cell: (payment) => formatRupees(payment.totalAmount),
    },
    ...(showBalance
      ? [
          {
            key: 'balance',
            header: 'Pending amount',
            numeric: true,
            className: 'whitespace-nowrap font-medium',
            sortValue: (payment: Payment) => payment.balance,
            cell: (payment: Payment) => (
              <span className={cn(payment.balance > 0 ? 'text-warning-fg' : 'text-ink-subtle')}>{formatRupees(payment.balance)}</span>
            ),
          } satisfies Column<Payment>,
        ]
      : []),
    {
      key: 'status',
      header: 'Payment status',
      className: 'whitespace-nowrap',
      mobile: 'aside',
      cell: (payment) => <BillStatusBadge payment={payment} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'whitespace-nowrap text-right',
      mobile: 'actions',
      cell: (payment) =>
        renderActions ? (
          <div className="flex justify-end gap-1.5" onClick={(event) => event.stopPropagation()}>
            {renderActions(payment)}
          </div>
        ) : null,
    },
  ]

  return (
    <ResponsiveTable
      rows={payments}
      columns={columns}
      rowKey={(payment) => payment.paymentId}
      caption="Bills"
    />
  )
}
