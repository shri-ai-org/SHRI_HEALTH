// The record's Prescriptions page with the API: what each medicine's "by" and "since" read.
import type { PrescriberNames } from '../../../shri-health/prescribers'
import { formatDate } from '../../../shri-health/format'

/**
 * Who it is by: the prescriber's name for a signed medicine (getPrescription), "Prescriber
 * unavailable" when that lookup failed, and the list's own words ("Prescribed here", "Reported") for a
 * medicine with no prescription. recordedBy is never shown as a prescriber: for a reported medicine it
 * is whoever entered it.
 */
export function prescriberText(m: { prescriptionId?: string; by: string }, names: PrescriberNames): string | undefined {
  if (!m.prescriptionId) return m.by
  if (!(m.prescriptionId in names)) return undefined
  return names[m.prescriptionId] ?? 'Prescriber unavailable'
}

/**
 * The day it went on the list, U.S. style, in the clinic's calendar. `since` is already clinic time
 * (clinicDate), so it is read as it stands; converting it again put evening-UTC entries a day early.
 */
export function sinceText(since: Date): string {
  return formatDate(since)
}
