// The browser's own speech-to-text, kept listening for a whole call: the doctor's
// side on the visit page (capture.ts) and the patient's on their portal page
// (PatientDemoPage). Chrome ends a recognition after every quiet spell and about
// once a minute; it is started again at once — however long the quiet — and given
// up on only when it keeps failing the moment it starts (blocked, no microphone,
// no service). Words heard but not yet settled when it ends are kept as a line,
// never dropped. Where Chrome can recognise on this device (processLocally) it
// does, which is faster than its cloud service. It can
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
  // On this device where Chrome offers it: no network round trip. Takes effect from the next start.
  const S = Ctor as unknown as { available?: (q: { langs: string[]; processLocally: boolean }) => Promise<string> }
  S.available?.({ langs: [o.lang], processLocally: true })
    .then((a) => {
      if (a === 'available') (rec as unknown as { processLocally?: boolean }).processLocally = true
    })
    .catch(() => undefined)

  let active = true
  let paused = false
  let startedAt = 0
  let heard = false
  let quick = 0
  let utterStart: number | null = null
  /** Words heard and not yet settled — kept as a line if the recognition ends first. */
  let pending = ''
  const flush = () => {
    const t = pending.trim()
    pending = ''
    if (t) o.onFinal(t, utterStart ?? Date.now() - 3000, Date.now())
    utterStart = null
  }

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
    pending = interim
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
    flush()
    o.onInterim?.('')
    if (!active || paused) return
    quick = !heard && Date.now() - startedAt < QUICK_MS ? quick + 1 : 0
    if (quick >= GIVE_UP_AFTER) {
      active = false
      return o.onFail('Speech-to-text keeps failing to start in this browser.')
    }
    // At once after a normal end — every moment between two recognitions is words lost.
    if (quick === 0) go()
    else window.setTimeout(go, quick * 250)
  }

  go()
  return {
    stop() {
      active = false
      flush()
      try {
        rec.abort()
      } catch {
        /* not listening */
      }
    },
    pause() {
      if (!active || paused) return
      paused = true
      flush()
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
