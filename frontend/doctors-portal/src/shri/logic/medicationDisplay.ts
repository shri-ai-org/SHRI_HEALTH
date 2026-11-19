// The record's Prescriptions page with the API: what each medicine's pharmacy and "since" read.
import type { PharmacyNames } from '../../../shri-health/prescribers'
import { formatDate } from '../../../shri-health/format'

/**
 * The pharmacy line of a signed medicine (getPrescription's pharmacyName): "Pharmacy: …" once read,
 * and nothing while it is read, when the lookup failed, when the prescription names no pharmacy, or
 * for a medicine with no prescription. A name is never made up.
 */
export function pharmacyText(m: { prescriptionId?: string }, pharmacies: PharmacyNames): string | undefined {
  const name = m.prescriptionId ? pharmacies[m.prescriptionId] : undefined
  return name ? `Pharmacy: ${name}` : undefined
}

/**
 * The day it went on the list, U.S. style, in the clinic's calendar. `since` is already clinic time
 * (clinicDate), so it is read as it stands; converting it again put evening-UTC entries a day early.
 */
export function sinceText(since: Date): string {
  return formatDate(since)
}
