/**
 * What the study viewer (`ui/NcctViewer.tsx` → `StudyViewer`) is handed for a
 * series, whatever its modality — the frames, where each one is, how it is
 * read out, the corner text and where the pixels came from — and the views
 * of the series this build has: the eight head CTs (`ncct.generated.ts`) and
 * the open-dataset studies (`imaging.generated.ts`).
 */

import { imageFor, ncctFor, type ImagingStudy } from '@/data/imaging'
import { framePath, type ImageSeries } from '@/data/imaging.generated'
import { NCCT_WINDOW, slicePath, type NcctStudy } from '@/data/ncct.generated'

/** What the viewer needs to know about a series, whatever its modality. */
export interface SeriesView {
  /** Changes when a different series is handed in — the viewer starts afresh. */
  key: string
  kind: 'stack' | 'single' | 'loop'
  frames: number
  /** The URL of frame `n` (1-based). */
  path: (n: number) => string
  /** The frame's accessible name for frame `n`: "Non-contrast CT head, slice 7 of 28". */
  label: (n: number) => string
  /** The image's alt text for frame `n`. */
  alt: (n: number) => string
  /** Corner text, the way a reading workstation lays it out. */
  topLeft: string[]
  topRight: string[]
  /** Where the pixels came from, under the image: "Image: TCIA COVID-19-AR · CC BY 4.0". */
  credit?: string
  /** What frame `n` is, where a study holds distinct images: "PA", "Lateral", "Sweep 2 · HC 298.6 mm". */
  frameNote?: (n: number) => string | undefined
  /** mm per displayed-image pixel [row, column]; absent means the image is uncalibrated. */
  pixelSpacing?: [number, number]
  /** What one step is called: "slice", "frame", "image". */
  frameWord?: 'slice' | 'frame' | 'image'
}

/** A head CT's view: the corner text, labels and slice files the NCCT viewer always drew. */
export function ncctView(study: NcctStudy): SeriesView {
  return {
    key: study.key,
    kind: 'stack',
    frames: study.slices,
    path: (n) => slicePath(study.key, n),
    label: (n) => `Non-contrast CT head, slice ${n} of ${study.slices}`,
    alt: (n) => `Axial non-contrast CT, slice ${n} of ${study.slices}`,
    topLeft: ['NCCT head · axial', study.seriesDescription],
    topRight: [`${study.sliceThickness} mm · ${study.kvp} kV`, `W ${NCCT_WINDOW.width} : L ${NCCT_WINDOW.level}`],
    credit: 'Image: CQ500 (qure.ai), de-identified · CC BY-NC-SA 4.0',
  }
}


/** What a frame is called, by the kind of series: a slice of a stack, a frame of a loop. */
const FRAME_WORD: Record<ImageSeries['kind'], 'slice' | 'frame' | 'image'> = { stack: 'slice', loop: 'frame', single: 'image' }
/** A study of distinct images (a PA and a lateral) steps image by image, not slice by slice. */
const wordFor = (s: ImageSeries): 'slice' | 'frame' | 'image' => (s.frameLabels ? 'image' : FRAME_WORD[s.kind])

/** "W 1500 : L −600" from the importer's "W1500L-600"; percentile-windowed pixels say so. */
function windowLine(w: string): string {
  const m = /^W(-?\d+)L(-?\d+)$/.exec(w)
  return m ? `W ${m[1]} : L ${m[2].replace('-', '−')}` : 'Auto window'
}

/** An open-dataset series' view: its modality and view in the corner, its source under the image. */
export function imageView(s: ImageSeries, description: string): SeriesView {
  const word = wordFor(s)
  const of = (n: number) => (s.frames > 1 ? `, ${word} ${n} of ${s.frames}` : '')
  return {
    key: s.key,
    kind: s.kind,
    frames: s.frames,
    path: (n) => framePath(s.key, n),
    label: (n) => `${description}${of(n)}${s.frameLabels?.[n - 1] ? `, ${s.frameLabels[n - 1]}` : ''}`,
    alt: (n) => `${s.modality} ${s.bodyPart.toLowerCase()}, ${s.frameLabels?.[n - 1] ?? s.view}${of(n)}`,
    frameNote: (n) => s.frameLabels?.[n - 1],
    frameWord: word,
    pixelSpacing: s.pixelSpacing,
    topLeft: [`${s.modality} · ${s.bodyPart}`, s.view],
    topRight: [
      s.kind === 'single' ? `${s.columns} × ${s.rows}` : s.kind === 'loop' ? `${s.frames} frames` : s.frameLabels ? `${s.frames} images` : `${s.frames} of ${s.seriesTotal} slices`,
      windowLine(s.window),
    ],
    credit: `Image: ${s.source.credit} · ${s.source.licence}`,
  }
}

/** The view of whatever pixels a study has — its head CT or its open-dataset series — or none. */
export function seriesViewFor(study: ImagingStudy): SeriesView | undefined {
  const n = ncctFor(study)
  if (n) return ncctView(n)
  const i = imageFor(study)
  return i ? imageView(i, study.description) : undefined
}
