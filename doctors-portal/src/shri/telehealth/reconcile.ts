// After the call: the live transcript (ours — Tamil and English heard, English
// written, a line at each pause) set against the official Google Meet transcript
// (Meet's — its own lines, named speakers). Neither is simply right: Meet names
// who spoke and misses Tamil; ours hears Tamil and cannot name anyone. So the two
// are aligned, in order, line by line:
//
//   matched        both heard it — Meet's words and speaker, ours kept beside them
//   official-only  only Meet heard it (our microphone or tab audio missed it)
//   live-only      only we heard it (often Tamil, which Meet does not transcribe)
//
// The alignment is a sequence alignment (both run forward in time, so a match never
// crosses another), scored on shared words and, where both have times, closeness
// in time. A long Meet line that our service split at pauses takes its neighbours
// too. Pure functions — no I/O — so the flows and the page share them.

import type { OfficialEntry, ReconciledRow, Speaker, TeleSegment } from './teleTypes'

export const SPEAKER_LABEL: Record<Speaker, string> = { doctor: 'Doctor', patient: 'Patient', call: 'Call' }

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)

function overlap(a: string[], b: string[]) {
  if (!a.length || !b.length) return { dice: 0, contain: 0 }
  const B = new Set(b)
  const shared = new Set(a.filter((w) => B.has(w))).size
  return { dice: (2 * shared) / (new Set(a).size + B.size), contain: shared / new Set(a).size }
}

/** How well a live line and a Meet entry agree, 0–1. */
function pairScore(l: TeleSegment, lw: string[], o: OfficialEntry, ow: string[]) {
  const { dice } = overlap(lw, ow)
  if (o.startMs === undefined) return dice
  const ref = o.endMs !== undefined && l.startMs >= o.startMs && l.startMs <= o.endMs ? 0 : Math.abs(l.startMs - o.startMs)
  const near = Math.max(0, 1 - ref / 45_000)
  return 0.7 * dice + 0.3 * near
}

const MATCH = 0.3

export function reconcile(live: TeleSegment[], official: OfficialEntry[]): ReconciledRow[] {
  const L = [...live].sort((a, b) => a.startMs - b.startMs)
  const O = official
  const lw = L.map((l) => words(l.text))
  const ow = O.map((o) => words(o.text))
  const n = L.length
  const m = O.length

  // Best total score aligning L[i:] with O[j:]; a pair counts only above MATCH.
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  const score = (i: number, j: number) => pairScore(L[i], lw[i], O[j], ow[j])
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1) {
      const s = score(i, j)
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], s >= MATCH ? s + best[i + 1][j + 1] : 0)
    }

  const liveOf = new Map<number, number[]>() // official j → the live lines it took
  const scoreOf = new Map<number, number>()
  const used = new Set<number>()
  for (let i = 0, j = 0; i < n && j < m; ) {
    const s = score(i, j)
    if (s >= MATCH && best[i][j] === s + best[i + 1][j + 1]) {
      liveOf.set(j, [i])
      scoreOf.set(j, s)
      used.add(i)
      i += 1
      j += 1
    } else if (best[i][j] === best[i + 1][j]) i += 1
    else j += 1
  }

  // A Meet line our service split at its pauses: an unmatched neighbour whose words are mostly in it joins it.
  for (const [j, taken] of liveOf) {
    for (const dir of [-1, 1]) {
      let i = dir < 0 ? Math.min(...taken) - 1 : Math.max(...taken) + 1
      while (i >= 0 && i < n && !used.has(i) && overlap(lw[i], ow[j]).contain >= 0.6) {
        taken.push(i)
        used.add(i)
        i += dir
      }
    }
    taken.sort((a, b) => a - b)
  }

  // Woven back into one timeline: every Meet entry, and every live line no entry took, in order.
  const rows: ReconciledRow[] = []
  let next = 0
  const flushLive = (until: number) => {
    for (; next < until; next += 1) if (!used.has(next)) rows.push(liveRow(L[next]))
  }
  O.forEach((o, j) => {
    const taken = liveOf.get(j)
    if (taken) {
      flushLive(taken[0])
      // Our clock is to the second; Meet's document export only stamps every few minutes.
      rows.push({ status: 'matched', startMs: L[taken[0]].startMs, speaker: o.speaker, text: o.text, official: o, live: taken.map((i) => L[i]), score: scoreOf.get(j) })
      next = Math.max(next, taken[taken.length - 1] + 1)
    } else {
      if (o.startMs !== undefined) flushLive(firstAfter(L, next, o.startMs))
      rows.push({ status: 'official-only', startMs: o.startMs, speaker: o.speaker, text: o.text, official: o, live: [] })
    }
  })
  flushLive(n)
  return rows
}

