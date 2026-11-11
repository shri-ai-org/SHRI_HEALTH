// SHRI_HEALTH data layer: `maybeEncounter` (src/shri/logic/encounter.ts) over GET /encounters/{id}.
import type { Encounter } from '@/data/clinical'

import { ApiError } from '../../src/api/client'
import { getEncounter } from '../../src/api/generated/endpoints/encounters/encounters'
import type { Encounter as ApiEncounter } from '../../src/api/generated/model'

import { clinicDate } from './format'
import { read } from './resource'

export { encounterLabel } from '../src/shri/logic/encounter'

/** The encounter at an address, or none: a 404, or an id that isn't a UUID (422), is "none". */
export function maybeEncounter(id: string | undefined): Encounter | undefined {
  if (!id) return undefined
  return read(`encounter:${id}`, async () => {
    try {
      return toEncounter((await getEncounter(id)).data as ApiEncounter)
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 422)) return undefined
      throw error
    }
  })
}

function toEncounter(e: ApiEncounter): Encounter {
  return {
    id: e.id,
    // TODO(gap): the contract has no encounter number; the screen shows an empty one.
    encounterNo: '',
    patientId: e.patientId,
    type: e.class === 'VR' ? 'TELE' : 'OP',
    startedAt: clinicDate(e.startedAt ?? e.createdAt),
    consultantStaffId: e.participants.find((p) => p.role === 'rendering')?.practitionerId ?? '',
    // TODO(gap): US ambulatory care has no department on the encounter.
    department: '',
  }
}
