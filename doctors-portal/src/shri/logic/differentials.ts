// ported from src/screens/m06/S0603.tsx:108-190 (`DIFFERENTIALS`, `differentialsFor`):
// AI-203's differential per patient, word for word. A patient without charted
// evidence for a differential gets none, not somebody else's.

import type { ConfidenceBand } from '@/atlas/confidence'

export interface Differential {
  title: string
  evidence: string
  confidence: number
  band: ConfidenceBand
}

const DIFFERENTIALS: Record<string, Differential[]> = {
  'SD-P-03': [
    {
      title: 'Parapneumonic effusion or empyema',
      evidence: 'CRP nearly doubled at 72h with a rising oxygen requirement and no organism identified.',
      confidence: 0.71,
      band: 'MED',
    },
    {
      title: 'Resistant or atypical organism',
      evidence: 'Blood culture negative at 48h on broad beta-lactam cover.',
      confidence: 0.64,
      band: 'MED',
    },
    {
      title: 'Hospital-acquired secondary infection',
      evidence: 'Day 4 of admission with a new fever spike.',
      confidence: 0.42,
      band: 'LOW',
    },
  ],
  'SD-P-01': [
    {
      title: 'Adequately replaced primary hypothyroidism',
      evidence: 'TSH 2.4 within target on an unchanged dose, with symptom resolution.',
      confidence: 0.92,
      band: 'HIGH',
    },
    {
      title: 'Coexisting iron deficiency',
      evidence: 'Ferritin 14 ng/mL with a borderline haemoglobin of 11.9 g/dL, falling over a year.',
      confidence: 0.78,
      band: 'MED',
    },
  ],
  'SD-P-11': [
    {
      title: 'Hyponatraemia — low intake or a medicine effect',
      evidence: 'Sodium 134 → 131 mmol/L since discharge; levetiracetam started 3 weeks ago.',
      confidence: 0.61,
      band: 'MED',
    },
    {
      title: 'Recurrent subdural collection',
      evidence: 'No new headache, confusion or weakness is charted; the planned CT is on 12-Oct.',
      confidence: 0.22,
      band: 'LOW',
    },
  ],
  'SD-P-15': [
    {
      title: 'Migraine without aura, responding to prophylaxis',
      evidence: 'Attacks down from six to two a month on propranolol; CT head and ESR normal.',
      confidence: 0.88,
      band: 'HIGH',
    },
    {
      title: 'Medication-overuse headache',
      evidence: 'Naproxen as needed — worth confirming it stays under 10 days a month.',
      confidence: 0.24,
      band: 'LOW',
    },
  ],
  'SD-P-16': [
    {
      title: 'Minor head injury, recovered',
      evidence: 'GCS 15 throughout, CT head normal, headaches resolved within a week.',
      confidence: 0.9,
      band: 'HIGH',
    },
  ],
}

export function differentialsFor(patientId: string): Differential[] {
  return DIFFERENTIALS[patientId] ?? []
}
