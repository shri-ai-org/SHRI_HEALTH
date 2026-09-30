/**
 * Turns real, openly licensed, de-identified imaging into the frames the study
 * viewer shows — X-ray, ultrasound, MRI, echo and CT beyond the eight head CTs
 * (those stay with scripts/ncct-import.mjs and public/ncct/).
 *
 * Run once; the output is committed. The app gains no runtime dependency: the
 * viewer is an <img> over PNG frames, loaded at runtime, never bundled.
 *
 * Every study is listed in scripts/imaging-sources.mjs with where its pixels
 * come from and under which licence. The rule is the CT one: a study is only
 * given an image whose content fits its report (the source's own label, or
 * what the image plainly shows), and the report is written to the image —
 * never a normal image passed off as a finding.
 *
 * Sources it can read:
 *   tcia   — a TCIA series by SeriesInstanceUID (NBIA API), DICOM
 *   file   — an image file by URL (Wikimedia Commons, Zenodo), JPEG/PNG/TIFF
 *   video  — a video by URL (Commons .ogv/.webm), cut into loop frames
 *   zip    — named members of a zip by URL
 *   local  — a file already in imaging-src/ (members pulled from a remote zip
 *            by range requests, e.g. the HC18 fetal-head set)
 * Downloads are cached in imaging-src/ (gitignored); frames go to
 * public/imaging/<key>/frame-NN.png; the manifest to
 * src/data/imaging.generated.ts.
 *
 * Usage:  node scripts/imaging-import.mjs            (all)
 *         node scripts/imaging-import.mjs X-0301 …   (just these keys)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SOURCES } from './imaging-sources.mjs'

const CACHE = 'imaging-src'
const OUT_IMAGES = 'public/imaging'
const OUT_MANIFEST = 'src/data/imaging.generated.ts'
const NBIA = 'https://services.cancerimagingarchive.net/nbia-api/services/v1'
const UA = 'ShriHealth-demo-importer/1.0 (https://github.com/Vimal-ShriAI/SHRI_HEALTH)'
/** Longest side of an exported frame. */
const MAX_PX = 512

