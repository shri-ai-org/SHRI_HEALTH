import { createContext, useContext, type ReactNode } from 'react'
import { Spinner } from '../../design-system'
import { usePortalApi, type PortalApi } from './api/portalApi'
import { useResource } from './api/useResource'

/**
 * The clinic's IANA time zone (D40), from the API: the first booking facility's `timeZone`, else the
 * zone on the patient's own appointments. Record dates (results, messages, requests) are shown in it,
 * never in the browser's zone and never in a zone written into the code. Null when the API gives none;
 * the design system's formatters then use UTC.
 */
const ClinicZoneContext = createContext<string | null>(null)

async function loadClinicZone(api: PortalApi): Promise<string | null> {
  const facilities = await api.listBookingFacilities().catch(() => [])
  if (facilities[0]) return facilities[0].timeZone
  for (const when of ['upcoming', 'past'] as const) {
    const appointments = await api.listAppointments(when).catch(() => [])
    if (appointments[0]) return appointments[0].timeZone
  }
  return null
}

/** Reads the clinic's zone once, before the signed-in pages show any date. */
export function ClinicZone({ children }: { children: ReactNode }) {
  const api = usePortalApi()
  const zone = useResource(() => loadClinicZone(api), [])
  if (zone.status === 'loading') return <Spinner label="Opening your portal" />
  return <ClinicZoneContext.Provider value={zone.status === 'ready' ? zone.data : null}>{children}</ClinicZoneContext.Provider>
}

/** The clinic's time zone for formatting instants (null: none known, shown in UTC). */
export function useClinicTimeZone(): string | null {
  return useContext(ClinicZoneContext)
}
