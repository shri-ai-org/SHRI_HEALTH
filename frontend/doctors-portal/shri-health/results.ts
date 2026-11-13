// SHRI_HEALTH data layer: a patient's lab results and imaging reports, read only (#335), for the
// record's Test results (S-06-13) and Imaging reports (S-06-12) tabs, the Overview's two cards and
// the tab counts.
//   lab results     ⇐ listLabResults(patientId, { limit, cursor }): DiagnosticReport LAB, newest
//                     first, each with its analytes (value or text, reference range, H/L flag)
//   imaging reports ⇐ listImagingReports(patientId, { limit, cursor }): newest first, text only
//                     (impression and full report; no images behind them)
// A restricted chart answers 403 break-glass-required, which goes to the route's sealed card
// (RouteBoundary), as on the other record tabs; a role without the read answers 403
// permission-denied, which the page says in words. Any other failure goes to RouteBoundary's
// "This screen could not open" card: never sample data.
import { ApiError } from '../../src/api/client'
import { listImagingReports, listLabResults } from '../../src/api/generated/endpoints/orders/orders'
import type { CodeableConcept, ImagingReport, LabObservation, LabResult, Quantity, ReferenceRange } from '../../src/api/generated/model'
import { read } from './resource'

const PAGE = 100
/** Pages read at most (500 reports): a list longer than that is not one a screen can show. */
const MAX_PAGES = 5

/** The flag words the record's ClinicalFlag knows (src/shri/record/bits.tsx). */
const FLAG: Record<NonNullable<LabObservation['interpretation']>, string> = {
  N: 'Normal',
  H: '↑ High',
  L: '↓ Low',
  HH: '↑↑ Critical high',
  LL: '↓↓ Critical low',
  A: 'Abnormal',
}

export interface LabAnalyte {
  id: string
  name: string
  /** The value as shown: the number, or the lab's text. */
  value: string
  unit?: string
  /** The number, for the range bar; absent for a text result. */
  numeric?: number
  low?: number
  high?: number
  /** The reference range in words ("4–5.6 %"), or empty when the lab gives none. */
  range: string
  /** ClinicalFlag's word ("↑ High"); absent when the lab gives no interpretation. */
  flag?: string
  /** High, low or abnormal: anything but normal. */
  outside: boolean
}

export interface LabReport {
  id: string
  name: string
  status: string
  collectedAt?: string
  issuedAt?: string
  performer?: string
  conclusion?: string
  analytes: LabAnalyte[]
}

export interface ImagingReportRow {
  id: string
  name: string
  status: string
  studiedAt?: string
  issuedAt?: string
  performer?: string
  impression?: string
  text?: string
}

export interface ReadList<T> {
  items: T[]
  /** The role may not read this list (403 permission-denied). */
  denied: boolean
}

const textOf = (c: CodeableConcept, fallback: string) => c.text ?? c.codings?.[0]?.display ?? fallback

const num = (q?: Quantity) => (q ? String(q.value) : '')

function rangeText(r?: ReferenceRange): string {
  if (!r) return ''
  const unit = r.low?.unit || r.high?.unit
  const u = unit ? ` ${unit}` : ''
  if (r.low && r.high) return `${num(r.low)}–${num(r.high)}${u}`
  if (r.low) return `≥ ${num(r.low)}${u}`
  if (r.high) return `≤ ${num(r.high)}${u}`
  return r.text ?? ''
}

function analyte(o: LabObservation): LabAnalyte {
  return {
    id: o.id,
    name: textOf(o.code, 'Analyte'),
    value: o.value ? num(o.value) : (o.valueText ?? '—'),
    unit: o.value?.unit || undefined,
    numeric: o.value?.value,
    low: o.referenceRange?.low?.value,
    high: o.referenceRange?.high?.value,
    range: rangeText(o.referenceRange),
    flag: o.interpretation ? FLAG[o.interpretation] : undefined,
    outside: o.interpretation !== undefined && o.interpretation !== 'N',
  }
}

function labReport(r: LabResult): LabReport {
  return {
    id: r.id,
    name: textOf(r.code, 'Lab report'),
    status: r.status,
    collectedAt: r.collectedAt,
    issuedAt: r.issuedAt,
    performer: r.performer,
    conclusion: r.conclusion,
    analytes: r.observations.map(analyte),
  }
}

function imagingReport(r: ImagingReport): ImagingReportRow {
  return {
    id: r.id,
    name: textOf(r.code, 'Imaging study'),
    status: r.status,
    studiedAt: r.studiedAt,
    issuedAt: r.issuedAt,
    performer: r.performer,
    impression: r.impression,
    text: r.text,
  }
}

/** Every page of one list (up to MAX_PAGES), or `denied` on 403 permission-denied. */
async function allPages<A, T>(fetchPage: (cursor?: string) => Promise<{ status: number; data: unknown }>, map: (item: A) => T, what: string): Promise<ReadList<T>> {
  const items: T[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchPage(cursor)
      if (res.status !== 200) throw new Error(`The ${what} could not be read`)
      const data = res.data as { items: A[]; nextCursor?: string }
      items.push(...data.items.map(map))
      cursor = data.nextCursor
      if (!cursor) break
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.code === 'permission-denied') return { items: [], denied: true }
    throw e
  }
  return { items, denied: false }
}

/** The patient's lab reports from the API, newest first (suspends until read). */
export function usePatientLabResults(patientId: string): ReadList<LabReport> {
  return read(`lab-results:${patientId}`, () =>
    allPages((cursor) => listLabResults(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) }), labReport, 'lab results'),
  )
}

/** The patient's imaging reports from the API, newest first, text only (suspends until read). */
export function usePatientImagingReports(patientId: string): ReadList<ImagingReportRow> {
  return read(`imaging-reports:${patientId}`, () =>
    allPages((cursor) => listImagingReports(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) }), imagingReport, 'imaging reports'),
  )
}
