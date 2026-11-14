// ported from src/components/dictation.tsx:57-104 (the Web Speech surface),
// 155-190 (`useVoiceArbiter`) and 192-600 (`useDictation`): the clinician's own
// voice, turned into editable text, by the browser's real recogniser and only
// by it.
//
// The permission prompt is the browser's: `getUserMedia` raises it and feeds
// the level meter, and the recogniser reuses the grant. A refusal, a missing
// microphone and an insecure page each get their own sentence (`./speech`).
// Chrome ends a session on its own after silence and again at about a minute;
// the clinician did not press Stop, so the session restarts in place, rate
// limited so a recogniser that keeps dying cannot spin. Whatever was heard is
// kept on every exit path.
//
// ONE MICROPHONE AT A TIME: every recorder goes through `useVoiceArbiter`, so
// starting one stops whichever other one is listening (its words land where
// they were going) and no word lands in the wrong section.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { create } from 'zustand'

import { bandFor, type ConfidenceBand } from '@/atlas/confidence'
import type { LanguageCode } from '@/data/kit'
import { LANGUAGES } from '@/data/kit'
import { joinSpeech } from '@/data/scribe'
import { useSession } from '@/store/session'
import type { ExplainTarget } from '@/store/ui'

import { BCP47, NOTICE, UNSCORED_CONFIDENCE, languageNotice, mediaErrorNotice, speechModel } from './speech'

/* ------------------------------------------------ the Web Speech surface */

