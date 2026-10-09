// The data line of a video call: small messages between the doctor's page and the
// patient's, through Jitsi itself (its endpoint text messages, which reach the
// other side whether the two connect directly or through the bridge). JitsiRoom
// opens a line for its room once it has joined; anyone may listen.
//
//   transcribe  doctor → patient   start or stop writing down the patient's words
//   line        patient → doctor   one line the patient said, as their browser heard it
//   rx          doctor → patient   the signed tele-prescription, after the call
//   rx-ack      patient → doctor   it arrived
//
// The patient portal will speak the same messages; until then its stand-in does
// (PatientDemoPage).

export interface SentRx {
  id: string
  doctor: string
  patient: string
  signedAt: number
  mode: 'video' | 'telephone'
  items: string[]
}

export type CallMsg =
  | { k: 'transcribe'; on: boolean }
  | { k: 'line'; id: string; text: string; startMs: number; endMs: number }
  | { k: 'rx'; rx: SentRx }
  | { k: 'rx-ack'; id: string }

type Send = (m: CallMsg) => void
type Listener = (m: CallMsg, room: string, from?: string) => void

const lines = new Map<string, Send>()
const listeners = new Set<Listener>()

export const callLink = {
  /** JitsiRoom, once joined: messages for this room go out through it. */
  open(room: string, send: Send) {
    lines.set(room, send)
  },
  close(room: string, send: Send) {
    if (lines.get(room) === send) lines.delete(room)
  },
  has: (room: string) => lines.has(room),
  /** False where this page is not in that room's call. */
  send(room: string, m: CallMsg): boolean {
    const s = lines.get(room)
    if (!s) return false
    s(m)
    return true
  },
  on(fn: Listener) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
  /** JitsiRoom, for each text message that arrives: ours are JSON with t: 'shri'. */
  receive(room: string, text: unknown, from?: string) {
    if (typeof text !== 'string') return
    let m: (CallMsg & { t?: string }) | null = null
    try {
      m = JSON.parse(text) as CallMsg & { t?: string }
    } catch {
      return
    }
    if (!m || m.t !== 'shri') return
    for (const fn of listeners) fn(m, room, from)
  },
}

export const wire = (m: CallMsg) => JSON.stringify({ t: 'shri', ...m })
