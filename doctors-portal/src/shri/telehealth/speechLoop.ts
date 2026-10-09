// The browser's own speech-to-text, kept listening for a whole call: the doctor's
// side on the visit page (capture.ts) and the patient's on their portal page
// (PatientDemoPage). Chrome ends a recognition after every quiet spell; it is
// simply started again — however long the quiet — and given up on only when it
// keeps failing the moment it starts (blocked, no microphone, no service). It can
// be paused and resumed: one microphone serves one recogniser at a time, so the
// call's transcript steps aside while the doctor dictates notes.

interface SR {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

export interface SpeechLoop {
  stop: () => void
  pause: () => void
  resume: () => void
}

const FATAL: Record<string, string> = {
  'not-allowed': 'Speech-to-text was blocked by the browser.',
  'service-not-allowed': 'Speech-to-text was blocked by the browser.',
  network: 'This browser cannot reach its speech-to-text service (Brave blocks it). Use Google Chrome or Microsoft Edge.',
  'audio-capture': 'Speech-to-text could not use the microphone.',
  'language-not-supported': 'This browser’s speech-to-text does not support this language.',
}

/** Starts that end this soon, with nothing heard, count as failing to start. */
const QUICK_MS = 1500
const GIVE_UP_AFTER = 6

export const speechSupported = () => {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; brave?: unknown }
  return !(navigator as Navigator & { brave?: unknown }).brave && Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition)
}

/** Listens until stopped. Null where this browser cannot. */
export function speechLoop(o: {
  lang: string
  onFinal: (text: string, startMs: number, endMs: number) => void
  onInterim?: (text: string) => void
  onFail: (why: string) => void
}): SpeechLoop | null {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  const rec = new Ctor()
  rec.lang = o.lang
  rec.continuous = true
  rec.interimResults = true

  let active = true
  let paused = false
  let startedAt = 0
  let heard = false
  let quick = 0
  let utterStart: number | null = null

  const go = () => {
    if (!active || paused) return
    startedAt = Date.now()
    heard = false
    try {
      rec.start()
    } catch {
      /* already listening */
    }
  }

  rec.onresult = (e) => {
    heard = true
    quick = 0
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i]
      if (r.isFinal) {
        const t = r[0].transcript.trim()
        if (t) o.onFinal(t, utterStart ?? Date.now() - 3000, Date.now())
        utterStart = null
      } else {
        utterStart ??= Date.now()
        interim += r[0].transcript
      }
    }
    o.onInterim?.(interim)
  }
  rec.onerror = (e) => {
    // A quiet spell (no-speech) or our own pause (aborted) is not a failure.
    const why = FATAL[e.error]
    if (!why) return
    active = false
    o.onFail(why)
  }
  rec.onend = () => {
    o.onInterim?.('')
    if (!active || paused) return
    quick = !heard && Date.now() - startedAt < QUICK_MS ? quick + 1 : 0
    if (quick >= GIVE_UP_AFTER) {
      active = false
      return o.onFail('Speech-to-text keeps failing to start in this browser.')
    }
    window.setTimeout(go, 250 + quick * 250)
  }

  go()
  return {
    stop() {
      active = false
      try {
        rec.abort()
      } catch {
        /* not listening */
      }
    },
    pause() {
      if (!active || paused) return
      paused = true
      try {
        rec.abort()
      } catch {
        /* not listening */
      }
    },
    resume() {
      if (!active || !paused) return
      paused = false
      quick = 0
      go()
    },
  }
}
