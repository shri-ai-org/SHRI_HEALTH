// The files a doctor downloads after a video visit: the conversation as text and
// as captions for the recording, and the full visit record (who, when, the room,
// the patient's consent, the doctor's note and the conversation). Pure functions,
// so the flows and the page share them.

import type { Speaker, TeleSegment } from './teleTypes'

export const SPEAKER_LABEL: Record<Speaker, string> = { doctor: 'Doctor', patient: 'Patient', call: 'Call' }

const two = (n: number) => String(n).padStart(2, '0')
export const clockOf = (ms: number) => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
const vttTime = (ms: number) => {
  const t = Math.max(0, ms)
  return `${two(Math.floor(t / 3_600_000))}:${two(Math.floor(t / 60_000) % 60)}:${two(Math.floor(t / 1000) % 60)}.${String(t % 1000).padStart(3, '0')}`
}

export interface RecordHeader {
  patient: string
  uhid?: string
  doctor?: string
  startedAt: number
  endedAt?: number
  meetUri?: string
  consent: string
}

export function headerText(h: RecordHeader) {
  return [
    `Teleconsult — ${h.patient}${h.uhid ? ` (${h.uhid})` : ''}`,
    `Date: ${new Date(h.startedAt).toLocaleString()}${h.endedAt ? ` – ${clockOf(h.endedAt)}` : ''}`,
    h.doctor ? `Doctor: ${h.doctor}` : '',
    h.meetUri ? `Video room: ${h.meetUri}` : '',
    `Recording and transcript consent: ${h.consent}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Who wrote the transcript down: the speech service hears both sides; the browser only the doctor. */
function writtenBy(segs: TeleSegment[]) {
  const service = segs.some((s) => s.source === 'shri-asr')
  const browser = segs.some((s) => s.source === 'browser')
  if (service && browser) return ' (written down by the Shri Health speech service until it stopped, then by the browser: the doctor’s words only)'
  if (service) return ' (Shri Health speech service: Tamil and English heard, English written)'
  if (browser) return ' (written down by the browser: the doctor’s words only, in English)'
  return ''
}

/** One line of the transcript as a file has it — a corrected line says so, with the words first heard. */
const lineText = (s: TeleSegment) =>
  `[${clockOf(s.startMs)}] ${SPEAKER_LABEL[s.speaker]}: ${s.text}${s.heard !== undefined ? ` (corrected by ${s.correctedBy ?? 'the doctor'}; first heard as “${s.heard}”)` : ''}`

export function liveTranscriptText(h: RecordHeader, segs: TeleSegment[]) {
  const body = segs.map(lineText).join('\n')
  return `${headerText(h)}\n\nLIVE TRANSCRIPT${writtenBy(segs)}\n\n${body || '(nothing was transcribed)'}\n`
}

/** Captions for the recording: times from when the recording started, so the file plays with them. */
export function liveTranscriptVtt(segs: TeleSegment[], recordingStart: number) {
  const cues = segs.map((s, i) => `${i + 1}\n${vttTime(s.startMs - recordingStart)} --> ${vttTime(Math.max(s.endMs, s.startMs + 1500) - recordingStart)}\n<v ${SPEAKER_LABEL[s.speaker]}>${s.text}`)
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

export function fullRecordText(h: RecordHeader, note: string, segs: TeleSegment[]) {
  return [
    headerText(h),
    `\nDOCTOR'S NOTE\n\n${note.trim() || '(no note written)'}`,
    `\nLIVE TRANSCRIPT\n\n${segs.map(lineText).join('\n') || '(nothing was transcribed)'}`,
  ]
    .filter(Boolean)
    .join('\n')
    .concat('\n')
}

export function saveFile(name: string, data: Blob | string, type = 'text/plain;charset=utf-8') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** `teleconsult-arjun-nair-2026-10-07-1005` — the stem every file of one session shares. */
export function fileStem(patient: string, startedAt: number) {
  const d = new Date(startedAt)
  const slug = patient.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `teleconsult-${slug}-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}
