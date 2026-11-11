import { useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, HandCoins, IndianRupee, ReceiptText } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { StatFilter } from '../components/ui/StatFilter'
import type { StatFilterItem } from '../components/ui/StatFilter'
import { PaymentIllustration } from '../components/ui/illustrations/PaymentIllustration'
import { PaymentsTable } from '../components/payment/PaymentsTable'
import { useStoreValue } from '../hooks/useStore'
import { getBillingOverview, getBillsByFilter } from '../domain/selectors'
import type { BillFilter } from '../domain/selectors'
import { formatRupees, isBillDue } from '../utils/billing'
import { printBill } from '../utils/printBill'

const FILTERS: BillFilter[] = ['due', 'failed', 'collected-today', 'all']

function readFilter(search: string): BillFilter {
  const value = new URLSearchParams(search).get('filter')
  return FILTERS.includes(value as BillFilter) ? (value as BillFilter) : 'due'
}

const EMPTY_TITLE: Record<BillFilter, string> = {
  due: 'No payment pending',
  failed: 'No failed payments',
  'collected-today': 'Nothing received yet today',
  all: 'No payments yet',
}

/** Payment Status, to view only: Care Entry raises and prints bills, the
 *  patient pays at the bill counter, and this page tracks the result. What is pending, what failed, what the
 *  counter received today, and every bill — each figure is also the filter
 *  for the list under it; a bill opens to its items and history. */
export function BillingPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const filter = readFilter(location.search)
  const overview = useStoreValue(getBillingOverview)
  const bills = useStoreValue(getBillsByFilter, filter)

  function selectFilter(next: BillFilter) {
    const query = new URLSearchParams(location.search)
    query.set('filter', next)
    // A filter is a view of this page, not a place — don't fill history.
    navigate({ search: `?${query.toString()}` }, { replace: true })
  }

  const items: StatFilterItem<BillFilter>[] = [
    { key: 'due', label: 'Payment pending', value: formatRupees(overview.dueAmount), tone: 'warning', icon: HandCoins },
    { key: 'failed', label: 'Payment failed', value: overview.failedCount, tone: 'critical', icon: AlertCircle },
    {
      key: 'collected-today',
      label: 'Payment received today',
      value: formatRupees(overview.collectedToday),
      tone: 'stable',
      icon: IndianRupee,
    },
    { key: 'all', label: 'Total payments', value: overview.allCount, tone: 'info', icon: ReceiptText },
  ]

  return (
    <div>
      <PageHeader
        title="Payments"
        illustration={<PaymentIllustration className="h-8 w-8" />}
        illustrationTone="stable"
      />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        <StatFilter label="Show payments" items={items} selected={filter} onSelect={selectFilter} />

        <Card accentTone="stable">
          <PaymentsTable
            payments={bills}
            showBalance
            emptyTitle={EMPTY_TITLE[filter]}
            renderActions={(payment) => (
              <>
                {isBillDue(payment) ? (
                  <Button size="sm" variant="ghost" onClick={() => printBill(payment.paymentId)}>
                    Print bill
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => navigate(`/payments/${payment.paymentId}`)}>
                  Bill details
                </Button>
              </>
            )}
          />
        </Card>
      </div>
    </div>
  )
}
