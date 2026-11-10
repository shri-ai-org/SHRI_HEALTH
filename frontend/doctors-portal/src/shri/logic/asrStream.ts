// The doctor's voice through Shri Health's own speech service (backend/ — Tamil and
// English spoken, English written), streamed live: the microphone runs through an
// AudioWorklet (`public/asr-capture-worklet.js`) that sends 16 kHz Int16 frames of
// 250 ms over a WebSocket; the service answers with partials while the doctor
// speaks and a final at each pause, which replaces them.
//
// It returns the same `DictationState` as the browser's recogniser (`useDictation`),
// so every dictation box works with either. One extra phase: `processing`, after
// Stop, while the last utterance is decoded — the box waits for it, so no word is
// lost. A service that cannot be reached is reported once through `onUnreachable`,
// and the owner falls back to the browser's recogniser.
//
// Configured by VITE_ASR_URL (e.g. ws://localhost:8765/ws/transcribe) and, where
// the service wants one, VITE_ASR_TOKEN. A `shri.asrUrl` entry in this device's
// localStorage points a build at a service without rebuilding (the flows use it for
// their mock), and `off` keeps it on the browser's recogniser.
// With neither, every build — dev included — uses the browser's recogniser. No
// speech service runs for now; the one planned (Parrotlet-a 2.0) plugs in here.

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { bandFor } from '@/atlas/confidence'
import { joinSpeech } from '@/data/scribe'

import type { DictationOptions, DictationState, HeardSegment } from './dictation'
import { useVoiceArbiter } from './dictation'
import { NOTICE, mediaErrorNotice } from './speech'

const ASR_TOKEN: string | undefined = import.meta.env.VITE_ASR_TOKEN || undefined

/** The speech service's socket, if this build or this device names one. */
export function asrUrl(): string | undefined {
  try {
    const local = window.localStorage.getItem('shri.asrUrl')
    if (local === 'off') return undefined
    if (local) return local
  } catch {
    /* storage blocked — the build's own setting stands */
  }
  return import.meta.env.VITE_ASR_URL || undefined
}

/** What the dictation box names as the engine — not a model name, which the brief keeps off the screen. */
export const STREAM_MODEL = 'Shri Health speech service'
const STREAM_CONFIDENCE = 0.8

const QUIET_BARS = () => new Array<number>(28).fill(0.06)
/** How long Stop waits for the last final before landing what it has. */
const FLUSH_TIMEOUT_MS = 20_000

type Msg =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; id: number; text: string }
  | { type: 'status'; state: 'processing' | 'listening' }
  | { type: 'error'; message: string }
  | { type: 'done' }

