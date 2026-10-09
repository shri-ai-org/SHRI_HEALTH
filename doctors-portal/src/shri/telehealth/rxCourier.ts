// Prescriptions on their way to the patient's portal page, through the visit's
// video room (RxCourier delivers them; callLink.ts carries them). Kept in memory:
// a delivery lives as long as this page does.

import { create } from 'zustand'

import type { SentRx } from './callLink'

export interface RxJob {
  room: string
  patientName: string
  patientId: string
  visitId: string
  rx: SentRx
}

/** A prescription to send: stamped with its id and the moment it was signed here. */
export type RxToSend = Omit<RxJob, 'rx'> & { rx: Omit<SentRx, 'id' | 'signedAt'> }

export const useCourier = create<{ jobs: RxJob[]; send: (j: RxToSend) => void; done: (id: string) => void }>()((set) => ({
  jobs: [],
  send: (j) => {
    const at = Date.now()
    set((s) => ({ jobs: [...s.jobs, { ...j, rx: { ...j.rx, id: `RX-${at.toString(36)}`, signedAt: at } }] }))
  },
  done: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.rx.id !== id) })),
}))