/** `lib.dom` still does not ship these, so the surface used is declared here. */
interface SRAlternative {
  transcript: string
  confidence: number
}
interface SRResult {
  readonly length: number
  readonly isFinal: boolean
  [index: number]: SRAlternative
}
interface SRResultList {
  readonly length: number
  [index: number]: SRResult
}
interface SREvent {
  resultIndex: number
  results: SRResultList
}
interface SRErrorEvent {
  error: string
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SREvent) => void) | null
  onerror: ((e: SRErrorEvent) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/* ------------------------------------------------ one microphone at a time */

/**
 * `take` stops whoever is listening before the next one starts — their words
 * land where they were going — and fields render their mic as busy while
 * another is live.
 */
export const useVoiceArbiter = create<{
  activeId: string | null
  take: (id: string, stop: () => void) => void
  release: (id: string) => void
}>()((set, get) => {
  /** The live recorder's Stop, held outside state so taking the mic never re-renders anyone. */
  let stopActive: (() => void) | null = null
  return {
    activeId: null,
    take: (id, stop) => {
      const current = get().activeId
      if (current !== null && current !== id) {
        const previous = stopActive
        stopActive = null
        previous?.()
      }
      stopActive = stop
      set({ activeId: id })
    },
    release: (id) => {
      if (get().activeId !== id) return
      stopActive = null
      set({ activeId: null })
    },
  }
})

/* ------------------------------------------------------------------ hook */

/** `processing` — after Stop, while a streaming engine settles its last words (`asrStream.ts`); the browser's recogniser never enters it. */
export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'processing' | 'review' | 'unavailable'

/** One final result from the recogniser — roughly, one utterance between pauses. */
export interface HeardSegment {
  text: string
  /** Seconds into the session when it settled. */
  atSec: number
}

/** What a finished run hands its owner. */
export interface DictationRun {
  text: string
  model: string
  confidence: number
  /** False where the recogniser reported no score — the band is then MED, never a number. */
  scored: boolean
  band: ConfidenceBand
  notice: string | null
}

export interface DictationState {
  phase: DictationPhase
  /** Final results, joined. */
  settled: string
  /** The words still in flight. */
  interim: string
  segments: HeardSegment[]
  /** 0…1 levels off the microphone, newest last. */
  bars: number[]
  model: string
  confidence: number
  scored: boolean
  band: ConfidenceBand
  /** Why recognition could not run or stopped, in words the clinician can act on. */
  notice: string | null
  /**
   * Set before anything is pressed where this browser cannot listen at all —
   * an insecure page, or no recogniser (Firefox). Brave is only found out on
   * the first attempt, because it ships the constructor and blocks the service.
   */
  supportNotice: string | null
  elapsedSec: number
  /** `resume` keeps what was heard and the clock. */
  start: (opts?: { resume?: boolean }) => void
  stop: () => void
  /** Discards everything and returns to idle. `onEnd` is not called. */
  reset: () => void
}

export interface DictationOptions {
  /** The id this recorder holds the microphone under. Defaults to one per hook. */
  arbiterId?: string
  /** Fires exactly once per `start()`, when that run ends — Stop, a failure, or the microphone never opening. Not called by `reset`. */
  onEnd?: (run: DictationRun) => void
}

/**
 * Chrome ends a session on its own (silence, about a minute, a dropped connection). The run
 * keeps listening until Stop: each end opens a fresh recogniser, at once the first time and
 * then with a growing pause while ends come fast, so a recogniser that keeps dying never spins.
 */
export const RESTART_WINDOW_MS = 10_000
export const MAX_RESTART_DELAY_MS = 3_000
export function restartDelay(recentRestarts: number): number {
  return recentRestarts === 0 ? 0 : Math.min(250 * 2 ** (recentRestarts - 1), MAX_RESTART_DELAY_MS)
}
/** 'network' errors in a row with nothing heard before the service counts as unreachable (Brave blocks it). */
export const MAX_NETWORK_ERRORS = 5
/** A safety cap per run: the microphone closes after 15 minutes of listening, keeping every word. */
export const MAX_RUN_SEC = 15 * 60
export const CAP_NOTICE = 'Stopped after 15 minutes of listening. Everything heard is kept — press the mic to continue.'
const QUIET_BARS = () => new Array<number>(28).fill(0.06)

/** Seconds recorded so far: what earlier runs banked, plus the run in progress. */
function secondsOf(c: { base: number; since: number | null }): number {
  return Math.floor(c.base + (c.since === null ? 0 : (Date.now() - c.since) / 1000))
}

/**
 * One recorder. Its owner mounts it only while its surface is open, so
 * unmounting — closing the surface — discards the session and closes the
 * microphone (the old hook's `open` flag did the same for surfaces that stayed
 * mounted when closed).
 */
export function useDictation(opts?: DictationOptions): DictationState {
  const language = useSession((s) => s.language)
  const ownId = useId()
  const arbiterId = opts?.arbiterId ?? `dictation-${ownId}`

  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [settled, setSettled] = useState('')
  const [interim, setInterim] = useState('')
  const [segments, setSegments] = useState<HeardSegment[]>([])
  const [bars, setBars] = useState<number[]>(QUIET_BARS)
  const [notice, setNotice] = useState<string | null>(null)
  const [confidence, setConfidence] = useState(UNSCORED_CONFIDENCE)
  const [scored, setScored] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [supportNotice] = useState<string | null>(() =>
    !window.isSecureContext ? NOTICE.insecure : !recognitionCtor() || !navigator.mediaDevices?.getUserMedia ? NOTICE.unsupported : null,
  )

  // The truth lives in refs, so event handlers never read a stale render.
  const text = useRef({ settled: '', interim: '', segments: [] as HeardSegment[] })
  const score = useRef({ confidence: UNSCORED_CONFIDENCE, scored: false })
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const audio = useRef<{ ctx: AudioContext | null; stream: MediaStream; raf: number } | null>(null)
  /** Final results already taken from the current recogniser session — a restart begins a new list. */
  const consumed = useRef(0)
  const clock = useRef<{ base: number; since: number | null }>({ base: 0, since: null })
  const run = useRef({ active: false, token: 0, stopping: false, restarts: [] as number[], networkErrors: 0 })
  /** The pending restart and the run's 15-minute cap, both cleared on every exit path. */
  const timers = useRef<{ restart: number | null; cap: number | null }>({ restart: null, cap: null })
  const optsRef = useRef(opts)
  const languageRef = useRef<LanguageCode>(language)
  const stopRef = useRef<() => void>(() => {})

  useEffect(() => {
    optsRef.current = opts
    languageRef.current = language
  })

  /** Everything a run opened is closed here, on every exit path. */
  const teardown = useCallback(() => {
    for (const t of [timers.current.restart, timers.current.cap]) if (t !== null) window.clearTimeout(t)
    timers.current = { restart: null, cap: null }
    const rec = recognition.current
    recognition.current = null
    if (rec) {
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      try {
        rec.abort()
      } catch {
        /* already ended */
      }
    }
    if (audio.current) {
      window.cancelAnimationFrame(audio.current.raf)
      audio.current.stream.getTracks().forEach((t) => t.stop())
      void audio.current.ctx?.close().catch(() => undefined)
      audio.current = null
    }
    const c = clock.current
    if (c.since !== null) {
      c.base += (Date.now() - c.since) / 1000
      c.since = null
    }
    // The trace settles when the microphone closes.
    setBars(QUIET_BARS())
  }, [])

  /** Words still in flight when a run ends are kept as heard, never dropped. */
  const promoteInterim = useCallback(() => {
    const t = text.current
    const pending = t.interim.trim()
    if (pending === '') return
    t.settled = joinSpeech(t.settled, pending)
    t.segments = [...t.segments, { text: pending, atSec: secondsOf(clock.current) }]
    t.interim = ''
    setSettled(t.settled)
    setSegments(t.segments)
    setInterim('')
  }, [])

  /** Closes the run's books: the arbiter is released and the owner told, once. */
  const endRun = useCallback(
    (endNotice: string | null) => {
      if (!run.current.active) return
      run.current.active = false
      useVoiceArbiter.getState().release(arbiterId)
      const s = score.current
      const conf = s.scored ? s.confidence : UNSCORED_CONFIDENCE
      optsRef.current?.onEnd?.({
        text: text.current.settled,
        model: speechModel(languageRef.current),
        confidence: conf,
        scored: s.scored,
        band: bandFor(conf),
        notice: endNotice,
      })
    },
    [arbiterId],
  )

  /** A real failure: keep what was heard, say why, stop listening. */
  const fail = useCallback(
    (why: string) => {
      run.current.stopping = true
      run.current.token += 1
      promoteInterim()
      teardown()
      setNotice(why)
      setPhase(text.current.settled.trim() !== '' ? 'review' : 'unavailable')
      endRun(why)
    },
    [endRun, promoteInterim, teardown],
  )

  const stop = useCallback(() => {
    if (!run.current.active) return
    const wasRequesting = recognition.current === null
    run.current.stopping = true
    run.current.token += 1
    promoteInterim()
    teardown()
    setElapsedSec(secondsOf(clock.current))
    setPhase(wasRequesting && text.current.settled.trim() === '' ? 'idle' : 'review')
    endRun(null)
  }, [endRun, promoteInterim, teardown])
  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  /** A real level meter off the microphone the browser just granted. */
  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 128
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        // Peak deviation from the 128 midpoint, as a 0…1 amplitude.
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
        setBars((prev) => [...prev.slice(1), Math.max(0.06, Math.min(1, peak * 2.2))])
        if (audio.current) audio.current.raf = window.requestAnimationFrame(tick)
      }
      audio.current = { ctx, stream, raf: window.requestAnimationFrame(tick) }
    } catch {
      // No meter is not a reason to stop listening — the words still come.
      audio.current = { ctx: null, stream, raf: 0 }
    }
  }, [])

  const start = useCallback(
    (o?: { resume?: boolean }) => {
      if (run.current.active) return
      const resume = o?.resume === true
      if (!resume) {
        text.current = { settled: '', interim: '', segments: [] }
        score.current = { confidence: UNSCORED_CONFIDENCE, scored: false }
        clock.current = { base: 0, since: null }
        setSettled('')
        setSegments([])
        setConfidence(UNSCORED_CONFIDENCE)
        setScored(false)
        setElapsedSec(0)
      }
      setInterim('')
      setNotice(null)
      run.current = { active: true, token: run.current.token + 1, stopping: false, restarts: [], networkErrors: 0 }
      const token = run.current.token
      useVoiceArbiter.getState().take(arbiterId, () => stopRef.current())

      if (!window.isSecureContext) return fail(NOTICE.insecure)
      const Ctor = recognitionCtor()
      if (!Ctor) return fail(NOTICE.unsupported)
      if (!navigator.mediaDevices?.getUserMedia) return fail(NOTICE.unsupported)
      const live = () => token === run.current.token && !run.current.stopping

      /** Stops at the cap like Stop, keeping every word, and says why. */
      const capReached = () => {
        if (!live()) return
        stopRef.current()
        setNotice(CAP_NOTICE)
      }

      /**
       * One recogniser session. Every restart gets a fresh recogniser: Chrome may refuse to
       * start one that just ended with an error. The run's words live in `text`, so nothing
       * heard before is lost, and a final result is taken once per session (`consumed`).
       */
      const listen = (first: boolean) => {
        const rec = new Ctor()
        rec.lang = BCP47[languageRef.current]
        rec.continuous = true
        rec.interimResults = true
        rec.maxAlternatives = 1

        rec.onresult = (e) => {
          if (recognition.current !== rec) return
          const t = text.current
          let pending = ''
          let best = 0
          const fresh: HeardSegment[] = []
          for (let i = e.resultIndex; i < e.results.length; i += 1) {
            const r = e.results[i]
            const alt = r[0]
            if (!alt) continue
            if (r.isFinal) {
              // A final result is taken once, however many events repeat it.
              if (i < consumed.current) continue
              consumed.current = i + 1
              const phrase = alt.transcript.trim()
              if (phrase !== '') fresh.push({ text: phrase, atSec: secondsOf(clock.current) })
              best = Math.max(best, alt.confidence || 0)
            } else {
              pending = joinSpeech(pending, alt.transcript)
            }
          }
          if (fresh.length > 0 || pending !== '') run.current.networkErrors = 0
          if (fresh.length > 0) {
            t.settled = fresh.reduce((acc, s) => joinSpeech(acc, s.text), t.settled)
            t.segments = [...t.segments, ...fresh]
            setSettled(t.settled)
            setSegments(t.segments)
            if (best > 0) {
              score.current = { confidence: best, scored: true }
              setConfidence(best)
              setScored(true)
            }
          }
          t.interim = pending
          setInterim(pending)
        }

        rec.onerror = (e) => {
          if (recognition.current !== rec) return
          // Only these stop the run; anything else (silence, Chrome's own boundary, a dropped
          // connection) ends the session, and `onend` opens the next one.
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') return fail(NOTICE.blocked)
          if (e.error === 'audio-capture') return fail(NOTICE.noMic)
          if (e.error === 'language-not-supported') return fail(languageNotice(languageRef.current))
          if (e.error === 'network') {
            run.current.networkErrors += 1
            // The service never answers (Brave and some privacy settings block it): say so once.
            if (run.current.networkErrors >= MAX_NETWORK_ERRORS) fail(NOTICE.network)
          }
        }

        rec.onend = () => {
          if (recognition.current !== rec || !live()) return
          // Chrome ended the session itself: keep the words in flight, then listen again.
          promoteInterim()
          const now = Date.now()
          const recent = run.current.restarts.filter((at) => now - at < RESTART_WINDOW_MS)
          run.current.restarts = [...recent, now]
          timers.current.restart = window.setTimeout(() => {
            timers.current.restart = null
            if (live()) listen(false)
          }, restartDelay(recent.length))
        }

        recognition.current = rec
        consumed.current = 0
        try {
          rec.start()
        } catch {
          if (first) {
            fail(NOTICE.wouldNotStart)
            return false
          }
          // A restart that would not start is tried again after the next pause.
          const recent = run.current.restarts.filter((at) => Date.now() - at < RESTART_WINDOW_MS)
          run.current.restarts = [...recent, Date.now()]
          timers.current.restart = window.setTimeout(() => {
            timers.current.restart = null
            if (live()) listen(false)
          }, restartDelay(recent.length + 1))
        }
        return true
      }

      setPhase('requesting')
      void (async () => {
        let stream: MediaStream
        try {
          // This is the call that raises the browser's permission prompt.
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (err) {
          if (token === run.current.token) fail(mediaErrorNotice(err))
          return
        }
        // Stopped or closed while the prompt was up.
        if (!live()) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        startMeter(stream)
        if (!listen(true)) return
        clock.current.since = Date.now()
        // The cap counts this run's listening; a resumed run starts its own 15 minutes.
        timers.current.cap = window.setTimeout(capReached, MAX_RUN_SEC * 1000)
        setPhase('recording')
      })()
    },
    [arbiterId, fail, promoteInterim, startMeter],
  )

  const reset = useCallback(() => {
    run.current.stopping = true
    run.current.token += 1
    teardown()
    if (run.current.active) {
      run.current.active = false
      useVoiceArbiter.getState().release(arbiterId)
    }
    text.current = { settled: '', interim: '', segments: [] }
    score.current = { confidence: UNSCORED_CONFIDENCE, scored: false }
    clock.current = { base: 0, since: null }
    setPhase('idle')
    setSettled('')
    setInterim('')
    setSegments([])
    setNotice(null)
    setConfidence(UNSCORED_CONFIDENCE)
    setScored(false)
    setElapsedSec(0)
  }, [arbiterId, teardown])

  // Unmounting the surface discards the session and closes the microphone.
  useEffect(() => () => reset(), [reset])

  /** A real clock, so a short recording is visibly short and a paused one does not count on. */
  useEffect(() => {
    if (phase !== 'recording') return
    const t = window.setInterval(() => setElapsedSec(secondsOf(clock.current)), 500)
    return () => window.clearInterval(t)
  }, [phase])

  const conf = scored ? confidence : UNSCORED_CONFIDENCE
  return {
    phase,
    settled,
    interim,
    segments,
    bars,
    model: speechModel(language),
    confidence: conf,
    scored,
    band: bandFor(conf),
    notice,
    supportNotice,
    elapsedSec,
    start,
    stop,
    reset,
  }
}