export function useStreamingDictation(opts?: DictationOptions & { onUnreachable?: () => void }): DictationState {
  const ownId = useId()
  const arbiterId = opts?.arbiterId ?? `stream-${ownId}`
  const [phase, setPhase] = useState<DictationState['phase']>('idle')
  const [settled, setSettled] = useState('')
  const [interim, setInterim] = useState('')
  const [segments, setSegments] = useState<HeardSegment[]>([])
  const [bars, setBars] = useState<number[]>(QUIET_BARS)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [supportNotice] = useState<string | null>(() =>
    !window.isSecureContext ? NOTICE.insecure : !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined' ? NOTICE.unsupported : null,
  )

  const text = useRef({ settled: '', interim: '', segments: [] as HeardSegment[] })
  const live = useRef<{ ws: WebSocket | null; ctx: AudioContext | null; stream: MediaStream | null; node: AudioWorkletNode | null }>({ ws: null, ctx: null, stream: null, node: null })
  const run = useRef({ active: false, token: 0, opened: false, startedAt: 0, flush: 0 })
  const optsRef = useRef(opts)
  const stopRef = useRef<() => void>(() => {})
  useEffect(() => {
    optsRef.current = opts
  })

  /** The microphone and the socket, closed on every exit path. */
  const teardown = useCallback((closeSocket: boolean) => {
    const l = live.current
    l.node?.port.close()
    l.node?.disconnect()
    l.stream?.getTracks().forEach((t) => t.stop())
    void l.ctx?.close().catch(() => undefined)
    l.node = null
    l.stream = null
    l.ctx = null
    if (closeSocket) {
      const ws = l.ws
      l.ws = null
      if (ws) {
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        try {
          ws.close()
        } catch {
          /* already closed */
        }
      }
    }
    setBars(QUIET_BARS())
  }, [])

  /** The run's books close once: words still in flight are kept, the arbiter released, the owner told. */
  const endRun = useCallback(
    (endNotice: string | null) => {
      if (!run.current.active) return
      run.current.active = false
      window.clearTimeout(run.current.flush)
      const t = text.current
      if (t.interim.trim()) {
        t.settled = joinSpeech(t.settled, t.interim.trim())
        t.interim = ''
        setSettled(t.settled)
        setInterim('')
      }
      teardown(true)
      useVoiceArbiter.getState().release(arbiterId)
      setPhase(t.settled.trim() ? 'review' : endNotice ? 'unavailable' : 'idle')
      setNotice(endNotice)
      optsRef.current?.onEnd?.({ text: t.settled, model: STREAM_MODEL, confidence: STREAM_CONFIDENCE, scored: false, band: bandFor(STREAM_CONFIDENCE), notice: endNotice })
    },
    [arbiterId, teardown],
  )

  const stop = useCallback(() => {
    if (!run.current.active) return
    const ws = live.current.ws
    // The microphone closes now; the socket stays open until the last final arrives.
    teardown(false)
    setElapsedSec(Math.floor((Date.now() - run.current.startedAt) / 1000))
    if (ws && ws.readyState === WebSocket.OPEN) {
      setPhase('processing')
      ws.send(JSON.stringify({ type: 'stop' }))
      run.current.flush = window.setTimeout(() => endRun(null), FLUSH_TIMEOUT_MS)
    } else endRun(null)
  }, [endRun, teardown])
  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const start = useCallback(
    (o?: { resume?: boolean }) => {
      if (run.current.active) return
      if (!o?.resume) {
        text.current = { settled: '', interim: '', segments: [] }
        setSettled('')
        setSegments([])
        setElapsedSec(0)
      }
      setInterim('')
      setNotice(null)
      run.current = { active: true, token: run.current.token + 1, opened: false, startedAt: Date.now(), flush: 0 }
      const token = run.current.token
      useVoiceArbiter.getState().take(arbiterId, () => stopRef.current())
      const ASR_URL = asrUrl()
      if (supportNotice) return endRun(supportNotice)
      if (!ASR_URL) return endRun(NOTICE.unsupported)
      setPhase('requesting')

      void (async () => {
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        } catch (err) {
          if (token === run.current.token) endRun(mediaErrorNotice(err))
          return
        }
        if (token !== run.current.token || !run.current.active) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        live.current.stream = stream

        const url = ASR_TOKEN ? `${ASR_URL}${ASR_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(ASR_TOKEN)}` : ASR_URL
        const ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'
        live.current.ws = ws

        ws.onerror = () => {
          if (token !== run.current.token) return
          // Never reached at all: the owner falls back to the browser's recogniser.
          if (!run.current.opened) {
            run.current.active = false
            teardown(true)
            useVoiceArbiter.getState().release(arbiterId)
            setPhase('idle')
            optsRef.current?.onUnreachable?.()
          }
        }
        ws.onclose = () => {
          if (token !== run.current.token || !run.current.opened) return
          endRun(run.current.active && live.current.stream ? 'The transcription service closed the connection. What was heard is kept — press the mic to continue.' : null)
        }
        ws.onmessage = (e) => {
          if (token !== run.current.token) return
          const m = JSON.parse(String(e.data)) as Msg
          const t = text.current
          if (m.type === 'partial') {
            t.interim = m.text
            setInterim(m.text)
          } else if (m.type === 'final') {
            t.settled = joinSpeech(t.settled, m.text)
            t.segments = [...t.segments, { text: m.text, atSec: Math.floor((Date.now() - run.current.startedAt) / 1000) }]
            t.interim = ''
            setSettled(t.settled)
            setSegments(t.segments)
            setInterim('')
          } else if (m.type === 'status') {
            if (live.current.stream) setPhase(m.state === 'processing' ? 'processing' : 'recording')
          } else if (m.type === 'error') {
            endRun(`${m.message} What was heard is kept.`)
          } else if (m.type === 'done') {
            endRun(null)
          }
        }
        ws.onopen = async () => {
          if (token !== run.current.token) return
          run.current.opened = true
          ws.send(JSON.stringify({ type: 'start' }))
          try {
            const ctx = new AudioContext()
            await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}asr-capture-worklet.js`)
            const node = new AudioWorkletNode(ctx, 'asr-capture')
            node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(ev.data.pcm)
              setBars((prev) => [...prev.slice(1), Math.max(0.06, Math.min(1, ev.data.peak * 2.2))])
            }
            ctx.createMediaStreamSource(stream).connect(node)
            live.current.ctx = ctx
            live.current.node = node
            setPhase('recording')
          } catch {
            endRun(NOTICE.wouldNotStart)
          }
        }
      })()
    },
    [arbiterId, endRun, supportNotice, teardown],
  )

  const reset = useCallback(() => {
    run.current.token += 1
    window.clearTimeout(run.current.flush)
    teardown(true)
    if (run.current.active) {
      run.current.active = false
      useVoiceArbiter.getState().release(arbiterId)
    }
    text.current = { settled: '', interim: '', segments: [] }
    setPhase('idle')
    setSettled('')
    setInterim('')
    setSegments([])
    setNotice(null)
    setElapsedSec(0)
  }, [arbiterId, teardown])

  useEffect(() => () => reset(), [reset])

  useEffect(() => {
    if (phase !== 'recording') return
    const t = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - run.current.startedAt) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [phase])

  return {
    phase,
    settled,
    interim,
    segments,
    bars,
    model: STREAM_MODEL,
    confidence: STREAM_CONFIDENCE,
    scored: false,
    band: bandFor(STREAM_CONFIDENCE),
    notice,
    supportNotice,
    elapsedSec,
    start,
    stop,
    reset,
  }
}
