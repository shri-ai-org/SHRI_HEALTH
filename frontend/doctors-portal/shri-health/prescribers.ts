// SHRI_HEALTH data layer: who wrote each signed medicine on the record's Prescriptions page. The
// medication list has no prescriber name yet, so each medicine with a prescriptionId reads its
// prescription (getPrescription) for prescriberDisplayName: all at once, once per prescription, kept
// for the page. A failed or refused lookup leaves that one medicine "unavailable"; the list never waits.
import { useEffect, useState } from 'react'

import { getPrescription } from '../../src/api/generated/endpoints/medications/medications'

/** A name; null when the lookup failed or was refused; absent while it is still being read. */
export type PrescriberNames = Record<string, string | null>

const names = new Map<string, Promise<string | null>>()

function prescriberOf(prescriptionId: string): Promise<string | null> {
  let found = names.get(prescriptionId)
  if (!found) {
    found = getPrescription(prescriptionId).then(
      (res) => (res.status === 200 && res.data.prescriberDisplayName ? res.data.prescriberDisplayName : null),
      () => null,
    )
    // A failed lookup is tried again the next time the page opens; a name is kept.
    void found.then((name) => name ?? names.delete(prescriptionId))
    names.set(prescriptionId, found)
  }
  return found
}

/** The prescribers of these prescriptions, filled in as each lookup answers. */
export function usePrescriberNames(prescriptionIds: string[]): PrescriberNames {
  const key = [...new Set(prescriptionIds)].sort().join(',')
  const [found, setFound] = useState<PrescriberNames>({})
  useEffect(() => {
    if (!key) return
    let live = true
    for (const id of key.split(',')) {
      void prescriberOf(id).then((name) => live && setFound((current) => ({ ...current, [id]: name })))
    }
    return () => {
      live = false
    }
  }, [key])
  return found
}

/** For tests: forget every name read. */
export function forgetPrescribers(): void {
  names.clear()
}
