// The shapes a teleconsult's record is kept in — on this device, on the server
// (backend/telehealth), and in the files the doctor downloads.

export type Speaker = 'doctor' | 'patient' | 'call'

/** One line of the live transcript, as the speech service heard it. Times are epoch ms. */
export interface TeleSegment {
  id: string
  speaker: Speaker
  text: string
  startMs: number
  endMs: number
  source: 'shri-asr' | 'browser'
}

/** One entry of the official Google Meet transcript. `startMs` is epoch ms where known. */
export interface OfficialEntry {
  speaker: string
  text: string
  startMs?: number
  endMs?: number
}

export type MatchStatus = 'matched' | 'official-only' | 'live-only'

/** One row of the reconciled transcript: the Meet entry, the live lines it agrees with, or either alone. */
export interface ReconciledRow {
  status: MatchStatus
  startMs?: number
  speaker: string
  /** The words the row stands on: Meet's where it has them, ours otherwise. */
  text: string
  official?: OfficialEntry
  live: TeleSegment[]
  /** How closely the two agree, 0–1, where both are there. */
  score?: number
}

export interface OfficialRecord {
  source: 'meet-api' | 'upload'
  entries: OfficialEntry[]
  reconciled: ReconciledRow[]
  /** Links Google gives back with the transcript: the Docs transcript and the Drive recording. */
  docUrl?: string
  recordingUrl?: string
}

export interface TeleSessionMeta {
  id: string
  patientId: string
  encounterId?: string
  meetUri?: string
  meetCode?: string
  consent: 'given' | 'declined'
  startedAt: number
  endedAt?: number
}
