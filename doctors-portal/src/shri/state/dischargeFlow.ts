/**
 * The record's discharge flow (plan 4.6): which patient's sheet is open, and a
 * draft of the answers per patient — kept, so stepping out to write the
 * summary or reconcile the medicines and coming back loses nothing. The draft
 * is cleared once the discharge is recorded.
 *
 * DEV: `?open=discharge:SD-P-03` opens the sheet for a headless screenshot.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { IcdCode } from '@/data/icd10'

export type FlowKind = 'discharge' | 'transfer' | 'lama'

export interface FlowDraft {
  kind: FlowKind
  careOf: string
  followUp: 'booked' | 'none' | ''
  fuDate: string
  fuClinic: string
  fuNote: string
  fuNoneReason: string
  facility: string
  outsideName: string
  clinician: string
  reason: string
  escort: string
  transport: string
  handover: string
  accepted: boolean
  lamaRisks: boolean
  lamaSignedBy: string
  lamaRelationship: string
  lamaWitness: string
  lamaReason: string
  /** The final diagnosis, ICD-10 coded — the first is the principal. Optional. */
  diagnoses: IcdCode[]
}

interface DischargeFlowState {
  openFor: string | null
  drafts: Record<string, Partial<FlowDraft>>
  open: (patientId: string) => void
  close: () => void
  update: (patientId: string, patch: Partial<FlowDraft>) => void
  clear: (patientId: string) => void
}

function devOpenFor(): string | null {
  if (!import.meta.env.DEV) return null
  const token = new URLSearchParams(window.location.search)
    .get('open')
    ?.split(',')
    .find((t) => t.startsWith('discharge:'))
  return token ? token.slice('discharge:'.length) : null
}

export const useDischargeFlow = create<DischargeFlowState>()(
  persist(
    (set, get) => ({
      openFor: devOpenFor(),
      drafts: {},
      open: (openFor) => set({ openFor }),
      close: () => set({ openFor: null }),
      update: (patientId, patch) => set({ drafts: { ...get().drafts, [patientId]: { ...get().drafts[patientId], ...patch } } }),
      clear: (patientId) => {
        const drafts = { ...get().drafts }
        delete drafts[patientId]
        set({ drafts })
      },
    }),
    { name: 'shri.dischargeFlow', version: 1, partialize: (s) => ({ drafts: s.drafts }) },
  ),
)