function firstAfter(L: TeleSegment[], from: number, t: number) {
  let i = from
  while (i < L.length && L[i].startMs < t) i += 1
  return i
}

const liveRow = (l: TeleSegment): ReconciledRow => ({ status: 'live-only', startMs: l.startMs, speaker: SPEAKER_LABEL[l.speaker], text: l.text, live: [l] })

/* ------------------------------------------------------------ the official transcript, uploaded */

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/
const toMs = (h: string | undefined, m: string, s: string, f?: string) => ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number((f ?? '0').padEnd(3, '0'))

/**
 * A Meet transcript the doctor downloaded: the Google Doc as plain text (File → Download → Plain text),
 * WebVTT or SRT captions, or JSON (Meet API entries, or this page's own export). Times in the file are
 * offsets from the start of the call, so `callStart` places them on the clock.
 */
export function parseOfficialFile(name: string, body: string, callStart: number): OfficialEntry[] {
  const text = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(text)) return parseJson(text)
  if (/\.(vtt|srt|sbv)$/i.test(name) || /^WEBVTT/.test(text) || /-->/.test(text)) return parseCues(text, callStart)
  return parseDoc(text, callStart)
}

function parseJson(text: string): OfficialEntry[] {
  const data = JSON.parse(text) as unknown
  const list = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown>).transcriptEntries ?? (data as Record<string, unknown>).entries ?? (data as Record<string, unknown>).official ?? []) as unknown[]
  return (list as Record<string, unknown>[])
    .filter((e) => typeof e.text === 'string' && e.text.trim())
    .map((e) => ({
      speaker: String(e.speaker ?? e.participant ?? 'Participant'),
      text: String(e.text).trim(),
      startMs: typeof e.startMs === 'number' ? e.startMs : typeof e.startTime === 'string' ? Date.parse(e.startTime) : undefined,
      endMs: typeof e.endMs === 'number' ? e.endMs : typeof e.endTime === 'string' ? Date.parse(e.endTime) : undefined,
    }))
}

function splitSpeaker(line: string): { speaker: string; text: string } {
  const v = line.match(/^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/)
  if (v) return { speaker: v[1].trim(), text: v[2].trim() }
  const c = line.match(/^([^:]{1,60}):\s+(.+)$/)
  return c ? { speaker: c[1].trim(), text: c[2].trim() } : { speaker: 'Participant', text: line.trim() }
}

function parseCues(text: string, callStart: number): OfficialEntry[] {
  const out: OfficialEntry[] = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() && !/^WEBVTT|^NOTE\b|^\d+$/.test(l.trim()))
    const at = lines.findIndex((l) => l.includes('-->') || /^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}$/.test(l))
    if (at < 0) continue
    const [a, b] = lines[at].split(/\s*-->\s*|,(?=\d+:)/)
    const pa = a.trim().match(TS)
    const pb = b?.trim().split(/\s/)[0].match(TS)
    const body = lines.slice(at + 1).join(' ').trim()
    if (!pa || !body) continue
    const { speaker, text: said } = splitSpeaker(body)
    out.push({ speaker, text: said, startMs: callStart + toMs(pa[1], pa[2], pa[3], pa[4]), endMs: pb ? callStart + toMs(pb[1], pb[2], pb[3], pb[4]) : undefined })
  }
  return out
}

