import type { VitalEntry, VitalType } from '../../api/generated/model'

/**
 * The rooming vitals form: what the MA types, in the U.S. units they read off the device. Values
 * are sent in the unit entered (D69); the server flags out-of-range values and never refuses
 * them, so the form only checks that each one is a number.
 */
export interface VitalsForm {
  systolic: string
  diastolic: string
  heartRate: string
  respiratoryRate: string
  temperature: string
  oxygenSaturation: string
  height: string
  weight: string
}

export const EMPTY_VITALS: VitalsForm = { systolic: '', diastolic: '', heartRate: '', respiratoryRate: '', temperature: '', oxygenSaturation: '', height: '', weight: '' }

/** Each single-value field: its vital type, UCUM unit, label and whether decimals make sense. */
export const SINGLE_VITALS: Array<{ field: Exclude<keyof VitalsForm, 'systolic' | 'diastolic'>; type: VitalType; unit: string; label: string; unitLabel: string; decimals: boolean }> = [
  { field: 'heartRate', type: 'heart-rate', unit: '/min', label: 'Heart rate', unitLabel: 'beats/min', decimals: false },
  { field: 'respiratoryRate', type: 'respiratory-rate', unit: '/min', label: 'Respiratory rate', unitLabel: 'breaths/min', decimals: false },
  { field: 'temperature', type: 'body-temperature', unit: '[degF]', label: 'Temperature', unitLabel: '°F', decimals: true },
  { field: 'oxygenSaturation', type: 'oxygen-saturation', unit: '%', label: 'Oxygen saturation', unitLabel: '%', decimals: false },
  { field: 'height', type: 'body-height', unit: '[in_i]', label: 'Height', unitLabel: 'in', decimals: true },
  { field: 'weight', type: 'body-weight', unit: '[lb_av]', label: 'Weight', unitLabel: 'lb', decimals: true },
]

const WHOLE = /^\d{1,4}$/
const DECIMAL = /^\d{1,4}(\.\d{1,2})?$/

export type VitalsErrors = Partial<Record<keyof VitalsForm, string>>

/** The entries to send, or the fields to fix. Empty fields are left out; nothing typed is an error too. */
export function toVitalEntries(form: VitalsForm): { entries: VitalEntry[]; errors: VitalsErrors } {
  const errors: VitalsErrors = {}
  const entries: VitalEntry[] = []

  const sys = form.systolic.trim()
  const dia = form.diastolic.trim()
  if (sys || dia) {
    if (!WHOLE.test(sys)) errors.systolic = sys ? 'Enter a whole number.' : 'Enter both blood pressure values.'
    if (!WHOLE.test(dia)) errors.diastolic = dia ? 'Enter a whole number.' : 'Enter both blood pressure values.'
    if (!errors.systolic && !errors.diastolic) {
      entries.push({ type: 'blood-pressure', bloodPressure: { systolic: { value: Number(sys), unit: 'mm[Hg]' }, diastolic: { value: Number(dia), unit: 'mm[Hg]' } } })
    }
  }

  for (const v of SINGLE_VITALS) {
    const raw = form[v.field].trim()
    if (!raw) continue
    if (!(v.decimals ? DECIMAL : WHOLE).test(raw)) {
      errors[v.field] = v.decimals ? 'Enter a number, up to 2 decimals.' : 'Enter a whole number.'
      continue
    }
    entries.push({ type: v.type, value: { value: Number(raw), unit: v.unit } })
  }

  return { entries, errors }
}

/** BMI from inches and pounds, shown while typing; the server keeps the measured values. */
export function bmi(form: VitalsForm): number | null {
  if (!DECIMAL.test(form.height.trim()) || !DECIMAL.test(form.weight.trim())) return null
  const inches = Number(form.height)
  const pounds = Number(form.weight)
  if (inches <= 0 || pounds <= 0) return null
  return Math.round(((703 * pounds) / (inches * inches)) * 10) / 10
}

/** Labels for the server's interpretation flag (FHIR v3 ObservationInterpretation). */
export const INTERPRETATION: Record<string, { label: string; tone: 'warning' | 'critical' }> = {
  L: { label: 'Low', tone: 'warning' },
  H: { label: 'High', tone: 'warning' },
  LL: { label: 'Critically low', tone: 'critical' },
  HH: { label: 'Critically high', tone: 'critical' },
}

export const VITAL_LABEL: Record<VitalType, string> = {
  'blood-pressure': 'Blood pressure',
  'heart-rate': 'Heart rate',
  'respiratory-rate': 'Respiratory rate',
  'body-temperature': 'Temperature',
  'body-height': 'Height',
  'body-weight': 'Weight',
  bmi: 'BMI',
  'oxygen-saturation': 'Oxygen saturation',
  'head-circumference': 'Head circumference',
}
