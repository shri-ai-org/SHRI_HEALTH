import { useShallow } from 'zustand/react/shallow'

import { screenForPath } from '@/atlas/registry'
import { useSession } from '@/store/session'

import { INBOX, useNotifications } from '../../state/notifications'
import { mayOpen } from '../landing'
import { canonical } from '../paths'

/** Whether the persona may open where an item points — else the item is absent (GP-02, as the rail's modules). */
function openable(persona: Parameters<typeof mayOpen>[0], to: string) {
  const spec = screenForPath(canonical(to).split(/[?#]/)[0]) ?? (canonical(to) === '/' ? screenForPath('/clinician') : undefined)
  return spec ? mayOpen(persona, spec.permission) : true
}

/** The bell's items for the signed-in persona: the inbox it may act on, and what it sent. */
export function useNotices() {
  const persona = useSession((s) => s.persona)
  const sent = useNotifications(useShallow((s) => s.sent))
  return { inbox: INBOX.filter((n) => openable(persona, n.to)), sent }
}
