// What Telehealth remembers: each teleconsult's session, its live transcript and
// what was recorded — kept on this device (localStorage; the recording itself in
// IndexedDB, recordingStore.ts) and sent to the transcript store on the server
// (teleApi.ts) whenever it can be reached. A line the server has not yet confirmed
// stays marked until it has, so a dropped connection costs nothing.
//
// Per patient it also keeps the note draft, so leaving the session for the
// prescription and coming back finds it, and which notes the doctor saved to the
// record from the visit. A transcript line can be corrected until the visit is
// marked done; the words first heard stay with it. The recording consent is the patient's,
// from the patient portal (visits.portalConsent) — not kept or set here.
//
// The video is a Jitsi room inside the visit page, so a reload leaves the room;
// the open session is kept so the doctor can rejoin it, but its recording stops,
// since the microphone does not outlive the page. Any other session left open
// is closed at its last heard line.
//
// Each Start recording makes its own recording (a part), so stopping and starting
// again in one call never overwrites what was recorded before.

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { portalConsent } from './visits'
import { teleApi, teleApiBase } from './teleApi'
import type { OfficialRecord, Speaker, TeleSegment, TeleSessionMeta } from './teleTypes'

export interface RecordingInfo {
  /** Where its pieces are kept in IndexedDB. */
  key: string
  mime: string
  /** When the recorder started — the captions' zero. */
  startedAt: number
  bytes: number
  /** The call's picture is in it, not only its sound. */
  video: boolean
  removed?: boolean
}

export interface TeleSessionRecord extends TeleSessionMeta {
  segments: TeleSegment[]
  /** Lines the server has not confirmed yet. */
  unsynced: string[]
  metaDirty: boolean
  /** Bumped by every change to the session or its official transcript, so a sync never clears a change it did not send. */
  rev: number
  official?: OfficialRecord
  officialDirty?: boolean
  recordings?: RecordingInfo[]
}

export type ChannelState = 'off' | 'connecting' | 'live' | 'browser' | 'paused' | 'error'
export type SyncState = 'none' | 'syncing' | 'server' | 'device'

export interface LiveCapture {
  sid: string
  startedAt: number
  recording: 'recording' | 'finalising' | 'off'
  channels: Record<Speaker, ChannelState>
  partials: Record<Speaker, string>
  levels: Record<Speaker, number>
  notices: string[]
}

interface TeleState {
  sessions: Record<string, TeleSessionRecord>
  /** Each patient's most recent session. */
  latest: Record<string, string>
  notes: Record<string, string>
  /** The consultation notes saved to the record from each patient's video visits (record ids). */
  saved: Record<string, string[]>
  /** When the doctor marked the visit done — after the call, once the notes are finished. */
  done: Record<string, number>
  /** The session whose call is open in this page — never kept across a reload. */
  activeSid?: string
  live?: LiveCapture
  sync: SyncState

  setNote: (patientId: string, note: string) => void
  addSaved: (patientId: string, noteId: string) => void
  /** The doctor's correction of a transcript line; the first words heard are kept. */
  correctSegment: (sid: string, segId: string, text: string, by: string) => void
  markDone: (patientId: string) => void
  reopen: (patientId: string) => void
  begin: (meta: Omit<TeleSessionMeta, 'id' | 'startedAt'>) => string
  patchSession: (sid: string, patch: Partial<TeleSessionRecord>) => void
  addSegment: (sid: string, seg: TeleSegment) => void
  setOfficial: (sid: string, o: OfficialRecord) => void
  /** What is recorded on this device — not the server's business, so it is never sent. */
  setRecording: (sid: string, r: RecordingInfo) => void
  end: (sid: string) => void
  setLive: (fn: (l: LiveCapture | undefined) => LiveCapture | undefined) => void
  markSynced: (sid: string, ids: string[], rev: number) => void
  setSync: (s: SyncState) => void
}

