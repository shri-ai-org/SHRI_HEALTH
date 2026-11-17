// SHRI_HEALTH: the illustrative images on an imaging report (#386, #393), for the record's Imaging
// reports tab ("View image") and the study viewer (S-15-04, src/shri/imaging/viewer/ApiImageStudy.tsx).
// Each image is read the D105 way: createDownloadUrl gives a one-time link (about a minute) to our
// own API's /files/{fileId}/content, and the viewer shows the image from that link, as the front
// desk's insurance-card photos do (the API client returns JSON bodies only). Nothing is cached or
// kept: a failed or expired link says so and asks again with fresh links. Never a sample picture.

import { createDownloadUrl } from '../../../../src/api/generated/endpoints/files/files'
import type { ImagingReportImage } from '../../../../src/api/generated/model'

import type { SeriesView } from './series'

/** The label every image carries on screen (#386): illustrative, never diagnostic. */
export const ILLUSTRATIVE = 'Illustrative image'

/** A report row offers "View image" only when it has images; a text-only report keeps no button. */
export function canView(report: { images: readonly unknown[] }): boolean {
  return report.images.length > 0
}

/** Where the study viewer opens a report's images: the report and its patient, both opaque IDs (D13). */
export function viewerPath(patientId: string, reportId: string): string {
  return `/radiology/study/${encodeURIComponent(reportId)}/view?patient=${encodeURIComponent(patientId)}`
}

export interface LoadedImage {
  image: ImagingReportImage
  /** The image's one-time link (about a minute); asked for again on Try again. */
  src: string
}

/** One image's fresh one-time link. */
export async function loadImage(image: ImagingReportImage): Promise<LoadedImage> {
  const link = await createDownloadUrl(image.id)
  if (link.status !== 200) throw new Error("The image's link could not be made")
  return { image, src: link.data.url }
}

/** Every image's link, asked for together: one failure fails the set, so the screen asks again. */
export function loadImages(images: ImagingReportImage[]): Promise<LoadedImage[]> {
  return Promise.all(images.map((image) => loadImage(image)))
}

/** The report's images as one series for the existing Workstation: one frame per image. */
export function illustrativeSeries(reportId: string, studyName: string, loaded: LoadedImage[]): SeriesView {
  const at = (n: number) => loaded[Math.min(Math.max(n, 1), loaded.length) - 1]
  return {
    key: `illustrative:${reportId}`,
    kind: loaded.length > 1 ? 'stack' : 'single',
    frames: loaded.length,
    path: (n) => at(n).src,
    label: (n) => `${studyName}, ${ILLUSTRATIVE.toLowerCase()} ${n} of ${loaded.length}`,
    alt: (n) => `${ILLUSTRATIVE}: ${at(n).image.caption}`,
    topLeft: [studyName],
    topRight: [ILLUSTRATIVE],
    credit: `${ILLUSTRATIVE}, not for diagnosis`,
    frameNote: (n) => at(n).image.caption,
    frameWord: 'image',
  }
}
