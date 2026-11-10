import { useStoreValue } from './useStore'
import { useNow } from './useNow'
import { getNavBadges } from '../domain/selectors'
import type { NavBadge } from '../domain/selectors'

/** The navigation's counts (Patients waiting, Billing due, …), kept current. */
export function useNavBadges(): Record<string, NavBadge> {
  const now = useNow(30000)
  return useStoreValue(getNavBadges, now)
}
