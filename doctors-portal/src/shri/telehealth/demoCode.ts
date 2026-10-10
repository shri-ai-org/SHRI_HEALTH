// The demonstration's pairing code: four digits, new on every load of the doctor's
// portal. A visit's video room is the visit and this code (visits.roomOfVisit), so
// each person demonstrating, and each reload, has rooms of its own — nobody walks
// into someone else's earlier test. The patient demo page asks for the code; in
// the same browser it finds it already filled in. The backend will give each
// visit its own private room instead.

const KEY = 'shri.demoCode'
let code: string | null = null
let madeAt = 0

/**
 * Where doctors' portals say their current code, on the hospital's Jitsi, and
 * patient demo pages listen (CodeBeacon, PatientDemoPage) — so a patient on
 * another device sees the code without typing it from the doctor's screen.
 */
export const DIRECTORY_ROOM = 'ShriHealth-demo-directory'

/** When this load's code was made. */
export const demoCodeMadeAt = () => (demoCode(), madeAt)

/** This doctor's page's code — made once per load, and left where a patient window in this browser can find it. */
export function demoCode(): string {
  if (code) return code
  const b = new Uint16Array(1)
  crypto.getRandomValues(b)
  code = String(1000 + (b[0] % 9000))
  madeAt = Date.now()
  try {
    localStorage.setItem(KEY, code)
  } catch {
    /* storage blocked: the code is still shown */
  }
  return code
}

/** For the patient demo page: the code a doctor's page in this browser last made, if any. */
export function lastDemoCode(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}
