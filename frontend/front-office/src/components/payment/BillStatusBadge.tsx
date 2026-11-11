import { Badge } from '../ui/Badge'
import { BILL_STATUS_LABEL, BILL_STATUS_TONE, billDisplayStatus } from '../../utils/billing'
import type { Payment } from '../../types/payment'

/** The one way a bill's status is shown — same word and colour everywhere. */
export function BillStatusBadge({ payment, className }: { payment: Payment; className?: string }) {
  const status = billDisplayStatus(payment)
  return (
    <Badge tone={BILL_STATUS_TONE[status]} className={className}>
      {BILL_STATUS_LABEL[status]}
    </Badge>
  )
}
