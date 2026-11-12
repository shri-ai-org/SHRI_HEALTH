// SHRI_HEALTH: where an AI statement's source opens (AI-02 summaries and the assistant's answers,
// D70): each AiSourceLink names a FHIR resource of the patient's chart; the record page that shows
// that kind of record is the place to check it. Patient links carry only the opaque ID (D13).
import type { AiSourceLink } from '../../src/api/generated/model'

const PAGE_BY_TYPE: Record<string, string> = {
  Condition: 'condition',
  MedicationRequest: 'prescriptions',
  MedicationStatement: 'prescriptions',
  Composition: 'notes',
  DocumentReference: 'notes',
  Encounter: 'notes',
  Appointment: 'appointments',
  DiagnosticReport: 'results',
  Observation: 'record',
  AllergyIntolerance: 'record',
  FamilyMemberHistory: 'history',
  Procedure: 'history',
}

/** The record page for one source, for the patient the statement is about. */
export function routeForAiSource(patientId: string, source: AiSourceLink): string {
  return `/patient/${patientId}/${PAGE_BY_TYPE[source.resourceType] ?? 'timeline'}`
}

const LABEL_BY_TYPE: Record<string, string> = {
  Condition: 'Problem',
  MedicationRequest: 'Medication',
  MedicationStatement: 'Medication',
  Composition: 'Note',
  DocumentReference: 'Document',
  Encounter: 'Visit',
  Appointment: 'Appointment',
  DiagnosticReport: 'Result',
  Observation: 'Observation',
  AllergyIntolerance: 'Allergy',
  FamilyMemberHistory: 'Family history',
  Procedure: 'Procedure',
  Transcription: 'Transcript',
}

/** What the link says: the source's own label, or the kind of record. */
export function aiSourceLabel(source: AiSourceLink): string {
  return source.label?.trim() || LABEL_BY_TYPE[source.resourceType] || source.resourceType
}
