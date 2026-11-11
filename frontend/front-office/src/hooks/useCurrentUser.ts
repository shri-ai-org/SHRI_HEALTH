import { currentFrontOfficeUser } from '../data/currentUser'
import type { CurrentUser } from '../data/currentUser'

/**
 * Who is signed in at this desk — a stand-in for a real session. One person
 * for now (no switching in the app bar); signing in as someone else will
 * belong to a login page once authentication exists.
 */
export function useCurrentUser(): CurrentUser {
  return currentFrontOfficeUser
}
