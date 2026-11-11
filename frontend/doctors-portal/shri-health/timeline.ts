// SHRI_HEALTH data layer: the record's timeline from what the API holds for the patient: signed
// consultation notes (listPatientEncounters, listEncounterNotes), vitals (listPatientVitals) and the
// medication list (listMedications). Test results, orders and imaging have no service yet, so the
// timeline has none of them; nothing is sampled.
import type { TimelineEvent } from '@/data/clinical'

import { formatTime } from './format'
import { medicationsFor } from './medications'
import { pastNotesFor } from './record'
import { vitalsFor } from './vitals'

/** The patient's record in time order, newest first. Reads through Suspense. */
export function timelineFor(patientId: string): TimelineEvent[] {
  const notes = pastNotesFor(patientId)
  const vitals = vitalsFor(patientId)
  const meds = medicationsFor(patientId)

  const events: TimelineEvent[] = notes.map((n) => ({ at: n.at, kind: 'note', label: `${n.kind} signed`, detail: n.assessment, by: n.by }))

  // One entry per time the vitals were taken, with every reading taken then.
  const taken = new Map<number, string[]>()
  for (const r of vitals.readings) taken.set(r.at.getTime(), [...(taken.get(r.at.getTime()) ?? []), `${r.label} ${r.value}`])
  for (const [at, values] of taken) events.push({ at: new Date(at), kind: 'vitals', label: 'Vitals recorded', detail: values.join(' · '), by: `at ${formatTime(new Date(at))}` })

  for (const m of meds.current) events.push({ at: m.since, kind: 'medication', label: `${m.drug} on the medication list`, detail: m.frequency, by: m.by })
  for (const h of meds.history)
    for (const it of h.items) events.push({ at: h.at, kind: 'medication', label: `${it.drug}: ${it.status.toLowerCase()}`, detail: it.frequency, by: h.by })

  return events.sort((a, b) => b.at.getTime() - a.at.getTime())
}