/** The Google Doc Meet writes, as plain text: a header, then timestamp lines and "Name: words" paragraphs. */
function parseDoc(text: string, callStart: number): OfficialEntry[] {
  const out: OfficialEntry[] = []
  let offset: number | undefined
  let started = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^Meeting ended after|^This editable transcript|^Transcription ended after/i.test(line)) continue
    const ts = line.match(TS)
    if (ts) {
      offset = toMs(ts[1], ts[2], ts[3], ts[4])
      started = true
      continue
    }
    if (/^transcript$/i.test(line)) {
      started = true
      continue
    }
    const said = line.match(/^([^:]{1,60}):\s+(.+)$/)
    if (said) {
      // The header's "Attendees: …" and the like are not lines of the call.
      if (/^(attendees|title|date|meeting|invited)$/i.test(said[1].trim())) continue
      started = true
      out.push({ speaker: said[1].trim(), text: said[2].trim(), startMs: offset !== undefined ? callStart + offset : undefined })
    } else if (started && out.length) out[out.length - 1].text += ` ${line}`
  }
  return out
}

/* ------------------------------------------------------------ files the doctor downloads */

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
    h.meetUri ? `Google Meet: ${h.meetUri}` : '',
    `Recording and transcript consent: ${h.consent}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function liveTranscriptText(h: RecordHeader, segs: TeleSegment[]) {
  const body = segs.map((s) => `[${clockOf(s.startMs)}] ${SPEAKER_LABEL[s.speaker]}: ${s.text}`).join('\n')
  return `${headerText(h)}\n\nLIVE TRANSCRIPT (Shri Health speech service — Tamil and English heard, English written)\n\n${body || '(nothing was transcribed)'}\n`
}

/** Captions for the recording: times from when the recording started, so the file plays with them. */
export function liveTranscriptVtt(segs: TeleSegment[], recordingStart: number) {
  const cues = segs.map((s, i) => `${i + 1}\n${vttTime(s.startMs - recordingStart)} --> ${vttTime(Math.max(s.endMs, s.startMs + 1500) - recordingStart)}\n<v ${SPEAKER_LABEL[s.speaker]}>${s.text}`)
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

const TAG: Record<ReconciledRow['status'], string> = { matched: '', 'official-only': ' [Meet only]', 'live-only': ' [Shri only]' }

export function reconciledText(h: RecordHeader, rows: ReconciledRow[]) {
  const counts = { matched: 0, 'official-only': 0, 'live-only': 0 }
  rows.forEach((r) => (counts[r.status] += 1))
  const body = rows
    .map((r) => {
      const head = `[${r.startMs ? clockOf(r.startMs) : '--:--:--'}] ${r.speaker}:${TAG[r.status]} ${r.text}`
      const heard = r.live.map((l) => l.text).join(' ')
      return r.status === 'matched' && (r.score ?? 1) < 0.6 && heard ? `${head}\n           (Shri heard: ${heard})` : head
    })
    .join('\n')
  return `${headerText(h)}\n\nRECONCILED TRANSCRIPT — the official Google Meet transcript set against the live one\n${counts.matched} lines in both · ${counts['official-only']} only in Meet · ${counts['live-only']} only in the live transcript\n\n${body}\n`
}

export function fullRecordText(h: RecordHeader, note: string, segs: TeleSegment[], rows?: ReconciledRow[]) {
  return [
    headerText(h),
    `\nDOCTOR'S NOTE\n\n${note.trim() || '(no note written)'}`,
    `\nLIVE TRANSCRIPT\n\n${segs.map((s) => `[${clockOf(s.startMs)}] ${SPEAKER_LABEL[s.speaker]}: ${s.text}`).join('\n') || '(nothing was transcribed)'}`,
    rows?.length ? `\nRECONCILED WITH THE GOOGLE MEET TRANSCRIPT\n\n${rows.map((r) => `[${r.startMs ? clockOf(r.startMs) : '--:--:--'}] ${r.speaker}:${TAG[r.status]} ${r.text}`).join('\n')}` : '',
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
