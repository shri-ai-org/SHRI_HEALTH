// Google Meet: the call itself, its official recording and its official transcript.
//
// Meet cannot be framed inside another page, so the call runs in its own window and
// the session page keeps the link. Without Google configured the doctor pastes a Meet
// link (or opens meet.new and pastes the one it makes). With VITE_GOOGLE_CLIENT_ID set,
// the doctor signs in with Google once per session (Google Identity Services, a token
// that never leaves the browser) and the page can:
//   · create the Meet space, with Meet's own recording and transcript switched on
//     where the Workspace edition allows it (Business Standard and up);
//   · after the call, read the conference's official transcript entries, who said
//     each one, and the links to the transcript document and the recording in Drive.
// Meet REST API v2: https://developers.google.com/meet/api/reference/rest

import type { OfficialEntry } from './teleTypes'

const CLIENT_ID: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID || undefined
const SCOPES = 'https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/meetings.space.readonly'
const API = 'https://meet.googleapis.com/v2'

export const googleConfigured = () => Boolean(CLIENT_ID)

const CODE = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i

/** The meeting code in a Meet link or a bare code — `abc-mnop-xyz` — or undefined if there is none. */
export function meetCode(input: string | undefined): string | undefined {
  const m = input?.trim().match(CODE)
  return m ? m[1].toLowerCase() : undefined
}

export const meetLink = (code: string) => `https://meet.google.com/${code}`

/** The call, in its own window — Meet refuses to be framed inside another page. */
export function openMeet(uri: string) {
  window.open(uri, 'shri-meet', 'noopener')
}

/* ------------------------------------------------------------ sign-in */

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}
interface Gis {
  accounts: { oauth2: { initTokenClient: (o: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { message?: string }) => void }) => { requestAccessToken: (o?: { prompt?: string }) => void } } }
}

let gisLoading: Promise<Gis> | null = null
let token: { value: string; expires: number } | null = null

/** Loads Google sign-in ahead of the click, so its window opens straight from the button and is not blocked. */
export function preloadGoogle() {
  if (CLIENT_ID) void loadGis().catch(() => undefined)
}

function loadGis(): Promise<Gis> {
  const w = window as unknown as { google?: Gis }
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google)
  gisLoading ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => (w.google ? resolve(w.google) : reject(new Error('Google sign-in did not load.')))
    s.onerror = () => {
      gisLoading = null
      reject(new Error('Google sign-in could not be loaded. Check the connection.'))
    }
    document.head.appendChild(s)
  })
  return gisLoading
}

/** A Google access token for the Meet API — the one held if still good, otherwise Google's sign-in asks. */
export async function googleToken(): Promise<string> {
  if (!CLIENT_ID) throw new Error('Google is not configured for this build (VITE_GOOGLE_CLIENT_ID).')
  if (token && token.expires > Date.now() + 60_000) return token.value
  const gis = await loadGis()
  return new Promise<string>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (r) => {
        if (!r.access_token) return reject(new Error(r.error === 'access_denied' ? 'Google sign-in was cancelled, or this Google account is not allowed to use the app yet.' : r.error_description || r.error || 'Google sign-in was not completed.'))
        token = { value: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 }
        resolve(r.access_token)
      },
      error_callback: (e) => reject(new Error(e.message === 'popup_closed' ? 'The Google sign-in window was closed before it finished.' : 'The Google sign-in window did not open. Allow pop-ups for this site, then try again.')),
    })
    client.requestAccessToken()
  })
}

async function meet<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await googleToken()
  const res = await fetch(`${API}/${path}`, { ...init, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...init?.headers } })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    const msg: string = detail?.error?.message ?? ''
    if (res.status === 401) token = null
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg))
      throw new Error('The Google Meet API is switched off for this Google Cloud project. Turn on “Google Meet REST API” in the Google Cloud console, wait a minute, and try again.')
    if (res.status === 403 && /scope|permission/i.test(msg)) throw new Error('Google did not give permission for Meet. Sign in again and tick every box Google asks about.')
    throw new Error(msg ? `Google Meet: ${msg}` : `Google Meet answered ${res.status}.`)
  }
  return (await res.json()) as T
}

/* ------------------------------------------------------------ the call */

export interface MeetSpace {
  meetingUri: string
  meetingCode: string
}

/**
 * A new Meet space, with Meet's own recording and transcript on from the start. Workspace editions without
 * them refuse that part, so the space is then made plainly and the doctor starts them from Meet's menu.
 */