export const useTele = create<TeleState>()(
  persist(
    (set) => ({
      sessions: {},
      latest: {},
      done: {},
      notes: {},
      saved: {},
      sync: 'none',

      setNote: (patientId, note) => set((s) => ({ notes: { ...s.notes, [patientId]: note } })),
      addSaved: (patientId, noteId) => set((s) => ({ saved: { ...s.saved, [patientId]: [...(s.saved[patientId] ?? []), noteId] } })),
      correctSegment: (sid, segId, text, by) =>
        set((s) => {
          const r = s.sessions[sid]
          if (!r) return s
          // The server keeps the line as first sent; a correction lives with this device's record and the files made from it.
          const segments = r.segments.map((g) => (g.id === segId ? { ...g, text, heard: g.heard ?? g.text, correctedAt: Date.now(), correctedBy: by } : g))
          return { sessions: { ...s.sessions, [sid]: { ...r, segments } } }
        }),
      markDone: (patientId) => set((s) => ({ done: { ...s.done, [patientId]: Date.now() } })),
      reopen: (patientId) =>
        set((s) => {
          const done = { ...s.done }
          delete done[patientId]
          return { done }
        }),

      begin: (meta) => {
        const startedAt = Date.now()
        const id = `TC-${meta.patientId}-${startedAt.toString(36)}`.replace(/[^A-Za-z0-9._:-]/g, '-')
        const rec: TeleSessionRecord = { ...meta, id, startedAt, segments: [], unsynced: [], metaDirty: true, rev: 0 }
        set((s) => ({ sessions: { ...s.sessions, [id]: rec }, latest: { ...s.latest, [meta.patientId]: id }, activeSid: id }))
        scheduleSync()
        return id
      },
      patchSession: (sid, patch) => {
        set((s) => (s.sessions[sid] ? { sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], ...patch, metaDirty: true, rev: s.sessions[sid].rev + 1 } } } : s))
        scheduleSync()
      },
      addSegment: (sid, seg) => {
        set((s) => {
          const r = s.sessions[sid]
          if (!r) return s
          return { sessions: { ...s.sessions, [sid]: { ...r, segments: [...r.segments, seg], unsynced: [...r.unsynced, seg.id] } } }
        })
        scheduleSync()
      },
      setOfficial: (sid, o) => {
        set((s) => (s.sessions[sid] ? { sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], official: o, officialDirty: true, rev: s.sessions[sid].rev + 1 } } } : s))
        scheduleSync()
      },
      setRecording: (sid, info) =>
        set((s) => {
          const r = s.sessions[sid]
          if (!r) return s
          const list = r.recordings ?? []
          const recordings = list.some((x) => x.key === info.key) ? list.map((x) => (x.key === info.key ? info : x)) : [...list, info]
          return { sessions: { ...s.sessions, [sid]: { ...r, recordings } } }
        }),
      end: (sid) => {
        set((s) => ({
          sessions: s.sessions[sid] ? { ...s.sessions, [sid]: { ...s.sessions[sid], endedAt: Date.now(), metaDirty: true, rev: s.sessions[sid].rev + 1 } } : s.sessions,
          activeSid: s.activeSid === sid ? undefined : s.activeSid,
        }))
        scheduleSync()
      },
      setLive: (fn) => set((s) => ({ live: fn(s.live) })),
      markSynced: (sid, ids, rev) =>
        set((s) => {
          const r = s.sessions[sid]
          if (!r) return s
          const done = new Set(ids)
          return {
            sessions: {
              ...s.sessions,
              [sid]: { ...r, unsynced: r.unsynced.filter((i) => !done.has(i)), ...(r.rev === rev ? { metaDirty: false, officialDirty: false } : {}) },
            },
          }
        }),
      setSync: (sync) => set({ sync }),
    }),
    {
      name: 'shri.tele',
      version: 4,
      // Version 3 dropped what the Google Meet visit kept per patient — its link, the invited mark and a consent
      // the doctor set — for the Jitsi room. Version 4 dropped the scripted visit "finished this morning" with a
      // clinic patient, so Telehealth holds only what really happened, for the shared teleconsults.
      migrate: (persisted, from) => {
        const st = (persisted ?? {}) as Partial<TeleState> & { consent?: unknown; meetUri?: unknown; invited?: unknown }
        if (from < 3) {
          delete st.consent
          delete st.meetUri
          delete st.invited
        }
        if (from < 4) {
          const DEMO = 'TC-demo-SD-P-01'
          if (st.sessions) delete st.sessions[DEMO]
          if (st.latest?.['SD-P-01'] === DEMO) {
            delete st.latest['SD-P-01']
            if (st.done) delete st.done['SD-P-01']
          }
        }
        return st as TeleState
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ sessions: s.sessions, latest: s.latest, notes: s.notes, saved: s.saved, done: s.done, activeSid: s.activeSid }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const sessions = { ...state.sessions }
        for (const [id, r] of Object.entries(sessions))
          if (!r.endedAt && id !== state.activeSid) sessions[id] = { ...r, endedAt: r.segments.at(-1)?.endMs ?? r.startedAt, metaDirty: true, rev: (r.rev ?? 0) + 1 }
        useTele.setState({ sessions })
        scheduleSync()
      },
    },
  ),
)

/** The patient's answer to “may we record?”, from the patient portal; undefined while they have not answered. */
export const consentOf = (_s: TeleState, patientId: string): 'given' | 'declined' | undefined => portalConsent(patientId)

/* ------------------------------------------------------------ to the server */

let timer = 0
let running = false

/** Sends what the server has not confirmed, shortly; again every 15 s for as long as it cannot be reached. */
export function scheduleSync(delay = 1200) {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void syncAll(), delay)
}

async function syncAll() {
  if (running) return scheduleSync(800)
  const st = useTele.getState()
  const dirty = Object.values(st.sessions).filter((r) => r.metaDirty || r.unsynced.length || r.officialDirty)
  if (!teleApiBase()) {
    st.setSync(Object.keys(st.sessions).length ? 'device' : 'none')
    return
  }
  if (!dirty.length) {
    if (st.sync === 'syncing' || st.sync === 'device') st.setSync('server')
    return
  }
  running = true
  st.setSync('syncing')
  try {
    for (const r of dirty) {
      const { segments, unsynced, official, officialDirty, rev } = useTele.getState().sessions[r.id]
      // The session goes first, every time anything does: the server keeps lines only for a session it has.
      await teleApi.putSession(r)
      const pending = new Set(unsynced)
      const batch = segments.filter((s) => pending.has(s.id)).slice(0, 500)
      if (batch.length) await teleApi.addSegments(r.id, batch)
      if (official && officialDirty) await teleApi.putOfficial(r.id, official)
      useTele.getState().markSynced(
        r.id,
        batch.map((b) => b.id),
        rev,
      )
    }
    const left = Object.values(useTele.getState().sessions).some((r) => r.metaDirty || r.unsynced.length || r.officialDirty)
    useTele.getState().setSync(left ? 'syncing' : 'server')
    if (left) scheduleSync(300)
  } catch {
    useTele.getState().setSync('device')
    scheduleSync(15_000)
  } finally {
    running = false
  }
}
