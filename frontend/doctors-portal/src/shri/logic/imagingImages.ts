// SHRI_HEALTH: the illustrative images on an imaging report (#386, #393), for the record's Imaging
// reports tab ("View image") and the study viewer (S-15-04, src/shri/imaging/viewer/ApiImageStudy.tsx).
// Each image is read the D105 way: createDownloadUrl gives a one-time link (about a minute) to our
// own API's /files/{fileId}/content; its token goes to downloadFileContent, which streams the file,
// and the screen shows it as a blob: URL. Nothing is cached or kept: a failed or expired read says so
// and asks again. Never a sample picture.

import { createDownloadUrl, downloadFileContent } from '../../../../src/api/generated/endpoints/files/files'
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

/** The token on a download link: our own API's /files/{fileId}/content?token=… (D105). */
export function tokenOf(link: string): string {
  const token = new URL(link, 'http://same-origin.invalid').searchParams.get('token')
  if (!token) throw new Error('The download link has no token')
  return token
}

export interface LoadedImage {
  image: ImagingReportImage
  /** A blob: URL for the image's bytes; revoke it when the viewer closes. */
  src: string
}

/** One image's bytes as a blob: URL, through a fresh one-time link. */
export async function loadImage(image: ImagingReportImage, toUrl: (blob: Blob) => string = (b) => URL.createObjectURL(b)): Promise<LoadedImage> {
  const link = await createDownloadUrl(image.id)
  if (link.status !== 200) throw new Error("The image's link could not be made")
  const content = await downloadFileContent(image.id, { token: tokenOf(link.data.url) })
  if (content.status !== 200) throw new Error('The image could not be read')
  return { image, src: toUrl(content.data) }
}

/** Every image on the report, read together: one failure fails the set, so the screen asks again. */
export function loadImages(images: ImagingReportImage[], toUrl?: (blob: Blob) => string): Promise<LoadedImage[]> {
  return Promise.all(images.map((image) => loadImage(image, toUrl)))
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
