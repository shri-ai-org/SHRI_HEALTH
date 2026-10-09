// Telling the doctor a patient has come into their video call, beyond the floating
// alert (WaitingBar): a soft two-note chime, and — where Shri Health is not the
// window in front — a notice on this computer (the browser's Notification API,
// asked for once). Clicking the notice brings Shri Health forward and joins the
// call. A notice from the server while no Shri Health tab is open (Web Push) needs
// the backend; this works while Shri Health is open, in the front or not.

import { useEffect } from 'react'

import { patient } from '@/data/kit'

import { visitById } from './visits'
import { waitingList, useWaiting, type Waiting } from './waitingRoom'

export const alertsSupported = () => typeof window !== 'undefined' && 'Notification' in window

/** Whether this computer has been asked already (or cannot be). */
export const alertsAsked = () => !alertsSupported() || Notification.permission !== 'default'

export async function askForAlerts(): Promise<NotificationPermission | 'unsupported'> {
  if (!alertsSupported()) return 'unsupported'
  return Notification.requestPermission()
}

/** Two soft notes. Silent where the browser has not yet let the page play sound. */
function chime() {
  try {
    const ctx = new AudioContext()
    if (ctx.state !== 'running') return void ctx.close()
    ;[660, 880].forEach((hz, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      const at = ctx.currentTime + i * 0.22
      o.frequency.value = hz
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.18, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5)
      o.connect(g).connect(ctx.destination)
      o.start(at)
      o.stop(at + 0.55)
    })
    window.setTimeout(() => void ctx.close(), 1200)
  } catch {
    /* no sound here */
  }
}

const keyOf = (w: Waiting) => `${w.visitId}@${w.since}`

/** Each new arrival in a video call: the chime, and a notice on this computer where Shri Health is behind other windows. */
export function useWaitingAlerts(onJoin: (visitId: string) => void) {
  useEffect(() => {
    // Who was already waiting when the page opened is shown, not announced again.
    let seen = new Set(waitingList(useWaiting.getState().waiting).map(keyOf))
    return useWaiting.subscribe((s) => {
      const now = waitingList(s.waiting)
      for (const w of now) {
        if (seen.has(keyOf(w))) continue
        chime()
        if (alertsSupported() && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
          const p = patient(w.patientId)
          const reason = visitById(w.visitId)?.reason
          const n = new Notification(`${p.name} is waiting in the video call`, {
            body: `${reason ? `The visit is for ${reason.charAt(0).toLowerCase()}${reason.slice(1)}. ` : ''}Click to connect.`,
            tag: `shri-waiting-${w.visitId}`,
            requireInteraction: true,
          })
          n.onclick = () => {
            window.focus()
            onJoin(w.visitId)
            n.close()
          }
        }
      }
      seen = new Set(now.map(keyOf))
    })
  }, [onJoin])
}
