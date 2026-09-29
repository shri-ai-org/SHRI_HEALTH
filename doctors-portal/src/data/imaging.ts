/**
 * M-15 · the imaging worklist — every study on the record, with or without
 * pixels behind it.
 *
 * A head CT here is backed by a real, de-identified CQ500 series
 * (`ncct.generated.ts`, imported by `scripts/ncct-import.mjs`), so the viewer
 * shows the actual slices and the AI flag is derived from that series' own
 * ground-truth labels. The X-rays and ultrasounds are report-only: the report
 * is on the record, the pixels are not in this demo — and the screen says so
 * rather than showing somebody else's scan.
 *
 * Study numbers are the ones the rest of the record already cites
 * (ST-9914 in the stroke triage, ST-4471 on R. Lakshmanan's timeline).
 */

import type { NcctStudy } from './ncct.generated'
import { NCCT_STUDIES } from './ncct.generated'
import { maybeStrokeCase } from './stroke'

export type Modality = 'CT' | 'X-ray' | 'Ultrasound'

export interface ImagingStudy {
  id: string
  patientId: string
  modality: Modality
  description: string
  acquiredAt: Date
  /** The imported series behind the viewer. Absent for a report-only study. */
  ncctKey?: string
  priority: 'STAT' | 'Urgent' | 'Routine'
  status: 'Awaiting report' | 'Reported'
  reportedBy?: string
  /** The radiologist's impression, one or two sentences. */
  impression: string
  /** The body of the report, where there is more to say. */
  findings?: string[]
}

export const IMAGING_STUDIES: ImagingStudy[] = [
  {
    id: 'ST-9921',
    patientId: 'SD-P-14',
    modality: 'CT',
    description: 'NCCT head',
    acquiredAt: new Date(2026, 8, 21, 2, 34),
    ncctKey: '0142',
    priority: 'STAT',
    status: 'Awaiting report',
    impression:
      'Large right basal ganglia and thalamic haemorrhage with intraventricular and subarachnoid extension, mass effect and midline shift.',
  },
  {
    id: 'ST-9914',
    patientId: 'SD-P-05',
    modality: 'CT',
    description: 'NCCT head + CT angiogram',
    acquiredAt: new Date(2026, 8, 21, 2, 32),
    ncctKey: '0141',
    priority: 'STAT',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'No haemorrhage. Dense left MCA with early ischaemic change, ASPECTS 8. Left M1 occlusion on CTA.',
    findings: [
      'Hyperdense left MCA sign. Subtle loss of grey–white differentiation in the left insula and lentiform nucleus.',
      'CTA: abrupt cut-off in the left M1 segment, moderate collaterals (Tan 2).',
    ],
  },
  {
    id: 'ST-9880',
    patientId: 'SD-P-03',
    modality: 'CT',
    description: 'NCCT head',
    acquiredAt: new Date(2026, 8, 21, 0, 58),
    ncctKey: '0140',
    priority: 'STAT',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'No acute intracranial abnormality. No haemorrhage, infarct or mass.',
    findings: ['Age-appropriate volume loss. Ventricles and basal cisterns normal.'],
  },
  {
    id: 'ST-9902',
    patientId: 'SD-P-13',
    modality: 'CT',
    description: 'NCCT head',
    acquiredAt: new Date(2026, 8, 20, 18, 5),
    ncctKey: '0138',
    priority: 'STAT',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression:
      'Large established right MCA territory infarct with mass effect and 6 mm leftward midline shift. No haemorrhage.',
    findings: [
      'Hypodensity involving the right frontal, temporal and parietal cortex and the right basal ganglia.',
      'Effacement of the right lateral ventricle and sulci. Basal cisterns preserved.',
    ],
  },
  {
    id: 'ST-9871',
    patientId: 'SD-P-12',
    modality: 'CT',
    description: 'NCCT head',
    acquiredAt: new Date(2026, 8, 18, 22, 44),
    ncctKey: '0137',
    priority: 'STAT',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Acute left thalamic haemorrhage, about 6 mL. No intraventricular extension, no midline shift.',
    findings: ['Periventricular white-matter change consistent with chronic small-vessel disease.'],
  },
  {
    id: 'ST-9812',
    patientId: 'SD-P-16',
    modality: 'CT',
    description: 'NCCT head (thin slices)',
    acquiredAt: new Date(2026, 8, 14, 23, 40),
    ncctKey: 'N-050',
    priority: 'Urgent',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'No acute intracranial injury on the imaged levels.',
    findings: ['Partial thin-slice series (8 images) retained on the record; the full study was reported at the time.'],
  },
  {
    id: 'ST-9755',
    patientId: 'SD-P-15',
    modality: 'CT',
    description: 'NCCT head',
    acquiredAt: new Date(2026, 8, 9, 12, 15),
    ncctKey: 'N-025',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Normal non-contrast CT head. No haemorrhage, mass or hydrocephalus.',
  },
  {
    id: 'ST-9640',
    patientId: 'SD-P-11',
    modality: 'CT',
    description: 'NCCT head',
    acquiredAt: new Date(2026, 7, 31, 19, 40),
    ncctKey: 'N-061',
    priority: 'STAT',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression:
      'Right-sided mixed-density subdural haematoma over the convexity, with mass effect and leftward midline shift.',
    findings: ['Mixed density suggests acute-on-chronic blood. No skull fracture on the imaged levels.'],
  },
  // ── Report-only studies. The report is real; the pixels are not in this demo.
  {
    id: 'ST-4471',
    patientId: 'SD-P-03',
    modality: 'X-ray',
    description: 'Chest X-ray PA',
    acquiredAt: new Date(2026, 8, 19, 10, 15),
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Right lower lobe consolidation. No effusion, no pneumothorax.',
  },
  {
    id: 'ST-9868',
    patientId: 'SD-P-07',
    modality: 'X-ray',
    description: 'Chest X-ray AP (portable)',
    acquiredAt: new Date(2026, 8, 21, 6, 10),
    priority: 'Urgent',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Endotracheal tube and central line in position. Bilateral patchy airspace shadowing, unchanged.',
  },
  {
    id: 'ST-9861',
    patientId: 'SD-P-02',
    modality: 'X-ray',
    description: 'Chest X-ray AP (post-operative)',
    acquiredAt: new Date(2026, 8, 20, 7, 30),
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Sternal wires intact. Small left basal atelectasis. No pneumothorax, drains in position.',
  },
  {
    id: 'ST-9790',
    patientId: 'SD-P-04',
    modality: 'Ultrasound',
    description: 'Obstetric ultrasound — growth scan',
    acquiredAt: new Date(2026, 8, 19, 11, 0),
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Single live intrauterine fetus, 32 weeks by biometry. Liquor adequate. Form F completed.',
  },
]