const PY = String.raw`
import sys, json, glob, os, zipfile, subprocess
import numpy as np
from PIL import Image

kind, src, out_dir, want, window = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
MAX = int(sys.argv[6])
REDACT = json.loads(sys.argv[7])
CLIP = json.loads(sys.argv[8])
os.makedirs(out_dir, exist_ok=True)

def fit(img):
    img.thumbnail((MAX, MAX), Image.LANCZOS)
    return img

def norm(a, lo, hi):
    return (np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)

def dicom_frames(path):
    import pydicom
    files = sorted(glob.glob(os.path.join(path, '**', '*.dcm'), recursive=True))
    dss = []
    for f in files:
        try: dss.append(pydicom.dcmread(f))
        except Exception: pass
    if not dss: return [], {}
    def zkey(d):
        ipp = getattr(d, 'ImagePositionPatient', None)
        return float(ipp[2]) if ipp is not None and len(ipp) == 3 else float(getattr(d, 'InstanceNumber', 0) or 0)
    dss.sort(key=zkey)
    n = len(dss)
    if n > want:
        lo, hi = int(n * 0.1), int(n * 0.9)
        band = dss[lo:hi] or dss
        step = max(1, len(band) // want)
        dss = band[::step][:want]
    if n > 1: dss.reverse()  # superior first, the way a stack is read
    out = []
    for d in dss:
        a = d.pixel_array.astype(np.float32)
        mod = str(getattr(d, 'Modality', ''))
        if mod == 'CT' and window.startswith('W'):
            a = a * float(getattr(d, 'RescaleSlope', 1) or 1) + float(getattr(d, 'RescaleIntercept', 0) or 0)
            w, l = [float(x) for x in window[1:].split('L')]
            g = norm(a, l - w / 2, l + w / 2)
        else:
            try:
                from pydicom.pixels import apply_voi_lut
                a = apply_voi_lut(d.pixel_array, d).astype(np.float32)
            except Exception:
                pass
            g = norm(a, np.percentile(a, 0.5), np.percentile(a, 99.5))
        if str(getattr(d, 'PhotometricInterpretation', '')) == 'MONOCHROME1': g = 255 - g
        # Shown the way a reading workstation shows an axial: patient's right on the left, anterior up.
        iop = getattr(d, 'ImageOrientationPatient', None)
        if iop is not None and len(iop) == 6:
            if float(iop[0]) < 0: g = g[:, ::-1]
            if float(iop[4]) < 0: g = g[::-1, :]
        out.append(Image.fromarray(np.ascontiguousarray(g)).convert('L'))
    d0 = dss[0]
    meta = {'rows': int(getattr(d0, 'Rows', 0)), 'columns': int(getattr(d0, 'Columns', 0)), 'seriesTotal': n,
            'seriesDescription': str(getattr(d0, 'SeriesDescription', '') or ''), 'modality': str(getattr(d0, 'Modality', '') or '')}
    return out, meta

def image_frames(path):
    img = Image.open(path)
    frames = []
    try:
        while True:
            frames.append(img.copy()); img.seek(img.tell() + 1)
    except EOFError:
        pass
    first = frames[0]
    meta = {'rows': first.height, 'columns': first.width, 'seriesTotal': len(frames), 'seriesDescription': '', 'modality': ''}
    if want > 1 and len(frames) > want:
        lo, hi = int(len(frames) * 0.1), int(len(frames) * 0.9)
        band = frames[lo:hi] or frames
        frames = band[::max(1, len(band) // want)][:want]
    out = []
    for f in frames[:want]:
        f = f.convert('RGB')
        a = np.asarray(f).astype(np.int16)
        grey = np.abs(a[..., 0] - a[..., 1]).mean() < 4 and np.abs(a[..., 1] - a[..., 2]).mean() < 4
        out.append(f.convert('L') if grey else f)
    return out, meta

def video_frames(path):
    tmp = out_dir + '.tmp'
    os.makedirs(tmp, exist_ok=True)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,width,height', '-of', 'json', path], capture_output=True, text=True)
    info = json.loads(probe.stdout or '{}').get('streams', [{}])[0]
    total = int(info.get('nb_read_packets', want) or want)
    # A clip is consecutive frames from one point — real motion, a heartbeat or two; without
    # one, frames are spread over the whole video.
    every = int(CLIP.get('every', 1)) if CLIP else max(1, total // want)
    seek = ['-ss', str(CLIP['start'])] if CLIP else []
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *seek, '-i', path, '-vf', 'select=not(mod(n\\,%d))' % every, '-vsync', 'vfr', '-frames:v', str(want), os.path.join(tmp, 'f-%03d.png')], check=True)
    out = []
    for f in sorted(glob.glob(os.path.join(tmp, 'f-*.png'))):
        im = Image.open(f).convert('RGB'); a = np.asarray(im).astype(np.int16)
        grey = np.abs(a[..., 0] - a[..., 1]).mean() < 4 and np.abs(a[..., 1] - a[..., 2]).mean() < 4
        out.append(im.convert('L') if grey else im)
    for f in glob.glob(os.path.join(tmp, '*')): os.remove(f)
    os.rmdir(tmp)
    meta = {'rows': int(info.get('height', 0)), 'columns': int(info.get('width', 0)), 'seriesTotal': total, 'seriesDescription': '', 'modality': ''}
    return out, meta

if kind == 'dicom': frames, meta = dicom_frames(src)
elif kind == 'video': frames, meta = video_frames(src)
else: frames, meta = image_frames(src)

if not frames:
    print(json.dumps({'error': 'no frames from ' + src})); sys.exit(0)
from PIL import ImageDraw
for i, f in enumerate(frames, start=1):
    f = fit(f)
    # Burned-in text that names the source's patient is blacked out, in output pixels.
    for box in REDACT: ImageDraw.Draw(f).rectangle(box, fill=0)
    f.save(os.path.join(out_dir, 'frame-%02d.png' % i), optimize=True)
meta['frames'] = len(frames)
print(json.dumps(meta))
`

function fetchTo(url, file) {
  if (existsSync(file)) return
  mkdirSync(join(file, '..'), { recursive: true })
  const r = spawnSync('curl', ['-sSL', '--fail', '-m', '1800', '-A', UA, '-o', file, url], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`download failed: ${url}`)
}

/** Download (or reuse) a source, and say what the converter should read. */
function materialise(s) {
  const dir = join(CACHE, s.key)
  mkdirSync(dir, { recursive: true })
  const src = s.source
  if (src.type === 'local') return { kind: src.file.endsWith('.dcm') ? 'dicom' : 'image', path: join(CACHE, src.file) }
  if (src.type === 'tcia') {
    const zip = join(dir, 'series.zip')
    // A series already fetched (a chest film picked by eye, or a CT sampled slice by slice by
    // imaging-src/tcia_slices.py — the series zip is much slower) is read where it lies.
    const unpacked = src.cached ? join(CACHE, src.cached) : join(dir, 'dicom')
    if (!existsSync(unpacked)) {
      fetchTo(`${NBIA}/getImage?SeriesInstanceUID=${src.seriesUid}`, zip)
      mkdirSync(unpacked, { recursive: true })
      spawnSync('unzip', ['-q', '-o', zip, '-d', unpacked], { stdio: 'inherit' })
    }
    return { kind: 'dicom', path: unpacked }
  }
  if (src.type === 'zip') {
    const zip = join(CACHE, `${src.name}.zip`)
    fetchTo(src.url, zip)
    const out = join(dir, src.member.split('/').pop())
    if (!existsSync(out)) spawnSync('sh', ['-c', `unzip -p '${zip}' '${src.member}' > '${out}'`], { stdio: 'inherit' })
    return { kind: 'image', path: out }
  }
  const ext = src.url.split('?')[0].split('.').pop().toLowerCase()
  const file = join(dir, `source.${ext}`)
  fetchTo(src.url, file)
  return { kind: src.type === 'video' ? 'video' : 'image', path: file }
}

