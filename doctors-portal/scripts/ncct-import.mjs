/**
 * Turns real head-CT studies into windowed PNG slices the viewer can show.
 *
 * Run once; the output is committed. The app gains no runtime dependency — the
 * viewer is an <img> over generated PNGs, not a DICOM reader — but the pixels
 * are real, and the window is the clinical one rather than whatever the file
 * happened to carry.
 *
 * Sources (CQ500, de-identified):
 *   /home/shriai/STROKE-AI/server/test_data/<folder>/*.dcm, with
 *     ground_truth_labels.csv beside it
 *   the loose *.dcm files in the repository root — two partial series, told
 *     apart by their DICOM PatientID; their labels are the CQ500 reads.csv
 *     majority vote, written into CASES below because no CSV sits beside them
 *
 * A study is matched to a sample-kit patient by its ground truth — a case
 * whose story is "ICH negative" gets a study whose label says ICH is negative,
 * so nothing on screen contradicts the pixels behind it.
 *
 * Usage:  node scripts/ncct-import.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = '/home/shriai/STROKE-AI/server/test_data'
/** The repository root, where the two loose partial series sit. */
const LOOSE = new URL('../..', import.meta.url).pathname
const OUT_IMAGES = 'public/ncct'
const OUT_MANIFEST = 'src/data/ncct.generated.ts'

/** How many slices to keep per study, and which part of the stack. */
const SLICES = 28
/** Brain window — W 80 / L 40. The clinical default for a head CT. */
const WINDOW = { width: 80, level: 40 }

/**
 * Which study stands behind which sample-kit patient.
 *
 * `0141` is a hyperacute left-M1 occlusion thrombolysed at 02:52 — its NCCT
 * MUST be haemorrhage-negative, and early ischaemic change at ASPECTS 8 is
 * subtle to absent, which is exactly what an all-negative study looks like.
 * `0140` is the de-activated mimic (seizure with post-ictal deficit), so its
 * scan is normal. `0137`, `0138` and `0142` are the haemorrhage and
 * mass-effect code strokes, each given to a patient whose story the labels fit.
 *
 * `N-` keys are head CTs outside the stroke pathway — no stroke case, just a
 * study on a patient's record. N-061 is a subdural after a fall: blood on the
 * scan, but a trauma presentation rather than a code stroke.
 */
const CASES = [
  { key: '0141', folder: 'Ranjith', patientId: 'SD-P-05', strokeCase: true },
  { key: '0140', folder: 'Rani', patientId: 'SD-P-03', strokeCase: true },
  { key: '0137', folder: 'Kumar', patientId: 'SD-P-12', strokeCase: true },
  { key: '0138', folder: 'Priya', patientId: 'SD-P-13', strokeCase: true },
  { key: '0142', folder: 'Santhosh', patientId: 'SD-P-14', strokeCase: true },
  { key: 'N-061', folder: 'Selvi', patientId: 'SD-P-11', strokeCase: false },
  { key: 'N-025', source: LOOSE, filterPatientId: 'CQ500-CT-25', patientId: 'SD-P-15', strokeCase: false, truth: 'negative' },
  { key: 'N-050', source: LOOSE, filterPatientId: 'CQ500-CT-50', patientId: 'SD-P-16', strokeCase: false, truth: 'negative' },
]

const NEGATIVE = {
  ich: false,
  iph: false,
  ivh: false,
  sdh: false,
  edh: false,
  sah: false,
  massEffect: false,
  midlineShift: false,
}

