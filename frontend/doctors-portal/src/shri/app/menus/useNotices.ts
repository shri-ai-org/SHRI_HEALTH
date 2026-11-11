import { useShallow } from 'zustand/react/shallow'

import { screenForPath } from '@/atlas/registry'
import { patient } from '@/data/kit'
import { useSession } from '@/store/session'

import { INBOX, useNotifications, type Notice } from '../../state/notifications'
import { visitById } from '../../telehealth/visits'
import { waitingList, useWaiting } from '../../telehealth/waitingRoom'
import { mayOpen } from '../landing'
import { canonical } from '../paths'

/** Whether the persona may open where an item points — else the item is absent (GP-02, as the rail's modules). */
function openable(persona: Parameters<typeof mayOpen>[0], to: string) {
  const spec = screenForPath(canonical(to).split(/[?#]/)[0]) ?? (canonical(to) === '/' ? screenForPath('/clinician') : undefined)
  return spec ? mayOpen(persona, spec.permission) : true
}

/** The bell's items for the signed-in persona: a patient waiting in a video call first, the inbox it may act on, and what it sent. */
export function useNotices() {
  const persona = useSession((s) => s.persona)
  const sent = useNotifications(useShallow((s) => s.sent))
  const waiting = useWaiting(useShallow((s) => waitingList(s.waiting)))
  const lobby: Notice[] = waiting.map((w) => ({
    id: `W-${w.visitId}`,
    severity: 'urgent',
    kind: 'video',
    direction: 'in',
    title: `${patient(w.patientId).name} is waiting in the video call`,
    detail: `${visitById(w.visitId)?.reason ?? 'Video visit'} · open the visit to connect`,
    to: `/tele/session/${w.visitId}`,
  }))
  return { inbox: [...lobby, ...INBOX].filter((n) => openable(persona, n.to)), sent }
}
