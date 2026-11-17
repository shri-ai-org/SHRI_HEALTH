// SHRI_HEALTH: the record overview's "At a glance" card (src/shri/record/GlanceCard.tsx). Six reads
// that already serve the record, fetched in parallel, each row on its own: a failed read fails its
// row only, and a restricted chart (403 break-glass-required) fails the whole card, so the route's
// sealed card shows instead of part of the chart.
//   problems     ⇐ listProblems: active, recurrence or relapse, names only
//   medications  ⇐ listMedications: active only, name and directions
//   allergies    ⇐ listAllergies: substance and reaction; "No known allergies" only for the
//                  SNOMED CT 716186003 statement, "Not recorded" for an empty list
//   vitals       ⇐ listPatientVitals: the latest set (the readings taken at the latest time)
//   abnormal labs⇐ listLabResults: the three newest results flagged H, L, HH, LL or A
//   last visit   ⇐ listPatientEncounters: the newest finished visit, its type and clinician
// Every list is newest first from the API; one page of up to 100 is read for each.

import { ApiError } from '../../../../src/api/client'
import { listPatientEncounters, listPatientVitals } from '../../../../src/api/generated/endpoints/encounters/encounters'
import { listAllergies, listProblems } from '../../../../src/api/generated/endpoints/history/history'
import { listMedications } from '../../../../src/api/generated/endpoints/medications/medications'
import { listLabResults } from '../../../../src/api/generated/endpoints/orders/orders'
import type { Allergy, CodeableConcept, EncounterSummary, LabResult, Medication, Problem2, Vital } from '../../../../src/api/generated/model'
import { SINGLE_VITALS } from '../../../../src/features/clinical/vitals'

const PAGE = 100
export const MAX_LISTED = 5
export const MAX_LABS = 3
/** SNOMED CT "No known allergy" (the contract's no-known-allergies statement). */
const NO_KNOWN_ALLERGY = '716186003'
const ACTIVE_PROBLEM = new Set(['active', 'recurrence', 'relapse'])

export type GlanceKey = 'problems' | 'medications' | 'allergies' | 'vitals' | 'labs' | 'lastVisit'
export const GLANCE_KEYS: GlanceKey[] = ['problems', 'medications', 'allergies', 'vitals', 'labs', 'lastVisit']

export interface Listed<T> {
  items: T[]
  /** How many more there are beyond those listed. */
  more: number
}
export interface MedLine {
  name: string
  directions?: string
}
export interface AllergyLine {
  substance: string
  reaction?: string
}
export type AllergyRow = { kind: 'none-known' } | { kind: 'not-recorded' } | { kind: 'listed'; items: AllergyLine[] }
export interface VitalLine {
  label: string
  value: string
}
export interface VitalsSet {
  at: string
  readings: VitalLine[]
}
export interface AbnormalLab {
  test: string
  value: string
  unit?: string
  flag: string
  at: string
}
export interface LastVisit {
  at: string
  type?: string
  clinician?: string
}

export interface GlanceData {
  problems: Listed<string>
  medications: Listed<MedLine>
  allergies: AllergyRow
  vitals: VitalsSet | null
  labs: AbnormalLab[]
  lastVisit: LastVisit | null
}

export type RowState<K extends GlanceKey> = { status: 'ok'; data: GlanceData[K] } | { status: 'error' }
export type Glance = { [K in GlanceKey]: RowState<K> }

const textOf = (c: CodeableConcept, fallback: string) => c.text ?? c.codings?.[0]?.display ?? fallback
const listed = <T>(all: T[], max = MAX_LISTED): Listed<T> => ({ items: all.slice(0, max), more: Math.max(0, all.length - max) })

// ---- the six rows, from their API items (newest first) ----

export function problemsRow(items: Problem2[]): Listed<string> {
  return listed(items.filter((p) => p.clinicalStatus !== undefined && ACTIVE_PROBLEM.has(p.clinicalStatus)).map((p) => textOf(p.code, 'Problem')))
}

export function medicationsRow(items: Medication[]): Listed<MedLine> {
  return listed(items.filter((m) => m.status === 'active').map((m) => ({ name: textOf(m.medication, 'Medication'), ...(m.dosageText ? { directions: m.dosageText } : {}) })))
}

export function allergiesRow(items: Allergy[]): AllergyRow {
  const live = items.filter((a) => a.verificationStatus !== 'entered-in-error' && a.verificationStatus !== 'refuted' && a.clinicalStatus !== 'inactive' && a.clinicalStatus !== 'resolved')
  const known = live.filter((a) => !a.code.codings?.some((c) => c.code === NO_KNOWN_ALLERGY))
  if (known.length > 0) {
    return {
      kind: 'listed',
      items: known.map((a) => {
        const reaction = a.reactions?.flatMap((r) => r.manifestations.map((m) => textOf(m, ''))).filter(Boolean).join(', ')
        return { substance: textOf(a.code, 'Allergy'), ...(reaction ? { reaction } : {}) }
      }),
    }
  }
  return live.length > 0 ? { kind: 'none-known' } : { kind: 'not-recorded' }
}