const PY = `
import sys, json, glob, os
import pydicom, numpy as np
from PIL import Image

src, out_dir, want, win_w, win_l = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
only_patient = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] else None

files = sorted(glob.glob(os.path.join(src, '*.dcm')))
if not files:
    print(json.dumps({'error': 'no dicom in ' + src})); sys.exit(0)

# Group by series; keep the thickest-slice axial plain series with the most
# images. A CQ500 folder mixes 5 mm plain with sub-millimetre thin recons.
series = {}
for f in files:
    try:
        d = pydicom.dcmread(f, stop_before_pixels=True)
    except Exception:
        continue
    if only_patient and str(getattr(d, 'PatientID', '')) != only_patient:
        continue
    uid = getattr(d, 'SeriesInstanceUID', 'none')
    series.setdefault(uid, []).append((f, d))

if not series:
    print(json.dumps({'error': 'no matching series in ' + src})); sys.exit(0)

def rank(item):
    uid, rows = item
    thick = float(getattr(rows[0][1], 'SliceThickness', 0) or 0)
    return (1 if thick >= 4 else 0, len(rows))

uid, rows = max(series.items(), key=rank)

def order_key(pair):
    _, d = pair
    ipp = getattr(d, 'ImagePositionPatient', None)
    if ipp is not None and len(ipp) == 3:
        return float(ipp[2])
    return float(getattr(d, 'InstanceNumber', 0) or 0)

rows.sort(key=order_key)

# The middle 70% of the stack — the vertex and the skull base carry no brain.
# A partial series shorter than the slice budget is kept whole.
n = len(rows)
if n <= want:
    chosen = list(rows)
else:
    lo, hi = int(n * 0.15), int(n * 0.85)
    band = rows[lo:hi] or rows
    step = max(1, len(band) // want)
    chosen = band[::step][:want]
chosen.reverse()  # superior slice first, the way a radiologist scrolls

os.makedirs(out_dir, exist_ok=True)
lo_hu, hi_hu = win_l - win_w / 2.0, win_l + win_w / 2.0
meta = None
written = 0

for i, (f, _) in enumerate(chosen, start=1):
    d = pydicom.dcmread(f)
    arr = d.pixel_array.astype(np.float32)
    arr = arr * float(getattr(d, 'RescaleSlope', 1) or 1) + float(getattr(d, 'RescaleIntercept', 0) or 0)
    arr = np.clip((arr - lo_hu) / (hi_hu - lo_hu), 0.0, 1.0)
    if str(getattr(d, 'PhotometricInterpretation', '')) == 'MONOCHROME1':
        arr = 1.0 - arr
    img = Image.fromarray((arr * 255).astype(np.uint8), mode='L')
    if img.size != (512, 512):
        img = img.resize((512, 512), Image.LANCZOS)
    img.save(os.path.join(out_dir, 'slice-%02d.png' % i), optimize=True)
    written += 1
    if meta is None:
        meta = {
            'rows': int(getattr(d, 'Rows', 512)),
            'columns': int(getattr(d, 'Columns', 512)),
            'sliceThickness': float(getattr(d, 'SliceThickness', 0) or 0),
            'kvp': float(getattr(d, 'KVP', 0) or 0),
            'seriesDescription': str(getattr(d, 'SeriesDescription', '') or ''),
            'sourcePatientId': str(getattr(d, 'PatientID', '') or ''),
            'manufacturer': str(getattr(d, 'Manufacturer', '') or ''),
        }

meta['slices'] = written
meta['seriesTotal'] = n
print(json.dumps(meta))
`

function importStudy({ key, folder, source, filterPatientId }) {
  const dir = join(OUT_IMAGES, key)
  const from = source ?? join(SOURCE, folder)
  const label = folder ?? filterPatientId
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const r = spawnSync(
    'python3',
    ['-c', PY, from, dir, String(SLICES), String(WINDOW.width), String(WINDOW.level), filterPatientId ?? ''],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0) {
    console.error(`FAILED  ${label}\n${r.stderr}`)
    return null
  }
  const meta = JSON.parse(r.stdout.trim().split('\n').pop())
  if (meta.error) {
    console.error(`FAILED  ${label}: ${meta.error}`)
    return null
  }
  console.log(
    `OK  ${key.padEnd(5)} ← ${label.padEnd(11)} ${String(meta.slices).padStart(3)} slices of ${meta.seriesTotal} · ${meta.seriesDescription} · ${meta.sliceThickness} mm · ${meta.kvp} kV`,
  )
  return meta
}

