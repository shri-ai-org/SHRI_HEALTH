// SHRI_HEALTH: src/data/ncct.generated.ts lists imported head-CT series from a public dataset of real,
// de-identified patients, under a non-commercial licence. It feeds the sample screens only. A real-API
// build (vite.config.ts) reads this empty stand-in instead, so the demo carries none of it (D12:
// synthetic data only; D75: licences).
import type { NcctStudy, NcctTruth } from '../src/data/ncct.generated'

export type { NcctStudy, NcctTruth }

export const NCCT_WINDOW = { width: 80, level: 40 } as const

export const NCCT_STUDIES: Record<string, NcctStudy> = {}

export function slicePath(_key: string, _index: number): string {
  return ''
}
