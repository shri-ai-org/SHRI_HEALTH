// SHRI_HEALTH data layer: the record's Vitals card from GET /patients/{id}/vitals, read once
// through Suspense. The latest reading of each type is the card's value; earlier readings of the
// same type are its sparkline. Nothing is sampled: a patient without readings shows the card's
// "No observations charted".
import type { VitalRow, VitalSeries } from '@/data/vitals-history'

import { listPatientVitals } from '../../src/api/generated/endpoints/encounters/encounters'
import type { Vital, VitalType } from '../../src/api/generated/model'
import { SINGLE_VITALS, VITAL_LABEL } from '../../src/features/clinical/vitals'

import { clinicDate } from './format'
import { read } from './resource'

export interface PatientVitals {
  rows: VitalRow[]
  history: VitalSeries[]
}

/** The unit as rooming shows it, by type: heart and breathing rates share "/min". */
const UNIT_LABEL: Partial<Record<VitalType, string>> = Object.fromEntries(SINGLE_VITALS.map((v) => [v.type, v.unitLabel]))
const unitOf = (type: VitalType, unit: string) => (unit === 'mm[Hg]' ? 'mmHg' : unit === 'kg/m2' ? 'kg/m²' : (UNIT_LABEL[type] ?? unit))

/** The card's order: the measures a clinician looks at first. */
const ORDER: VitalType[] = ['blood-pressure', 'heart-rate', 'respiratory-rate', 'body-temperature', 'oxygen-saturation', 'body-weight', 'body-height', 'bmi', 'head-circumference']

function flagOf(v: Vital): VitalRow['flag'] {
  if (v.interpretation === 'H' || v.interpretation === 'HH') return '↑ High'
  if (v.interpretation === 'L' || v.interpretation === 'LL') return '↓ Low'
  return 'Normal'
}

function valueOf(v: Vital): string | null {
  if (v.bloodPressure) return `${v.bloodPressure.systolic.value}/${v.bloodPressure.diastolic.value} mmHg`
  if (v.value) return `${v.value.value} ${unitOf(v.type, v.value.unit)}`
  return null
}

/** The number a sparkline draws: systolic for blood pressure. */
const pointOf = (v: Vital): number | null => v.bloodPressure?.systolic.value ?? v.value?.value ?? null

async function load(patientId: string): Promise<PatientVitals> {
  const all: Vital[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page += 1) {
    const res = await listPatientVitals(patientId, { limit: 100, ...(cursor ? { cursor } : {}) })
    const data = res.data as { items: Vital[]; nextCursor?: string | null }
    all.push(...data.items)
    cursor = data.nextCursor ?? undefined
    if (!cursor) break
  }
  const kept = all.filter((v) => v.status !== 'entered-in-error').sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
  const rows: VitalRow[] = []
  const history: VitalSeries[] = []
  for (const type of ORDER) {
    const ofType = kept.filter((v) => v.type === type)
    const latest = ofType.at(-1)
    const value = latest && valueOf(latest)
    if (!latest || !value) continue
    const label = VITAL_LABEL[type]
    rows.push({ label, value, flag: flagOf(latest), at: clinicDate(latest.effectiveAt) })
    const points = ofType.flatMap((v) => {
      const n = pointOf(v)
      return n === null ? [] : [{ at: clinicDate(v.effectiveAt), value: n }]
    })
    history.push({ label, unit: type === 'blood-pressure' ? 'mmHg' : unitOf(type, latest.value?.unit ?? ''), points })
  }
  return { rows, history }
}

/** The patient's vitals, for the record's Vitals card. */
export function vitalsFor(patientId: string): PatientVitals {
  return read(`vitals:${patientId}`, () => load(patientId))
}