/** The ground truth that drives every AI finding shown for a study. */
function groundTruth() {
  const csv = spawnSync('cat', [join(SOURCE, 'ground_truth_labels.csv')], { encoding: 'utf8' }).stdout
  const [head, ...lines] = csv.trim().split('\n')
  const cols = head.split(',')
  const out = {}
  for (const line of lines) {
    const cells = line.split(',')
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]]))
    out[row.folder] = {
      ich: row.ICH === '1',
      iph: row.IPH === '1',
      ivh: row.IVH === '1',
      sdh: row.SDH === '1',
      edh: row.EDH === '1',
      sah: row.SAH === '1',
      massEffect: row.MassEffect === '1',
      midlineShift: row.MidlineShift === '1',
    }
  }
  return out
}

const truth = groundTruth()
const studies = []
for (const c of CASES) {
  const meta = importStudy(c)
  if (!meta) continue
  const labels = c.truth === 'negative' ? NEGATIVE : truth[c.folder]
  if (!labels) {
    console.error(`FAILED  ${c.key}: no ground-truth row for ${c.folder}`)
    continue
  }
  studies.push({ ...c, ...meta, truth: labels })
}

const ts = `/**
 * GENERATED by scripts/ncct-import.mjs — do not edit by hand.
 *
 * Real head-CT pixels (CQ500, de-identified) windowed to W ${WINDOW.width} / L ${WINDOW.level} and written as
 * PNG slices under /public/ncct. The patient named on screen is always the §8
 * sample-kit patient the case belongs to; the source study id below is
 * provenance, never an identity.
 *
 * \`truth\` is the study's own ground-truth label row. Every AI finding the
 * console and the report show is derived from it, so nothing on screen
 * contradicts the pixels behind it.
 */

export interface NcctTruth {
  ich: boolean
  iph: boolean
  ivh: boolean
  sdh: boolean
  edh: boolean
  sah: boolean
  massEffect: boolean
  midlineShift: boolean
}

export interface NcctStudy {
  /** The folder under /ncct. Equals the stroke case id where there is one. */
  key: string
  /** The stroke case this study stands behind — absent for a CT outside the pathway. */
  strokeCaseId?: string
  patientId: string
  /** Slice files are <base>ncct/<key>/slice-01.png … slice-NN.png */
  slices: number
  rows: number
  columns: number
  sliceThickness: number
  kvp: number
  seriesDescription: string
  /** How many images the source series held before subsampling. */
  seriesTotal: number
  /** De-identified source id. Provenance only. */
  sourcePatientId: string
  manufacturer: string
  truth: NcctTruth
}

export const NCCT_WINDOW = { width: ${WINDOW.width}, level: ${WINDOW.level} } as const

export const NCCT_STUDIES: Record<string, NcctStudy> = {
${studies
  .map(
    (s) => `  '${s.key}': {
    key: '${s.key}',${s.strokeCase ? `\n    strokeCaseId: '${s.key}',` : ''}
    patientId: '${s.patientId}',
    slices: ${s.slices},
    rows: ${s.rows},
    columns: ${s.columns},
    sliceThickness: ${s.sliceThickness},
    kvp: ${s.kvp},
    seriesDescription: '${s.seriesDescription.replace(/'/g, "\\'")}',
    seriesTotal: ${s.seriesTotal},
    sourcePatientId: '${s.sourcePatientId}',
    manufacturer: '${s.manufacturer.replace(/'/g, "\\'")}',
    truth: { ich: ${s.truth.ich}, iph: ${s.truth.iph}, ivh: ${s.truth.ivh}, sdh: ${s.truth.sdh}, edh: ${s.truth.edh}, sah: ${s.truth.sah}, massEffect: ${s.truth.massEffect}, midlineShift: ${s.truth.midlineShift} },
  },`,
  )
  .join('\n')}
}

/**
 * The slice path a viewer requests. 1-based, zero-padded to two digits. Built
 * on Vite's base URL so the app works when it is served from a sub-path.
 */
export function slicePath(key: string, index: number): string {
  return \`\${import.meta.env.BASE_URL}ncct/\${key}/slice-\${String(index).padStart(2, '0')}.png\`
}
`

writeFileSync(OUT_MANIFEST, ts)
console.log(`\nmanifest → ${OUT_MANIFEST} (${studies.length} studies)`)
