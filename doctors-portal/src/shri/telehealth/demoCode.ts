// The demonstration's pairing code: four digits, one per browser, new whenever
// any tab of the doctor's portal is loaded — that tab makes it and tells the
// others (BroadcastChannel), so every tab of one browser shows the same code and
// watches the same rooms. A visit's video room is the visit and this code
// (visits.roomOfVisit), so each person demonstrating, and each reload, has rooms
// of its own. The patient demo page hears it (CodeBeacon) or has it typed. The
// backend will give each visit its own private room instead.

import { create } from 'zustand'

const KEY = 'shri.demoCode'

interface DemoCode {
  code: string | null
  /** When it was made. */
  madeAt: number
}

/** This browser's current code — every tab's, kept in step. */
export const useDemoCode = create<DemoCode>(() => ({ code: null, madeAt: 0 }))

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('shri-demo') : null
channel?.addEventListener('message', (e: MessageEvent<DemoCode>) => {
  const d = e.data
  if (d && typeof d.code === 'string' && /^\d{4}$/.test(d.code)) useDemoCode.setState({ code: d.code, madeAt: d.madeAt })
})

/**
 * Where doctors' portals say their current code, on the hospital's Jitsi, and
 * patient demo pages listen (CodeBeacon, PatientDemoPage) — so a patient on
 * another device sees the code without typing it from the doctor's screen.
 */
export const DIRECTORY_ROOM = 'ShriHealth-demo-directory'

/** This browser's code: made by the first call of this load, and given to its other tabs. */
export function demoCode(): string {
  const now = useDemoCode.getState()
  if (now.code) return now.code
  const b = new Uint16Array(1)
  crypto.getRandomValues(b)
  const made: DemoCode = { code: String(1000 + (b[0] % 9000)), madeAt: Date.now() }
  useDemoCode.setState(made)
  try {
    localStorage.setItem(KEY, made.code!)
  } catch {
    /* storage blocked: the code is still shown */
  }
  channel?.postMessage(made)
  return made.code!
}

/** When this browser's code was made. */
export const demoCodeMadeAt = () => (demoCode(), useDemoCode.getState().madeAt)

/** For the patient demo page: the code a doctor's page in this browser last made, if any. */
export function lastDemoCode(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}
