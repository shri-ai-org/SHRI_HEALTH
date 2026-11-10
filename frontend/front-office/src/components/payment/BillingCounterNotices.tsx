import { useEffect } from 'react'
import { useToast } from '../../hooks/useToast'
import { counterNotice, onCounterPayment } from '../../domain/billingCounter'

/** Tells the desk when the billing counter records a payment. */
export function BillingCounterNotices() {
  const { notify } = useToast()
  useEffect(
    () =>
      onCounterPayment((bill) => {
        const { title, detail } = counterNotice(bill)
        notify(title, { detail })
      }),
    [notify],
  )
  return null
}
