import { createContext, useContext } from 'react'
import type { PortalSession } from '../../api/generated/model'

export interface SessionApi {
  session: PortalSession
  signOut: (reason?: 'signed-out' | 'expired') => void
  /** Re-reads the session after "Stay signed in", which resets the idle timer. */
  refresh: () => Promise<void>
}

export const SessionContext = createContext<SessionApi | null>(null)

export function useSession(): SessionApi {
  const api = useContext(SessionContext)
  if (!api) throw new Error('useSession must be used inside the signed-in portal')
  return api
}
