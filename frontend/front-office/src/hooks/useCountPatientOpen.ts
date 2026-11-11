import { useEffect, useRef } from 'react'
import { recordPatientOpen } from '../domain/actions'

/**
 * Counts one open per visit to a patient's profile — feeds "Most opened".
 * The ref survives StrictMode's double effect run and flows opening over the
 * profile (same mount), so neither inflates the count; leaving and coming
 * back, or switching to another patient, counts again.
 */
export function useCountPatientOpen(patientId: string | undefined): void {
  const countedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!patientId || countedFor.current === patientId) return
    countedFor.current = patientId
    recordPatientOpen(patientId)
  }, [patientId])
}
