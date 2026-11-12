// SHRI_HEALTH data layer: `useCurrentUser` (src/hooks/useCurrentUser.ts) from the signed-in session
// (GET /auth/session, src/api/session.tsx) instead of the sample desk user.
// Field mapping, CurrentUser ⇐ SessionUser: staffId ⇐ id, name ⇐ displayName, initials ⇐ the
// name's first letters, role ⇐ the first role's name, facilityId ⇐ the first facility.
// Capabilities stay the front desk's (the screens' own two); permissions come from GET /me later.
import { useSession } from '../../src/api/session'
import { currentFrontOfficeUser } from '../src/data/currentUser'
import type { CurrentUser } from '../src/data/currentUser'

const ROLE_NAME: Record<string, string> = {
  FD: 'Front desk',
  MA: 'Medical assistant',
  RN: 'Nurse',
  MD: 'Physician',
  APP: 'Advanced practice provider',
  BIL: 'Billing',
  ADM: 'Administrator',
  CO: 'Compliance officer',
  SUP: 'Support',
  DSP: 'Display',
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

/** Who is signed in: the session's user once read, else the sample desk user. */
export function useCurrentUser(): CurrentUser {
  const { state } = useSession()
  if (state.status !== 'signed-in') return currentFrontOfficeUser
  const user = state.session.user
  return {
    ...currentFrontOfficeUser,
    staffId: user.id,
    name: user.displayName,
    initials: initialsOf(user.displayName),
    role: ROLE_NAME[user.roles[0] ?? ''] ?? user.roles[0] ?? '',
    facilityId: user.facilityIds[0] ?? currentFrontOfficeUser.facilityId,
  }
}