function importOne(s) {
  const out = join(OUT_IMAGES, s.key)
  rmSync(out, { recursive: true, force: true })
  const { kind, path } = materialise(s)
  const want = s.kind === 'stack' ? 28 : s.kind === 'loop' ? 24 : 1
  const r = spawnSync('python3', ['-c', PY, kind, path, out, String(want), s.window ?? 'auto', String(MAX_PX), JSON.stringify(s.redact ?? []), JSON.stringify(s.clip ?? null)], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${s.key}: ${r.stderr}`)
  const meta = JSON.parse(r.stdout.trim().split('\n').pop())
  if (meta.error) throw new Error(`${s.key}: ${meta.error}`)
  console.log(`  ${s.key.padEnd(8)} ${s.modality.padEnd(10)} ${String(meta.frames).padStart(2)} frame(s) · ${s.source.dataset}`)
  return { ...meta, frames: readdirSync(out).filter((f) => f.startsWith('frame-')).length }
}

const only = process.argv.slice(2)
const previous = existsSync(OUT_MANIFEST) ? readFileSync(OUT_MANIFEST, 'utf8') : ''
const entries = []
for (const s of SOURCES) {
  let meta
  if (only.length && !only.includes(s.key)) {
    // Keep what an earlier run wrote for the keys not asked for.
    const m = new RegExp(`'${s.key}': (\\{[^\\n]*\\}),`).exec(previous)
    if (!m) continue
    entries.push([s.key, JSON.parse(m[1])])
    continue
  }
  try {
    meta = importOne(s)
  } catch (e) {
    console.log(`  ${s.key} FAILED — ${e.message}`)
    continue
  }
  entries.push([
    s.key,
    {
      key: s.key,
      kind: s.kind,
      modality: s.modality,
      bodyPart: s.bodyPart,
      view: s.view,
      frames: meta.frames,
      rows: meta.rows,
      columns: meta.columns,
      seriesTotal: meta.seriesTotal,
      window: s.window ?? 'auto',
      source: { dataset: s.source.dataset, licence: s.source.licence, url: s.source.page ?? s.source.url ?? `https://www.cancerimagingarchive.net/collection/${s.source.dataset.toLowerCase().replace(/^tcia /, '')}/`, credit: s.source.credit ?? s.source.dataset },
    },
  ])
}

const body = entries.map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`).join('\n')
writeFileSync(
  OUT_MANIFEST,
  `/**
 * GENERATED by scripts/imaging-import.mjs — do not edit by hand.
 *
 * Real, openly licensed, de-identified images — X-ray, ultrasound, MRI, echo
 * and CT beyond the eight head CTs — exported as PNG frames under
 * /public/imaging. The patient named on screen is always the sample-kit
 * patient the study belongs to (src/data/imaging-ext.ts); the source below is
 * provenance and credit, never an identity.
 */

export interface ImageSeries {
  key: string
  /** stack: slices to scroll · single: one image · loop: frames to play. */
  kind: 'stack' | 'single' | 'loop'
  modality: 'X-ray' | 'Ultrasound' | 'MRI' | 'CT' | 'Echo'
  bodyPart: string
  /** The projection or sequence, as the frame's corner text says it: "PA", "DWI", "Parasternal long axis". */
  view: string
  frames: number
  rows: number
  columns: number
  /** Images the source held before subsampling. */
  seriesTotal: number
  /** How the pixels were windowed at export: "W1500L-600", or "auto" (percentile / the file's own). */
  window: string
  source: { dataset: string; licence: string; url: string; credit: string }
}

export const IMAGE_SERIES: Record<string, ImageSeries> = {
${body}
}

/** A frame's URL — under the deploy base, so a hosted copy finds its images. */
export function framePath(key: string, n: number): string {
  return \`\${import.meta.env.BASE_URL}imaging/\${key}/frame-\${String(n).padStart(2, '0')}.png\`
}
`,
)
// The licence list that travels with the frames — every image, its study, its source and its terms.
const byKey = new Map(SOURCES.map((s) => [s.key, s]))
writeFileSync(
  join(OUT_IMAGES, 'SOURCES.txt'),
  [
    'Images under /imaging — real, de-identified, openly licensed. Each folder is one series.',
    'The patient named on screen is a sample patient of the demo; the source below is provenance only.',
    'The head CTs under /ncct are from CQ500 (qure.ai), CC BY-NC-SA 4.0.',
    'Burned-in text naming a source patient has been blacked out; frames are otherwise as published, resized.',
    '',
    ...entries.map(([k, v]) => `${k}\t${byKey.get(k)?.for ?? ''}\n\t${v.source.credit} · ${v.source.licence}\n\t${v.source.url}\n`),
  ].join('\n'),
)
console.log(`${entries.length} series in ${OUT_MANIFEST}`)