/* ---------------------------------------------------------------- the Why */

/**
 * AI-101's Why for a transcription — the old build's target, word for word.
 * A note that is saved says "before saving"; a form that is signed says
 * "before signing" (`dictation.tsx:870-893`, `voicefield.tsx:317-341`).
 */
export function dictationWhy(args: {
  touchpointId: string
  model: string
  band: ConfidenceBand
  confidence: number
  language: LanguageCode
  commits: 'save' | 'sign'
}): ExplainTarget {
  const langLabel = LANGUAGES.find((l) => l.code === args.language)?.label
  return {
    touchpointId: args.touchpointId,
    capabilityId: 'AI-101',
    claim: 'This text is a transcription of what was said, not a clinical assessment of it.',
    confidence: args.confidence,
    band: args.band,
    computedAt: 'just now',
    inputs: [
      { label: 'Microphone audio, this session', source: args.model },
      { label: 'Recognition language', source: args.commits === 'sign' ? `${BCP47[args.language]} · ${langLabel}` : BCP47[args.language] },
    ],
    evidence: [
      'Words are transcribed as the browser’s recogniser heard them; it may add little or no punctuation.',
      'No clinical content is inferred, checked or corrected.',
    ],
    model: args.model,
    limits: [
      'A transcription confidence is not a statement about whether the content is correct.',
      args.commits === 'sign'
        ? 'Accuracy falls with background noise, accent and unfamiliar drug names — read it before signing.'
        : 'Accuracy falls with background noise, accent and unfamiliar drug names — read it before saving.',
      args.commits === 'sign' ? 'Nothing is written to the legal record until the note is signed.' : 'Nothing is written to the record until Save is pressed.',
    ],
  }
}
