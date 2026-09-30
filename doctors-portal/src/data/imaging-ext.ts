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
    acquiredAt: new Date(2026, 7, 24, 11, 30),
    imageKey: 'us-0402',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Single live intrauterine fetus, 28 weeks by biometry. Liquor adequate. Form F completed.',
    findings: ['Head circumference 263 mm — two sweeps, 262 and 264 mm — in keeping with 28 weeks. Both transthalamic planes retained.'],
  },
  {
    id: 'ST-9535',
    patientId: 'SD-P-06',
    modality: 'X-ray',
    description: 'Chest X-ray AP',
    acquiredAt: new Date(2026, 8, 19, 12, 30),
    imageKey: 'xr-0601',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Clear lungs on both films. No consolidation or effusion.',
    findings: ['Two AP films, the second repeated for rotation. Heart size and mediastinum normal for age. Taken with the fever work-up to exclude pneumonia.'],
  },
  {
    id: 'ST-9862',
    patientId: 'SD-P-07',
    modality: 'Ultrasound',
    description: 'Ultrasound KUB (bedside)',
    acquiredAt: new Date(2026, 8, 15, 7, 30),
    imageKey: 'us-0701',
    priority: 'STAT',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'No hydronephrosis and no calculus — no obstruction to drain.',
    findings: ['Right kidney 13.4 cm with normal cortex and a normal collecting system on the retained image. Bladder catheterised.'],
  },
  {
    id: 'ST-9541',
    patientId: 'SD-P-09',
    modality: 'Ultrasound',
    description: 'Ultrasound KUB',
    acquiredAt: new Date(2026, 8, 5, 11, 0),
    imageKey: 'us-0901',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Neha Bhatt',
    impression: 'Echogenic kidneys with thinned parenchyma, in keeping with chronic kidney disease. No hydronephrosis.',
    findings: ['Left kidney 9.9 cm, parenchyma 1.5 cm, on the retained image.'],
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
