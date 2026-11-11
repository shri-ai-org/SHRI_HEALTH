import { useEffect } from 'react'
import { useToast } from '../../hooks/useToast'
import { releaseUnpaidBookings } from '../../domain/actions'
import { getPatientById, getProviderById } from '../../domain/selectors'
import { getState } from '../../domain/store'
import { formatTime } from '../../domain/time'

/** How often the unpaid-booking hold is checked. */
const CHECK_EVERY_MS = 10000

/**
 * A booking holds its time for five minutes while the patient takes the bill
 * to the billing counter. Anything still unpaid after that is released, so
 * the time can be booked by someone else — and the desk is told.
 */
export function PaymentHoldSweeper() {
  const { notify } = useToast()
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const released of releaseUnpaidBookings()) {
        const state = getState()
        const patient = getPatientById(state, released.patientId)
        const doctor = getProviderById(state, released.providerId)
        notify('Booking released — payment not received', {
          tone: 'info',
          detail: `${patient?.name ?? 'Patient'} · ${doctor?.name ?? 'Doctor'} · ${formatTime(released.slot)} slot is available again`,
        })
      }
    }, CHECK_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [notify])
  return null
}
