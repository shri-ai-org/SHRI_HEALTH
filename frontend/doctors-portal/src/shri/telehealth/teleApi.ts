// The teleconsult transcript store on Shri Health's speech service (backend/telehealth):
// the session, its live transcript lines and the official Meet transcript, kept in the
// service's database. It lives beside the dictation socket, so its address follows
// from the socket's — ws://host:8765/ws/transcribe → http://host:8765/tele — unless
// VITE_TELE_API, or a `shri.teleApi` entry in this device's localStorage, names one.
// Every call times out, and a store that cannot be reached is the caller's to handle:
// the transcript is then kept on this device and sent when the store is back.
// With no speech service (as now), nothing names a store, and it stays on this device.

import { asrUrl } from '../logic/asrStream'

import type { OfficialRecord, TeleSegment, TeleSessionMeta } from './teleTypes'

const TOKEN: string | undefined = import.meta.env.VITE_ASR_TOKEN || undefined

export function teleApiBase(): string | undefined {
  try {
    const local = window.localStorage.getItem('shri.teleApi')
    if (local === 'off') return undefined
    if (local) return local.replace(/\/$/, '')
  } catch {
    /* storage blocked — the build's own setting stands */
  }
  if (import.meta.env.VITE_TELE_API) return String(import.meta.env.VITE_TELE_API).replace(/\/$/, '')
  const ws = asrUrl()
  if (!ws) return undefined
  return ws.replace(/^ws/, 'http').replace(/\/ws\/transcribe.*$/, '/tele')
}

async function call<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  const base = teleApiBase()
  if (!base) throw new Error('No transcript store is configured.')
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), 8000)
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(TOKEN ? { 'X-Shri-Token': TOKEN } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`The transcript store answered ${res.status}.`)
    return (await res.json()) as T
  } finally {
    window.clearTimeout(timer)
  }
}

export const teleApi = {
  putSession: (m: TeleSessionMeta) =>
    call('PUT', `/sessions/${encodeURIComponent(m.id)}`, {
      patientId: m.patientId,
      encounterId: m.encounterId,
      meetUri: m.meetUri || undefined,
      meetCode: m.meetCode || undefined,
      consent: m.consent,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
    }),
  addSegments: (sid: string, segments: TeleSegment[]) => call<{ stored: number }>('POST', `/sessions/${encodeURIComponent(sid)}/segments`, { segments }),
  putOfficial: (sid: string, o: OfficialRecord) => call('PUT', `/sessions/${encodeURIComponent(sid)}/official`, { source: o.source, entries: o.entries, reconciled: o.reconciled }),
  getSession: (sid: string) =>
    call<{ session: TeleSessionMeta; segments: TeleSegment[]; official: (OfficialRecord & { fetchedAt: number }) | null }>('GET', `/sessions/${encodeURIComponent(sid)}`),
}