export async function createMeetSpace(): Promise<MeetSpace & { artifactsOn: boolean }> {
  try {
    const s = await meet<MeetSpace>('spaces', {
      method: 'POST',
      body: JSON.stringify({
        config: {
          accessType: 'TRUSTED',
          artifactConfig: {
            recordingConfig: { autoRecordingGeneration: 'ON' },
            transcriptionConfig: { autoTranscriptionGeneration: 'ON' },
          },
        },
      }),
    })
    return { ...s, artifactsOn: true }
  } catch {
    const s = await meet<MeetSpace>('spaces', { method: 'POST', body: '{}' })
    return { ...s, artifactsOn: false }
  }
}

/* ------------------------------------------------------------ after the call */

interface ConferenceRecord {
  name: string
  startTime: string
  endTime?: string
}
interface Transcript {
  name: string
  state: 'STARTED' | 'ENDED' | 'FILE_GENERATED'
  docsDestination?: { document: string; exportUri: string }
}
interface Recording {
  name: string
  state: 'STARTED' | 'ENDED' | 'FILE_GENERATED'
  driveDestination?: { file: string; exportUri: string }
}
interface Entry {
  participant: string
  text: string
  startTime: string
  endTime: string
}
interface Participant {
  name: string
  signedinUser?: { displayName?: string }
  anonymousUser?: { displayName?: string }
  phoneUser?: { displayName?: string }
}

async function all<T>(path: string, key: string): Promise<T[]> {
  const out: T[] = []
  let page: string | undefined
  do {
    const sep = path.includes('?') ? '&' : '?'
    const r = await meet<Record<string, unknown>>(`${path}${sep}pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)
    out.push(...((r[key] as T[] | undefined) ?? []))
    page = r.nextPageToken as string | undefined
  } while (page)
  return out
}

export interface OfficialFetch {
  entries: OfficialEntry[]
  docUrl?: string
  recordingUrl?: string
  /** Said when Meet has the conference but not (yet) its transcript. */
  pending?: string
}

/**
 * The official transcript of the call on `code` closest to `around` (the session's start), with each
 * speaker's name. Meet writes the transcript some minutes after the call ends, so "not ready yet" is an answer.
 */
export async function fetchOfficialTranscript(code: string, around: number): Promise<OfficialFetch> {
  const records = await all<ConferenceRecord>(`conferenceRecords?filter=${encodeURIComponent(`space.meeting_code = "${code}"`)}`, 'conferenceRecords')
  if (!records.length) throw new Error(`Google Meet has no record of a call on ${code} that this Google account can read. Only the organiser's account can.`)
  const record = records.reduce((best, r) => (Math.abs(Date.parse(r.startTime) - around) < Math.abs(Date.parse(best.startTime) - around) ? r : best))

  const [transcripts, recordings, people] = await Promise.all([
    all<Transcript>(`${record.name}/transcripts`, 'transcripts'),
    all<Recording>(`${record.name}/recordings`, 'recordings').catch(() => [] as Recording[]),
    all<Participant>(`${record.name}/participants`, 'participants').catch(() => [] as Participant[]),
  ])
  const recordingUrl = recordings.find((r) => r.driveDestination)?.driveDestination?.exportUri
  if (!transcripts.length)
    return {
      entries: [],
      recordingUrl,
      pending:
        'Google Meet did not save notes for this call. Free Google accounts never get them; on paid Google Workspace, turn on “Transcripts” from Meet’s Activities menu. The Shri live transcript has the whole conversation.',
    }

  const names = new Map(people.map((p) => [p.name, p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || 'Participant']))
  const entries: OfficialEntry[] = []
  for (const t of transcripts) {
    const raw = await all<Entry>(`${t.name}/entries`, 'transcriptEntries')
    for (const e of raw) entries.push({ speaker: names.get(e.participant) ?? 'Participant', text: e.text, startMs: Date.parse(e.startTime), endMs: Date.parse(e.endTime) })
  }
  entries.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
  const docUrl = transcripts.find((t) => t.docsDestination)?.docsDestination?.exportUri
  const pending = !entries.length && transcripts.some((t) => t.state !== 'FILE_GENERATED') ? 'Meet is still writing the transcript. Try again in a few minutes.' : undefined
  return { entries, docUrl, recordingUrl, pending }
}
