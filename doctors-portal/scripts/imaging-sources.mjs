/**
 * Where every open-dataset study's pixels come from — read by
 * scripts/imaging-import.mjs. One entry per series the viewer shows.
 *
 * Each image was looked at before it was listed, and the report of the study
 * it backs (src/data/imaging.ts, src/data/imaging-ext.ts) says what the image
 * shows and what its source says it shows — nothing it does not. The key is
 * the frames' folder under public/imaging/; `for` names the study, so the
 * pairing can be checked from either side.
 *
 * Licences: TCIA COVID-19-AR CC BY 4.0 · TCIA Pancreas-CT CC BY 3.0 · HC18
 * (Zenodo 1327317) CC BY 4.0 · Kermany et al. paediatric chest X-ray
 * (Mendeley Data rscbjbr9sj v3) CC BY 4.0 · Wikimedia Commons files as
 * listed per file.
 * CC BY-SA files keep their licence as frames; the credit line under every
 * image names the author and the licence, and public/imaging/SOURCES.txt
 * lists them all.
 */

const COVID_AR = {
  dataset: 'TCIA COVID-19-AR',
  licence: 'CC BY 4.0',
  page: 'https://www.cancerimagingarchive.net/collection/covid-19-ar/',
  credit: 'TCIA COVID-19-AR, de-identified',
}
const PANCREAS_CT = {
  dataset: 'TCIA Pancreas-CT',
  licence: 'CC BY 3.0',
  page: 'https://www.cancerimagingarchive.net/collection/pancreas-ct/',
  credit: 'TCIA Pancreas-CT (NIH Clinical Center), de-identified',
}
const HC18 = {
  dataset: 'HC18',
  licence: 'CC BY 4.0',
  page: 'https://zenodo.org/records/1327317',
  credit: 'HC18 challenge set (van den Heuvel et al.), de-identified',
}

const cxr = (uid) => ({ type: 'tcia', seriesUid: `1.3.6.1.4.1.14519.5.2.1.9999.103.${uid}`, cached: `cxr/1.3.6.1.4.1.14519.5.2.1.9999.103.${uid}`, ...COVID_AR })
/** One series of a COVID-19-AR study fetched whole by imaging-src/fetch_multi.py, read where it lies. */
const cxrPart = (study, series) => ({ type: 'tcia', seriesUid: series, cached: `cxr-multi/${study}/${series}`, ...COVID_AR })
const commons = (file, licence, author, extra = {}) => ({
  type: extra.video ? 'video' : 'file',
  url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`,
  dataset: 'Wikimedia Commons',
  licence,
  page: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replaceAll(' ', '_'))}`,
  credit: `${author}, Wikimedia Commons`,
})
/** An HC18 image with its own calibration — the pixel size the dataset's table gives for it. */
const hc18 = (file, spacing) => ({ type: 'local', file: `hc18/${file}`, spacing, ...HC18 })
const KERMANY = {
  dataset: 'Kermany et al., paediatric chest X-ray',
  licence: 'CC BY 4.0',
  page: 'https://data.mendeley.com/datasets/rscbjbr9sj/3',
  credit: 'Kermany, Zhang, Goldbaum (Mendeley Data), de-identified',
}