const studiesById = new Map(IMAGING_STUDIES.map((s) => [s.id, s]))

export function maybeImagingStudy(id: string | undefined): ImagingStudy | undefined {
  return id ? studiesById.get(id) : undefined
}

/** Newest first. */
export function imagingFor(patientId: string): ImagingStudy[] {
  return IMAGING_STUDIES.filter((s) => s.patientId === patientId).sort(
    (a, b) => b.acquiredAt.getTime() - a.acquiredAt.getTime(),
  )
}

/** The patient's most recent study with real pixels behind it. */
export function viewableStudyFor(patientId: string): ImagingStudy | undefined {
  return imagingFor(patientId).find((s) => s.ncctKey !== undefined)
}

export function ncctFor(study: ImagingStudy): NcctStudy | undefined {
  return study.ncctKey ? NCCT_STUDIES[study.ncctKey] : undefined
}

/**
 * The worklist's AI chip, from the series' own labels. Report-only studies
 * carry none: nothing was run on pixels that are not here.
 */
export function aiFlagFor(study: ImagingStudy): { label: string; tone: 'critical' | 'caution' | 'normal' } | undefined {
  const n = ncctFor(study)
  if (!n) return undefined
  const t = n.truth
  if (t.ich && t.sdh && !t.iph) return { label: 'Subdural blood', tone: 'critical' }
  if (t.ich) return { label: 'Bleed detected', tone: 'critical' }
  if (t.massEffect || t.midlineShift) return { label: 'Mass effect', tone: 'caution' }
  if (maybeStrokeCase(n.strokeCaseId)?.imaging.lvo) return { label: 'LVO suspected', tone: 'critical' }
  return { label: 'No acute finding', tone: 'normal' }
}
