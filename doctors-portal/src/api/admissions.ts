/**
 * `POST /admissions/create` — the one call the doctor's screens make.
 *
 * This build is static and has no server, so the endpoint is answered in the
 * browser. This file is the whole boundary: when a real service exists,
 * `createAdmission` becomes a `fetch` and `useAdmissionService` goes away,
 * and nothing that calls them changes.
 *
 * On create, three things happen that the doctor never sees:
 *   1. the front desk's queue gains a row  — `pendingAdmissions()`
 *   2. bed allocation is asked for a bed    — `advance()` → `allocateBed()`
 *   3. the inpatient module takes the patient once admitted — `inpatientRows()`
 */

import { useEffect } from 'react'

import { PRIORITY_LABEL, TYPE_LABEL } from '@/data/admissions'
import type { CreateAdmissionRequest, CreateAdmissionResponse } from '@/data/admissions'
import { NOW } from '@/data/format'
import { patient } from '@/data/kit'
import { nextDueAt, useAdmissions } from '@/store/admissions'
import { useAudit } from '@/store/audit'
import { useUI } from '@/store/ui'

/**
 * Creates the admission and resolves with it. The record is written before
 * the promise settles, so the patient's chip changes on the same render as
 * the confirmation.
 */
export async function createAdmission(req: CreateAdmissionRequest): Promise<CreateAdmissionResponse> {
  const result = useAdmissions.getState().create(req, Date.now())
  if (result.created) {
    useAudit.getState().record({
      event: 'ADMISSION.REQUESTED',
      actor: req.requestedBy.name,
      actorId: req.requestedBy.id,
      subject: req.patientId,
      at: NOW.toISOString(),
      detail: `${TYPE_LABEL[req.type]} · ${PRIORITY_LABEL[req.priority]}`,
    })
  }
  return result
}

/**
 * The front office, simulated: allocates the bed and completes the admission
 * when each step falls due. Mounted once, in the app shell. It catches up on
 * mount — a reload mid-admission lands where the admission should be — and
 * keeps one timer, only while something is in progress.
 */
export function useAdmissionService(): void {
  const admissions = useAdmissions((s) => s.admissions)
  const advance = useAdmissions((s) => s.advance)
  const toast = useUI((s) => s.toast)

  useEffect(() => {
    function run() {
      for (const a of advance(Date.now())) {
        toast({
          tone: 'success',
          title: `${patient(a.patientId).name} admitted${a.bed ? ` · ${a.bed}` : ''}`,
          detail: 'Now on your Inpatients list.',
        })
      }
    }

    run()
    const due = Object.values(useAdmissions.getState().admissions)
      .map(nextDueAt)
      .filter((t): t is number => t !== undefined)
    if (due.length === 0) return
    // At least a second apart, so an admission waiting for a free bed retries rather than spins.
    const timer = window.setTimeout(run, Math.max(Math.min(...due) - Date.now(), 1000))
    return () => window.clearTimeout(timer)
  }, [admissions, advance, toast])
}