export const SOURCES = [
  // ── The 15 on the record ──────────────────────────────────────────────
  {
    key: 'xr-0301',
    for: 'ST-4471 · SD-P-03 chest X-ray',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP',
    source: cxr('8666657322287157644178682100155'),
  },
  {
    key: 'xr-0201',
    for: 'ST-9861 · SD-P-02 chest X-ray after CABG',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP (upright)',
    source: cxr('2411790671231591035032612922848'),
  },
  {
    key: 'xr-0701',
    for: 'ST-9868 · SD-P-07 chest X-ray in ICU',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP (portable, semi-upright)',
    source: cxr('8410024380799536861169439627079'),
  },
  {
    key: 'us-0101',
    for: 'ST-9531 · SD-P-01 thyroid ultrasound',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Thyroid',
    view: 'Right lobe, longitudinal',
    source: commons('Hashimoto-Thyreoiditis.JPG', 'CC BY-SA 3.0', 'Drahreg01'),
  },
  {
    key: 'xr-0601',
    for: 'ST-9535 · SD-P-06 chest X-ray — two AP films',
    kind: 'stack',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP (paediatric)',
    source: KERMANY,
    parts: [
      { label: 'AP · film 1', source: { type: 'local', file: 'kermany/NORMAL-1064313-0001.jpeg', ...KERMANY } },
      { label: 'AP · film 2', source: { type: 'local', file: 'kermany/NORMAL-1064313-0002.jpeg', ...KERMANY } },
    ],
  },
  {
    key: 'us-0701',
    for: 'ST-9862 · SD-P-07 ultrasound KUB',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Right kidney',
    view: 'Sagittal',
    source: commons('Normal adult kidney.jpg', 'CC BY 4.0', 'K. L. Hansen, M. B. Nielsen, C. Ewertsen'),
  },
  {
    key: 'us-0901',
    for: 'ST-9541 · SD-P-09 ultrasound KUB',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Left kidney',
    view: 'Sagittal',
    source: commons('Ultrasound of left kidney renal parenchymal disease.jpg', 'CC BY-SA 4.0', 'Cerevisae'),
  },
  {
    key: 'us-0401',
    for: 'ST-9790 · SD-P-04 growth scan, 32 weeks — two sweeps of the same head',
    kind: 'stack',
    modality: 'Ultrasound',
    bodyPart: 'Fetal head',
    view: 'Transthalamic plane',
    source: HC18,
    parts: [
      { label: 'Sweep 1 · HC 290.8 mm', source: hc18('736_HC.png', 0.198546075821) },
      { label: 'Sweep 2 · HC 298.6 mm', source: hc18('736_2HC.png', 0.198599994183) },
    ],
  },
  {
    key: 'us-0402',
    for: 'ST-9611 · SD-P-04 growth scan, 28 weeks — two sweeps of the same head',
    kind: 'stack',
    modality: 'Ultrasound',
    bodyPart: 'Fetal head',
    view: 'Transthalamic plane',
    source: HC18,
    parts: [
      { label: 'Sweep 1 · HC 262.3 mm', source: hc18('690_HC.png', 0.177614071539) },
      { label: 'Sweep 2 · HC 263.5 mm', source: hc18('690_2HC.png', 0.177533690419) },
    ],
  },

  // ── New OPD patients (src/data/cohort-ext.ts) ─────────────────────────
  {
    key: 'ec-1701',
    for: 'ST-9570 · SD-P-17 exercise stress echo',
    kind: 'loop',
    modality: 'Echo',
    bodyPart: 'Heart',
    view: 'Apical two-chamber · rest, peak, recovery',
    // Rest, peak and recovery apical two-chamber side by side, every other frame from 1 s in.
    clip: { start: 1, every: 2 },
    // The source's burned-in patient name and study date, top-left of each of the four panes.
    redact: [
      [22, 44, 138, 91],
      [258, 44, 372, 80],
      [22, 207, 138, 243],
      [258, 207, 372, 243],
    ],
    source: commons('Exercise echocardiography in diabetic patients - 1476-7120-7-24-S4.wmv.ogv', 'CC BY 2.0', 'Oliveira J et al., Cardiovasc Ultrasound 2009;7:24', { video: true }),
  },
  {
    key: 'xr-1801',
    for: 'ST-9622 · SD-P-18 chest X-ray — PA and AP',
    kind: 'stack',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'PA and AP',
    source: COVID_AR,
    parts: [
      { label: 'PA', source: cxrPart('619618535226', '152198164874') },
      // The source files this series as "Lateral L", but the image is a second frontal film — labelled for what it shows.
      { label: 'AP', source: cxrPart('619618535226', '779128607806') },
    ],
  },
  {
    key: 'mr-2001',
    for: 'ST-9744 · SD-P-20 MRI brain',
    kind: 'stack',
    modality: 'MRI',
    bodyPart: 'Brain',
    view: 'T1 axial',
    source: commons('Brain MRI T1 movie.gif', 'CC BY-SA 3.0', 'Dr. Laurent Hermoye (Imagilys)'),
  },
  {
    key: 'us-2101',
    for: 'ST-9682 · SD-P-21 ultrasound abdomen',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Liver',
    view: 'Right upper quadrant, liver and right kidney',
    source: commons('Steatosis hepatis - Sonographie 001.jpg', 'CC BY-SA 3.0', 'Hellerhoff'),
  },
  {
    key: 'xr-2201',
    for: 'ST-9701 · SD-P-22 knee X-ray',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Left knee',
    view: 'AP, standing',
    source: commons('Osteoarthritis on X-ray.jpg', 'CC BY-SA 4.0', 'James Heilman, MD'),
  },
  {
    key: 'us-2401',
    for: 'ST-9716 · SD-P-24 anomaly scan — two sweeps of the same head',
    kind: 'stack',
    modality: 'Ultrasound',
    bodyPart: 'Fetal head',
    view: 'Transthalamic plane',
    source: HC18,
    parts: [
      { label: 'Sweep 1 · HC 219.1 mm', source: hc18('652_HC.png', 0.1635005974) },
      { label: 'Sweep 2 · HC 222.3 mm', source: hc18('652_2HC.png', 0.162851579728) },
    ],
  },
  {
    key: 'us-2501',
    for: 'ST-9690 · SD-P-25 ultrasound KUB',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Right kidney',
    view: 'Sagittal',
    source: commons('Ultrasonography of hydronephrosis due to ureteropelvic junction obstruction.jpg', 'CC BY 4.0', 'K. L. Hansen, M. B. Nielsen, C. Ewertsen'),
  },
  {
    key: 'xr-2601',
    for: 'ST-9588 · SD-P-26 mammogram',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Left breast',
    view: 'CC, with magnified detail',
    source: commons('Oelzysten in der Mammographie 68W - MG cc - 001.jpg', 'CC BY-SA 4.0', 'Hellerhoff'),
  },
  {
    key: 'us-2701',
    for: 'ST-9602 · SD-P-27 ultrasound abdomen',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Gallbladder',
    view: 'Longitudinal',
    source: commons('Ultrasound image of gallbladder stone Gallstone 091937515.jpg', 'CC BY-SA 3.0', 'Nevit Dilmen'),
  },

  // ── The emergency department (src/data/ed.ts) ─────────────────────────
  {
    key: 'xr-2801',
    for: 'ST-9950 · SD-P-28 chest X-ray — AP and lateral',
    kind: 'stack',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP (semi-upright) and lateral',
    source: COVID_AR,
    parts: [
      { label: 'AP · semi-upright', source: cxrPart('868468670465', '050453805249') },
      { label: 'Lateral', source: cxrPart('868468670465', '540676582892') },
    ],
  },
  {
    key: 'xr-2901',
    for: 'ST-9946 · SD-P-29 chest X-ray',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP (trauma bay)',
    source: cxr('1203233194681916889356188068601'),
  },
  {
    key: 'ct-2901',
    for: 'ST-9947 · SD-P-29 CT abdomen',
    kind: 'stack',
    modality: 'CT',
    bodyPart: 'Abdomen',
    view: 'Axial, portal venous',
    window: 'W400L40',
    source: { type: 'tcia', seriesUid: '1.2.826.0.1.3680043.2.1125.1.41202274843063370955090296887703130', cached: 'ct-abd-01/dicom', ...PANCREAS_CT },
  },
  {
    key: 'mr-3001',
    for: 'ST-9958 · SD-P-30 MRI brain',
    kind: 'single',
    modality: 'MRI',
    bodyPart: 'Brain',
    view: 'DWI and ADC, axial',
    source: commons('DWE MRI of cerebral infarction.png', 'CC BY 4.0', 'Shazia Mirza and Sankalp Gokhale'),
  },
  {
    key: 'xr-3101',
    for: 'ST-9939 · SD-P-31 chest X-ray',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'PA',
    source: commons('Chest radiograph of a lung with Kerley B lines.jpg', 'CC0', 'Mikael Häggström'),
  },
  {
    key: 'us-3201',
    for: 'ST-9941 · SD-P-32 ultrasound abdomen',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Right iliac fossa',
    view: 'Appendix, long and short axis',
    source: commons('Phlegmonoese Appendizitis 40W - US - 001.jpg', 'CC BY-SA 4.0', 'Hellerhoff'),
  },
  {
    key: 'xr-3301',
    for: 'ST-9936 · SD-P-33 chest X-ray',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP (portable)',
    source: cxr('2731527281365846810937843177707'),
  },
  {
    key: 'xr-3401',
    for: 'ST-9943 · SD-P-34 pelvis and hip X-ray — AP and axial',
    kind: 'stack',
    modality: 'X-ray',
    bodyPart: 'Pelvis and left hip',
    view: 'AP and axial',
    source: commons('Mediale Schenkelhalsfraktur links 83W - CR ap - 001.jpg', 'CC BY-SA 4.0', 'Hellerhoff'),
    parts: [
      { label: 'Pelvis AP', source: commons('Mediale Schenkelhalsfraktur links 83W - CR ap - 001.jpg', 'CC BY-SA 4.0', 'Hellerhoff') },
      { label: 'Left hip axial', source: commons('Mediale Schenkelhalsfraktur links 83W - CR Huefte axial - 001.jpg', 'CC BY-SA 4.0', 'Hellerhoff') },
    ],
  },
  {
    key: 'xr-3402',
    for: 'ST-9944 · SD-P-34 chest X-ray before surgery — PA and lateral',
    kind: 'stack',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'PA and lateral',
    source: COVID_AR,
    parts: [
      { label: 'PA', source: cxrPart('817173839042', '375077795803') },
      { label: 'Lateral', source: cxrPart('817173839042', '524183740029') },
    ],
  },
  {
    key: 'xr-3501',
    for: 'ST-9937 · SD-P-35 chest X-ray',
    kind: 'single',
    modality: 'X-ray',
    bodyPart: 'Chest',
    view: 'AP',
    source: cxr('2615055471793367396726766135790'),
  },
  {
    key: 'us-3501',
    for: 'ST-9938 · SD-P-35 ultrasound KUB',
    kind: 'single',
    modality: 'Ultrasound',
    bodyPart: 'Right kidney',
    view: 'Sagittal',
    source: commons('Ultrasound of right kidney moderate hydronephrosis.jpg', 'CC BY-SA 4.0', 'Cerevisae'),
  },
]
