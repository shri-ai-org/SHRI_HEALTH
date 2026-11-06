import { useNow } from './useNow'
import { useStoreValue } from './useStore'
import { getPatientCareStatus } from '../domain/patientSelectors'
import { todayKey } from '../domain/time'

/** Every patient's care status (admitted, outpatient today), keyed by
 *  patientId, for the icons beside their names. Follows the clock across
 *  midnight. */
export function usePatientCareStatus() {
  const today = todayKey(new Date(useNow(60000)))
  return useStoreValue(getPatientCareStatus, today)
}
