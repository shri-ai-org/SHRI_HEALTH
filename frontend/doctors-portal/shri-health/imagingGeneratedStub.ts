// SHRI_HEALTH: src/data/imaging.generated.ts lists imported open-dataset images (source links, credits
// and share-alike licences). It feeds the sample screens only. A real-API build (vite.config.ts) reads
// this empty stand-in instead, so the demo carries none of it (D12: synthetic data only; D75: licences).
// The demo's images come from the API's download route (#387, D105).
import type { ImageSeries } from '../src/data/imaging.generated'

export type { ImageSeries }

export const IMAGE_SERIES: Record<string, ImageSeries> = {}

export function framePath(_key: string, _n: number): string {
  return ''
}
