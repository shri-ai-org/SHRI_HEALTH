/**
 * The admissions ordered this session, one per patient.
 *
 * The front office's part — bed allocation, then completing the admission —
 * is simulated by `advance()`, on fixed delays from the moment the doctor
 * confirmed. The delays count from `requestedAt`, not from whenever the
 * timer happened to fire, so a reload or a throttled background tab lands on
 * exactly the same state.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { allocateBed, occupiedBeds } from '@/data/admissions'
import type { Admission, Admissions, CreateAdmissionRequest } from '@/data/admissions'

/** A bed is allocated this long after the doctor confirms. */
export const BED_AFTER_MS = 20_000
/** And the patient is admitted this long after the doctor confirms. */
export const ADMIT_AFTER_MS = 45_000

/** When this admission's next step falls due, or `undefined` once it is complete. */
export function nextDueAt(a: Admission): number | undefined {
  if (a.admittedAt !== undefined) return undefined
  return a.bed === undefined ? a.requestedAt + BED_AFTER_MS : a.requestedAt + ADMIT_AFTER_MS
}

interface AdmissionsState {
  admissions: Admissions
  /** Idempotent per patient: a patient who already has an admission gets that one back. */
  create: (req: CreateAdmissionRequest, at: number) => { admission: Admission; created: boolean }
  /**
   * Applies every step that has fallen due by `now`, and returns the
   * admissions that completed. Writes nothing when nothing is due, so an open
   * modal is not re-rendered by a tick.
   */
  advance: (now: number) => Admission[]
  reset: () => void
}

let seq = 0
function admissionId(): string {
  seq += 1
  return `ADM-${Date.now().toString(36)}-${seq}`
}

export const useAdmissions = create<AdmissionsState>()(
  persist(
    (set, get) => ({
      admissions: {},

      create: (req, at) => {
        const existing = get().admissions[req.patientId]
        if (existing) return { admission: existing, created: false }
        const admission: Admission = {
          id: admissionId(),
          patientId: req.patientId,
          encounterId: req.encounterId,
          type: req.type,
          priority: req.priority,
          note: req.note?.trim() || undefined,
          requestedBy: req.requestedBy.name,
          requestedById: req.requestedBy.id,
          requestedAt: at,
        }
        set({ admissions: { ...get().admissions, [req.patientId]: admission } })
        return { admission, created: true }
      },

      advance: (now) => {
        const current = get().admissions
        const next: Admissions = { ...current }
        // Beds handed out in this pass count as taken for the next one.
        const occupied = occupiedBeds(current)
        const completed: Admission[] = []
        let changed = false

        for (const a of Object.values(current)) {
          let updated = a
          if (updated.bed === undefined && now >= updated.requestedAt + BED_AFTER_MS) {
            const bed = allocateBed(updated.type, occupied)
            // No free bed: the admission waits, and is tried again on the next tick.
            if (bed === undefined) continue
            occupied.add(bed)
            updated = { ...updated, bed, bedAt: updated.requestedAt + BED_AFTER_MS }
          }
          if (updated.bed !== undefined && updated.admittedAt === undefined && now >= updated.requestedAt + ADMIT_AFTER_MS) {
            updated = { ...updated, admittedAt: updated.requestedAt + ADMIT_AFTER_MS }
            completed.push(updated)
          }
          if (updated !== a) {
            next[a.patientId] = updated
            changed = true
          }
        }

        if (changed) set({ admissions: next })
        return completed
      },

      reset: () => set({ admissions: {} }),
    }),
    { name: 'indostates.admissions' },
  ),
)
