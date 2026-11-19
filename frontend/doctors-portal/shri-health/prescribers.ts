// SHRI_HEALTH data layer: the pharmacy of each signed medicine on the record's Prescriptions page.
// The prescriber's name comes with the medication list (prescriberDisplayName), but the pharmacy
// doesn't, so each medicine with a prescriptionId reads its prescription (getPrescription) for
// pharmacyName: all at once, once per prescription, kept for the page. A failed or refused lookup, or
// a prescription with no pharmacy, shows no pharmacy line; the list never waits.
import { useEffect, useState } from 'react'

import { getPrescription } from '../../src/api/generated/endpoints/medications/medications'

/** A pharmacy's name; null when there is none or the lookup failed; absent while it is still being read. */
export type PharmacyNames = Record<string, string | null>

const pharmacies = new Map<string, Promise<string | null>>()

function pharmacyOf(prescriptionId: string): Promise<string | null> {
  let found = pharmacies.get(prescriptionId)
  if (!found) {
    found = getPrescription(prescriptionId).then(
      (res) => (res.status === 200 && res.data.pharmacyName ? res.data.pharmacyName : null),
      () => null,
    )
    // A failed lookup is tried again the next time the page opens; a name is kept.
    void found.then((name) => name ?? pharmacies.delete(prescriptionId))
    pharmacies.set(prescriptionId, found)
  }
  return found
}

/** The pharmacies of these prescriptions, filled in as each lookup answers. */
export function usePharmacyNames(prescriptionIds: string[]): PharmacyNames {
  const key = [...new Set(prescriptionIds)].sort().join(',')
  const [found, setFound] = useState<PharmacyNames>({})
  useEffect(() => {
    if (!key) return
    let live = true
    for (const id of key.split(',')) {
      void pharmacyOf(id).then((name) => live && setFound((current) => ({ ...current, [id]: name })))
    }
    return () => {
      live = false
    }
  }, [key])
  return found
}

/** For tests: forget every pharmacy read. */
export function forgetPharmacies(): void {
  pharmacies.clear()
}
