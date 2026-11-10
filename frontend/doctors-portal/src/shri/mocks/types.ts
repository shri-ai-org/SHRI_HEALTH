import type { LucideIcon } from 'lucide-react'

import type { ModuleKey } from '../app/paths'

export type Tone = 'crit' | 'warn' | 'norm' | 'pend' | 'neu'
export type Place = 'opd' | 'tele' | 'ward' | 'icu' | 'ed'
export type OpdStatus = 'admitting' | 'call' | 'waiting' | 'inroom' | 'notarrived' | 'seen'
export type IpStatus = 'highrisk' | 'admittedtoday' | 'dischargetoday' | null
export type KpiId = 'today' | 'waiting' | 'inroom' | 'admissions' | 'icu' | 'critical'
export type PatientTab = 'opd' | 'ip'
export type PatientFilter = 'waiting' | 'inroom' | 'admissions' | 'icu'
export type TimelineKind = 'brief' | 'opd' | 'tele' | 'ward' | 'cosign' | 'disch' | 'stroke' | 'registry'
/** A Patients Today tab switched in place, or a module (`MODULE` in app/paths.ts). */
export type Opens = 'tab:opd' | 'tab:ip' | ModuleKey
export type FacilityCode = 'MH' | 'AN' | 'TH'
export type PersonaId = 'consultant' | 'resident' | 'stroke'
export type LanguageCode = 'EN' | 'TA' | 'HI'
export type ConfidenceBand = 'HIGH' | 'MED' | 'LOW' | null
export type ThemeId = 'light' | 'dark'

export interface Doctor {
  name: string
  short: string
  surname: string
  reg: string
  speciality: string
}

export interface Facility {
  code: FacilityCode
  name: string
  meta: string
}

export interface KpiSpec {
  id: KpiId
  label: string
  icon: LucideIcon
}

/** A chip on a timeline row: bold number + short word, toned. */
export type TimelineChip = [number: string, word: string, tone: Tone]

export interface TimelineBlock {
  start: string
  end: string | null
  title: string
  kind: TimelineKind
  ai?: boolean
  chips: TimelineChip[]
  opens: Opens
}

export interface OpdPatient {
  id: string
  name: string
  age: number
  sex: 'M' | 'F'
  uhid: string
  place: 'opd' | 'tele'
  kind: 'fu' | 'new'
  status: OpdStatus
  callTime?: string
  /** Booking order, HH:mm — ties in the sort break by this. */
  booked: string
  highRisk?: boolean
}

export interface Inpatient {
  id: string
  name: string
  age: number
  sex: 'M' | 'F'
  bed: string
  place: 'ward' | 'icu' | 'ed'
  highRisk?: boolean
  status: IpStatus
  uhid: string
}

export interface AttentionItem {
  patient: string
  reason: string
  tone: Tone
  at: string
  locked?: boolean
}

export interface TaskSpec {
  icon: LucideIcon
  label: string
  detail?: string
  count: number
  tone: Tone
  /** Set on the per-patient dictated-note rows. */
  patientId?: string
}

export interface Todo {
  id: number
  text: string
  /** ISO datetime */
  saved: string
  done: boolean
}

export interface DictatedDraft {
  id: number
  patientId: string
  text: string
  /** HH:mm */
  at: string
}

export interface QuickPanelChange {
  code: string
  label: string
  value: string
  flag?: string
  tone?: Tone
  at: string
}

export interface QuickPanelData {
  sub: string
  lastSeen: string
  changes: QuickPanelChange[]
  more: number
  risk: { band: 'High' | 'Moderate' | 'Low'; confidence: ConfidenceBand } | { abstained: true }
  lastNote: { label: string; text: string; by: string; at: string } | null
  audit: string[]
  nursePhone: string
}

export interface NotificationItem {
  text: string
  at: string
  opens: string
}

export interface Session {
  name: string
  start: string
  end: string | null
  /** Where the tile links. */
  opens?: Opens
}

export interface Booking {
  patientId: string
  name: string
  detail: string
  at: string
}

export interface CitedAnswer {
  q: string
  a: string
  cites: { label: string; href?: string }[]
}

export interface RecordVital {
  label: string
  value: string
  unit: string
  flag: 'high' | 'low' | null
}

export interface TrendSeries {
  id: string
  label: string
  unit: string
  ref: [number, number]
  points: { at: string; value: number }[]
}

export interface RecordFact {
  label: string
  value: string
  sub?: string
  empty: string
  chip?: { text: string; tone: Tone }
}

export interface WhyBox {
  claim: string
  inputs: string
  evidence: string
  model: string
  limits: string
}

export interface Admission {
  state: 'inprogress' | 'admitted'
  type: 'ward' | 'icu'
  priority: 'critical' | 'urgent' | 'routine'
  note: string
  bed?: string
  at: string
}
