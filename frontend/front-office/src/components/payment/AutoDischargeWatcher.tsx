import { useEffect } from 'react'
import { useToast } from '../../hooks/useToast'
import { subscribe } from '../../domain/store'
import { settleAutoDischarges } from '../../domain/autoDischarge'

/**
 * Finishes discharges on their own: whenever the store changes (a payment
 * recorded at the billing counter), any stay whose final bill was printed and
 * is now paid is discharged — and the desk is told.
 */
export function AutoDischargeWatcher() {
  const { notify } = useToast()
  useEffect(
    () =>
      subscribe(() => {
        // After the change that triggered it has finished saving.
        window.setTimeout(() => {
          for (const left of settleAutoDischarges()) {
            notify('Patient discharged', { detail: `Payment received · ${left.wardLabel} · ${left.bedNumber} is now available` })
          }
        }, 0)
      }),
    [notify],
  )
  return null
}
