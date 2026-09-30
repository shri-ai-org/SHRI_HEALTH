/**
 * M-15 · the later imaging studies — backed, where an open dataset has an
 * image that fits, by a real, openly licensed, de-identified image
 * (`imaging.generated.ts`, sources in `scripts/imaging-sources.mjs`), with a
 * report written to what that image shows. Where none fits, the study is
 * report-only and says so; nobody else's scan stands in. Merged into
 * `IMAGING_STUDIES` by `imaging.ts`, so every screen reads one list.
 *
 * The first set is in `imaging.ts`.
 */

import type { ImagingStudy } from './imaging'

export const IMAGING_STUDIES_EXT: ImagingStudy[] = [
  {
    id: 'ST-9531',
    patientId: 'SD-P-01',
    modality: 'Ultrasound',
    description: 'Ultrasound thyroid',
    acquiredAt: new Date(2026, 2, 16, 10, 20),
    imageKey: 'us-0101',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Diffusely hypoechoic, heterogeneous thyroid, in keeping with chronic lymphocytic (Hashimoto) thyroiditis. No discrete nodule.',
    findings: ['Right lobe measured in its long axis on the retained image. No cervical lymphadenopathy.'],
  },
  {
    id: 'ST-9611',
    patientId: 'SD-P-04',
    modality: 'Ultrasound',
    description: 'Obstetric ultrasound — growth scan',
    acquiredAt: new Date(2026, 7, 22, 11, 0),
    imageKey: 'us-0402',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Single live intrauterine fetus, 28 weeks by biometry. Liquor adequate. Form F completed.',
    findings: ['Head circumference 259 mm, in keeping with 28 weeks. Retained image: the transthalamic plane it was measured on.'],
  },
  // Report-only: no open image shows an infarct of this size, so none is shown.
  {
    id: 'ST-9905',
    patientId: 'SD-P-13',
    modality: 'MRI',
    description: 'MRI brain — DWI and FLAIR',
    acquiredAt: new Date(2026, 8, 21, 6, 50),
    priority: 'Urgent',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Restricted diffusion throughout the right MCA territory, matching the CT hypodensity. No haemorrhagic transformation.',
    findings: ['Swelling of the right hemisphere with effacement of the right lateral ventricle, as on CT.', 'Left hemisphere and posterior fossa normal.'],
  },
]
