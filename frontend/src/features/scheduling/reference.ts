import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client'
import { listBookableAppointmentTypes, listBookableFacilities, listBookableProviders } from '../../api/generated/endpoints/scheduling/scheduling'
import type { AppointmentSummary, BookableAppointmentType, BookableFacility, BookableProvider } from '../../api/generated/model'
import { todayIn, type Problem } from '../../design-system'

/**
 * Reasons for a reschedule: HL7 appointment-cancellation-reason codes, the ones a front desk uses.
 * `other` needs a note.
 */
export const RESCHEDULE_REASONS: Array<{ code: string; label: string }> = [
  { code: 'pat', label: 'Patient asked' },
  { code: 'prov', label: 'Provider unavailable' },
  { code: 'oth-weath', label: 'Weather' },
  { code: 'oth-err', label: 'Booked in error' },
  { code: 'other', label: 'Other' },
]

/**
 * An appointment as the lists return it, plus its facility's time zone (from the booking lists), so
 * times show in facility time (D40).
 */
export type ScheduledAppointment = AppointmentSummary & { timeZone: string }

export function withTimeZones(items: AppointmentSummary[], facilities: BookableFacility[]): ScheduledAppointment[] {
  // Lists only return the user's facilities, which are the bookable ones; UTC is a visible fallback.
  return items.map((a) => ({ ...a, timeZone: facilities.find((f) => f.id === a.facilityId)?.timeZone ?? 'UTC' }))
}

/** The calendar date of an instant in a facility's time zone, `YYYY-MM-DD`. */
export function dateIn(instant: string, timeZone: string): string {
  return todayIn(timeZone, new Date(instant))
}

export interface BookingReference {
  facilities: BookableFacility[] | null
  types: BookableAppointmentType[] | null
  problem: Problem | null
}

/** Facilities and appointment types for booking (`/booking/*`, D49). Reference data, read once per screen. */
export function useBookingReference(): BookingReference {
  const [ref, setRef] = useState<BookingReference>({ facilities: null, types: null, problem: null })
  useEffect(() => {
    let current = true
    Promise.all([listBookableFacilities({ limit: 100 }), listBookableAppointmentTypes({ limit: 100 })])
      .then(([f, t]) => {
        if (!current) return
        setRef({ facilities: f.status === 200 ? f.data.items : [], types: t.status === 200 ? t.data.items : [], problem: null })
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setRef({ facilities: [], types: [], problem: error.problem })
        else throw error
      })
    return () => {
      current = false
    }
  }, [])
  return ref
}

/** Providers bookable at one facility. */
export function useBookableProviders(facilityId: string): BookableProvider[] | null {
  const [state, setState] = useState<{ facilityId: string; items: BookableProvider[] } | null>(null)
  useEffect(() => {
    if (!facilityId) return
    let current = true
    listBookableProviders({ facilityId, limit: 100 })
      .then((res) => {
        if (current && res.status === 200) setState({ facilityId, items: res.data.items })
      })
      .catch((error: unknown) => {
        if (!(error instanceof ApiError)) throw error
        if (current) setState({ facilityId, items: [] })
      })
    return () => {
      current = false
    }
  }, [facilityId])
  return state?.facilityId === facilityId ? state.items : null
}
