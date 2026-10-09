// The video call, inside Shri Health: Jitsi Meet, embedded with its IFrame API
// (https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe). No Google
// account, no link to make or paste — every visit gets its own private room,
// named here, and the call opens in the visit page itself.
//
// Which Jitsi server: `shri.jitsiDomain` in this device's localStorage, else
// VITE_JITSI_DOMAIN, else the hospital's own, meet.shri-ai.org (open source Jitsi
// in Docker on the shri-ai.org server, set up from its ~/setup scripts): no
// sign-in, no lobby, every call on the hospital's server, and it can say who is in
// a visit's room (roomWatch.ts). The public meet.jit.si can still be named for a
// look — the automated tests do, so they never touch the real server — but it
// makes the first person in a room sign in, in a separate window.

const DEFAULT_DOMAIN = 'meet.shri-ai.org'
const PUBLIC_DOMAIN = 'meet.jit.si'

export function jitsiDomain(): string {
  try {
    const local = window.localStorage.getItem('shri.jitsiDomain')
    if (local) return local
  } catch {
    /* storage blocked — the build's own setting stands */
  }
  return import.meta.env.VITE_JITSI_DOMAIN || DEFAULT_DOMAIN
}

export const isPublicJitsi = () => jitsiDomain() === PUBLIC_DOMAIN

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A room no one can guess: the visit, and 12 random letters and digits (about 71 bits). */
export function newRoomName(visitId: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const rand = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
  return `ShriHealth-${visitId.replace(/[^A-Za-z0-9]/g, '')}-${rand}`
}

export const roomUrl = (room: string) => `https://${jitsiDomain()}/${room}`

/** The part of JitsiMeetExternalAPI this page uses. */
export interface JitsiApi {
  addListener(event: string, fn: (e: { id?: string; displayName?: string; muted?: boolean }) => void): void
  executeCommand(command: string, ...args: unknown[]): void
  getIFrame(): HTMLIFrameElement
  dispose(): void
}
type JitsiCtor = new (domain: string, options: Record<string, unknown>) => JitsiApi

declare global {
  interface Window {
    JitsiMeetExternalAPI?: JitsiCtor
  }
}

let loading: Promise<JitsiCtor> | null = null

/** Jitsi's own script, from the Jitsi server, once per page. A page that already has it (a test's stand-in) uses that. */
export function loadJitsi(): Promise<JitsiCtor> {
  if (window.JitsiMeetExternalAPI) return Promise.resolve(window.JitsiMeetExternalAPI)
  if (!loading) {
    loading = new Promise<JitsiCtor>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = `https://${jitsiDomain()}/external_api.js`
      s.async = true
      s.onload = () => (window.JitsiMeetExternalAPI ? resolve(window.JitsiMeetExternalAPI) : reject(new Error('The video service did not load.')))
      s.onerror = () => {
        loading = null
        reject(new Error('The video service could not be reached.'))
      }
      document.head.appendChild(s)
    })
  }
  return loading
}