const VITAL_LABEL: Record<string, string> = {
  'blood-pressure': 'BP',
  'heart-rate': 'Pulse',
  'respiratory-rate': 'Resp',
  'body-temperature': 'Temp',
  'oxygen-saturation': 'SpO₂',
  'body-weight': 'Weight',
  'body-height': 'Height',
  bmi: 'BMI',
  'head-circumference': 'Head',
}
const VITAL_ORDER = Object.keys(VITAL_LABEL)
/** The unit as rooming and the Vitals card show it (shri-health/vitals.ts): "mmHg", "lb", "/min". */
const ROOMING_UNIT: Partial<Record<string, string>> = Object.fromEntries(SINGLE_VITALS.map((v) => [v.type, v.unitLabel]))
const unitOf = (type: string, unit: string) => (unit === 'mm[Hg]' ? 'mmHg' : unit === 'kg/m2' ? 'kg/m²' : (ROOMING_UNIT[type] ?? unit))

export function vitalsRow(items: Vital[]): VitalsSet | null {
  const taken = items.filter((v) => v.status !== 'entered-in-error')
  if (taken.length === 0) return null
  const at = taken.reduce((latest, v) => (Date.parse(v.effectiveAt) > Date.parse(latest) ? v.effectiveAt : latest), taken[0].effectiveAt)
  const readings = taken
    .filter((v) => v.effectiveAt === at)
    .sort((a, b) => VITAL_ORDER.indexOf(a.type) - VITAL_ORDER.indexOf(b.type))
    .flatMap((v): VitalLine[] => {
      const label = VITAL_LABEL[v.type] ?? v.type
      if (v.bloodPressure) return [{ label, value: `${v.bloodPressure.systolic.value}/${v.bloodPressure.diastolic.value} mmHg` }]
      return v.value ? [{ label, value: `${v.value.value} ${unitOf(v.type, v.value.unit)}` }] : []
    })
  return { at, readings }
}

const LAB_FLAG: Record<string, string> = { H: 'High', L: 'Low', HH: 'Critical high', LL: 'Critical low', A: 'Abnormal' }

export function labsRow(items: LabResult[]): AbnormalLab[] {
  const flagged: AbnormalLab[] = []
  const newest = [...items].sort((a, b) => Date.parse(b.collectedAt ?? b.issuedAt ?? '') - Date.parse(a.collectedAt ?? a.issuedAt ?? ''))
  for (const r of newest) {
    const at = r.collectedAt ?? r.issuedAt
    if (!at) continue
    for (const o of r.observations) {
      const flag = o.interpretation ? LAB_FLAG[o.interpretation] : undefined
      if (!flag) continue
      flagged.push({ test: textOf(o.code, 'Result'), value: o.value ? String(o.value.value) : (o.valueText ?? '—'), ...(o.value?.unit ? { unit: o.value.unit } : {}), flag, at })
      if (flagged.length === MAX_LABS) return flagged
    }
  }
  return flagged
}

export function lastVisitRow(items: EncounterSummary[]): LastVisit | null {
  const visit = items.filter((e) => e.status === 'finished').sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
  if (!visit) return null
  const type = visit.types?.[0] ? textOf(visit.types[0], '') : ''
  return { at: visit.startedAt, ...(type ? { type } : {}), ...(visit.renderingProvider ? { clinician: visit.renderingProvider.displayName } : {}) }
}

// ---- the reads ----

/** The chart is restricted: the route's sealed card shows instead of the card. */
export const isRestricted = (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === 'break-glass-required'

async function itemsOf<T>(call: Promise<{ status: number; data: unknown }>): Promise<T[]> {
  const res = await call
  if (res.status !== 200) throw new Error('The read did not answer 200')
  return (res.data as { items: T[] }).items
}

/** One row's read and shape. */
export function loadRow<K extends GlanceKey>(key: K, patientId: string): Promise<GlanceData[K]> {
  const page = { limit: PAGE }
  const loaders: { [P in GlanceKey]: () => Promise<GlanceData[P]> } = {
    problems: async () => problemsRow(await itemsOf<Problem2>(listProblems(patientId, page))),
    medications: async () => medicationsRow(await itemsOf<Medication>(listMedications(patientId, page))),
    allergies: async () => allergiesRow(await itemsOf<Allergy>(listAllergies(patientId, page))),
    vitals: async () => vitalsRow(await itemsOf<Vital>(listPatientVitals(patientId, page))),
    labs: async () => labsRow(await itemsOf<LabResult>(listLabResults(patientId, page))),
    lastVisit: async () => lastVisitRow(await itemsOf<EncounterSummary>(listPatientEncounters(patientId, page))),
  }
  return loaders[key]()
}

/** All six at once. Throws only for a restricted chart; any other failure fails its row. */
export async function loadGlance(patientId: string): Promise<Glance> {
  const settled = await Promise.allSettled(GLANCE_KEYS.map((k) => loadRow(k, patientId)))
  const restricted = settled.find((s) => s.status === 'rejected' && isRestricted(s.reason))
  if (restricted && restricted.status === 'rejected') throw restricted.reason
  return Object.fromEntries(
    GLANCE_KEYS.map((k, i) => {
      const s = settled[i]
      return [k, s.status === 'fulfilled' ? { status: 'ok', data: s.value } : { status: 'error' }]
    }),
  ) as Glance
}
