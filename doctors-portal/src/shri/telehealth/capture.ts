// The teleconsult's own record of itself, while the visit page's Jitsi room
// carries the call:
//
//   · The recording. The doctor allows this tab to be shared, with its sound, once
//     (Chrome asks; nothing is picked). What is recorded is the video room — the
//     tab's picture cropped to it where the browser can — the patient's voice,
//     which plays in this tab, and the doctor's microphone, mixed. It goes to
//     IndexedDB every few seconds (recordingStore.ts) and downloads as one .webm.
//   · The live transcript. Two channels to Shri Health's speech service (backend/),
//     each its own socket: the doctor's microphone, and this tab's audio, which is
//     the patient (the doctor's own voice is never played back here). So every line
//     knows who said it. A socket the service closes is
//     reopened, with the audio of the gap held and sent. A session is rolled over
//     before the service's 15-minute cap, so a long consult loses no words. Lines
//     go to the transcript store (teleStore.ts → the server's database).
//   · Without a speech service — as now, until Parrotlet-a 2.0 — the browser's own
//     recogniser writes down the doctor's side (English only). It cannot hear the
//     patient's side, and the page says so. A service that drops mid-call hands over
//     to it the same way.
//
// One capture at a time, owned by this module rather than by a screen: leaving the
// session for the prescription and coming back keeps it recording.

import { mediaErrorNotice } from '../logic/speech'
import { asrUrl } from '../logic/asrStream'
import { useVoiceArbiter } from '../logic/dictation'

import { callLink } from './callLink'
import { putChunk } from './recordingStore'
import { speechLoop, type SpeechLoop } from './speechLoop'
import { useTele, type ChannelState } from './teleStore'
import type { Speaker, TeleSegment } from './teleTypes'

const ASR_TOKEN: string | undefined = import.meta.env.VITE_ASR_TOKEN || undefined
/** The service ends a session at 15 minutes; this hands over a little before. */
const ROLL_AFTER_MS = 14 * 60 * 1000
/** Audio held while a socket reopens: 30 s of 250 ms frames. */
const HOLD_FRAMES = 120
const TIMESLICE_MS = 3000

type Msg =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; id: number; text: string }
  | { type: 'status'; state: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

let seq = 0
const lineId = (speaker: Speaker) => `${speaker[0]}${Date.now().toString(36)}${(seq++).toString(36)}`

function notice(text: string) {
  useTele.getState().setLive((l) => (l && !l.notices.includes(text) ? { ...l, notices: [...l.notices, text] } : l))
}
function channelState(speaker: Speaker, state: ChannelState) {
  useTele.getState().setLive((l) => (l ? { ...l, channels: { ...l.channels, [speaker]: state } } : l))
}
function partial(speaker: Speaker, text: string) {
  useTele.getState().setLive((l) => (l && l.partials[speaker] !== text ? { ...l, partials: { ...l.partials, [speaker]: text } } : l))
}
let levelFrame = 0
const pendingLevels: Partial<Record<Speaker, number>> = {}
function level(speaker: Speaker, peak: number) {
  pendingLevels[speaker] = Math.max(pendingLevels[speaker] ?? 0, Math.min(1, peak * 2.2))
  if (levelFrame) return
  levelFrame = window.setTimeout(() => {
    levelFrame = 0
    const next = { ...pendingLevels }
    for (const k of Object.keys(pendingLevels) as Speaker[]) delete pendingLevels[k]
    useTele.getState().setLive((l) => (l ? { ...l, levels: { ...l.levels, ...next } } : l))
  }, 120)
}

/* ------------------------------------------------------------ one speaker, one socket */

class StreamChannel {
  private ws: WebSocket | null = null
  private held: ArrayBuffer[] = []
  private opened = false
  private everOpened = false
  private failures = 0
  private stopping = false
  private rollTimer = 0
  private retryTimer = 0
  private utterStart: number | null = null
  private lastFinal: number
  private node: AudioWorkletNode
  private flushed: (() => void) | null = null
  private readonly speaker: Speaker
  private readonly sid: string
  private readonly onUnreachable: () => void

  constructor(speaker: Speaker, sid: string, ctx: AudioContext, source: MediaStreamAudioSourceNode, onUnreachable: () => void) {
    this.speaker = speaker
    this.sid = sid
    this.onUnreachable = onUnreachable
    this.lastFinal = Date.now()
    this.node = new AudioWorkletNode(ctx, 'asr-capture')
    this.node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
      level(this.speaker, ev.data.peak)
      if (this.stopping) return
      if (this.ws?.readyState === WebSocket.OPEN && this.opened) this.ws.send(ev.data.pcm)
      else {
        this.held.push(ev.data.pcm)
        if (this.held.length > HOLD_FRAMES) this.held.shift()
      }
    }
    source.connect(this.node)
    this.connect()
  }

  private connect() {
    const base = asrUrl()
    if (!base) return this.onUnreachable()
    channelState(this.speaker, 'connecting')
    const url = ASR_TOKEN ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(ASR_TOKEN)}` : base
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.opened = false

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start' }))
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg
      if (m.type === 'ready') {
        this.opened = true
        this.everOpened = true
        this.failures = 0
        channelState(this.speaker, 'live')
        for (const f of this.held.splice(0)) ws.send(f)
        window.clearTimeout(this.rollTimer)
        this.rollTimer = window.setTimeout(() => this.roll(), ROLL_AFTER_MS)
      } else if (m.type === 'partial') {
        this.utterStart ??= Date.now()
        partial(this.speaker, m.text)
      } else if (m.type === 'final') {
        this.land(m.text)
      } else if (m.type === 'error') {
        notice(`${this.speaker === 'doctor' ? 'Your words' : 'The patient’s words'}: ${m.message}`)
      } else if (m.type === 'done') {
        this.flushed?.()
      }
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.opened = false
      window.clearTimeout(this.rollTimer)
      if (this.stopping) return this.flushed?.()
      if (!this.everOpened && this.failures === 0 && ev.code !== 4429) {
        this.failures += 1
        return this.onUnreachable()
      }
      this.failures += 1
      if (ev.code === 4429) {
        channelState(this.speaker, 'connecting')
        notice('Writing down the conversation is paused because the speech service is busy. It continues by itself. The video is still recording.')
      }
      if (this.failures > 12) {
        channelState(this.speaker, 'error')
        notice(
          `${this.speaker === 'doctor' ? 'Your words are' : 'The patient’s words are'} no longer being written down — the speech service cannot be reached. The video is still recording.`,
        )
        return
      }
      channelState(this.speaker, 'connecting')
      this.retryTimer = window.setTimeout(() => this.connect(), ev.code === 4429 ? 8000 : Math.min(8000, 400 * 2 ** this.failures))
    }
  }

  private land(text: string) {
    const t = text.trim()
    const now = Date.now()
    if (t) {
      const seg: TeleSegment = {
        id: lineId(this.speaker),
        speaker: this.speaker,
        text: t,
        startMs: this.utterStart ?? Math.max(this.lastFinal, now - 4000),
        endMs: now,
        source: 'shri-asr',
      }
      useTele.getState().addSegment(this.sid, seg)
    }
    this.utterStart = null
    this.lastFinal = now
    partial(this.speaker, '')
  }

  /** Before the service's cap: the old session flushes its last words, a new one takes over, nothing heard in between is lost. */
  private roll() {
    const old = this.ws
    if (!old || this.stopping) return
    this.opened = false // audio is held from now until the new session is ready
    this.ws = null
    old.onclose = null
    old.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg
      if (m.type === 'final') this.land(m.text)
      if (m.type === 'done') old.close()
    }
    try {
      old.send(JSON.stringify({ type: 'stop' }))
    } catch {
      /* already gone */
    }
    // The service allows a few sessions at once; the new one opens once the old has gone.
    const reopen = () => !this.stopping && !this.ws && this.connect()
    old.addEventListener('close', reopen)
    window.setTimeout(reopen, 6000)
  }

  /** Stop: the microphone side closes now; the socket waits for the service's last words. */
  stop(): Promise<void> {
    this.stopping = true
    window.clearTimeout(this.rollTimer)
    window.clearTimeout(this.retryTimer)
    this.node.port.onmessage = null
    this.node.disconnect()
    const ws = this.ws
    channelState(this.speaker, 'off')
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws?.close()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timeout)
        this.flushed = null
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        partial(this.speaker, '')
        resolve()
      }
      const timeout = window.setTimeout(finish, 15_000)
      this.flushed = finish
      ws.send(JSON.stringify({ type: 'stop' }))
    })
  }
}

/* ------------------------------------------------------------ the browser's recogniser, the doctor's side */

/**
 * The doctor's words, by this browser's speech-to-text (speechLoop.ts): listening
 * for the whole recording, through every quiet spell. One microphone serves one
 * recogniser, so while a notes box takes dictation (the voice arbiter) this steps
 * aside — the doctor's words go into the notes — and comes back when it is done.
 */
class BrowserChannel {
  private loop: SpeechLoop | null = null
  private paused = false
  private readonly unsub: () => void
  private readonly sid: string

  constructor(sid: string) {
    this.sid = sid
    this.loop = speechLoop({
      lang: 'en-IN',
      onFinal: (text, startMs, endMs) =>
        useTele.getState().addSegment(this.sid, { id: lineId('doctor'), speaker: 'doctor', text, startMs, endMs, source: 'browser' }),
      onInterim: (text) => partial('doctor', text),
      onFail: (why) => {
        channelState('doctor', 'error')
        notice(`${why} Your words are not being written down. The video is still recording if you started it.`)
      },
    })
    if (!this.loop) {
      channelState('doctor', 'error')
      notice('This browser cannot write down speech. The video is still recording. Use Google Chrome to see the conversation.')
    } else channelState('doctor', 'browser')
    const step = (busy: boolean) => {
      if (!this.loop || busy === this.paused) return
      this.paused = busy
      if (busy) {
        this.loop.pause()
        partial('doctor', '')
        channelState('doctor', 'paused')
      } else {
        this.loop.resume()
        channelState('doctor', 'browser')
      }
    }
    step(useVoiceArbiter.getState().activeId !== null)
    this.unsub = useVoiceArbiter.subscribe((s) => step(s.activeId !== null))
  }

  stop() {
    this.unsub()
    this.loop?.stop()
    partial('doctor', '')
    channelState('doctor', 'off')
    return Promise.resolve()
  }
}

/**
 * The patient's words, written down by the patient's own browser on their side of
 * the call (the patient portal; for now its stand-in) and sent here line by line
 * over the call's data line (callLink.ts). Asked for while this records, and
 * again every few seconds in case the patient's page came in late.
 */
class PatientLineChannel {
  private readonly off: () => void
  private readonly timer: number
  private readonly seen = new Set<string>()
  private readonly sid: string
  private readonly room: string

  constructor(sid: string, room: string) {
    this.sid = sid
    this.room = room
    channelState('patient', 'connecting')
    const ask = () => callLink.send(room, { k: 'transcribe', on: true })
    ask()
    this.timer = window.setInterval(ask, 5000)
    this.off = callLink.on((m, r) => {
      if (r !== this.room || m.k !== 'line' || this.seen.has(m.id)) return
      this.seen.add(m.id)
      // Their clock is not ours: the line ends now, and lasted as long as they said.
      const endMs = Date.now()
      const startMs = endMs - Math.max(0, Math.min(60_000, m.endMs - m.startMs))
      useTele.getState().addSegment(this.sid, { id: `p-${m.id}`, speaker: 'patient', text: m.text, startMs, endMs, source: 'browser' })
      channelState('patient', 'browser')
    })
  }

  stop() {
    window.clearInterval(this.timer)
    this.off()
    callLink.send(this.room, { k: 'transcribe', on: false })
    channelState('patient', 'off')
    return Promise.resolve()
  }
}

/* ------------------------------------------------------------ the capture */

interface Capture {
  sid: string
  mic: MediaStream
  display: MediaStream | null
  ctx: AudioContext
  recorder: MediaRecorder | null
  writes: Promise<void>
  channels: { stop: () => Promise<void> }[]
}

let current: Capture | null = null

function pickMime(video: boolean) {
  const options = video ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return options.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? ''
}

const warnUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault()
}

export const captureSupported = () =>
  window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioWorkletNode !== 'undefined' && typeof MediaRecorder !== 'undefined'
export const tabShareSupported = () => Boolean(navigator.mediaDevices?.getDisplayMedia)
export const isCapturing = () => current !== null

/**
 * Starts transcribing `sid` — and, unless `textOnly`, recording it. Asks for the microphone, then to share this
 * tab (with its sound: the patient's voice, from the video room). `cropTo` is the video room's box: the
 * recording keeps just that, where the browser can crop (Chrome's Region Capture). Declining the share still
 * transcribes the doctor's side, and says so. Throws only when the microphone itself cannot be opened.
 *
 * Text only keeps no audio or video at all, just the words — the live transcript, which downloads as text.
 */
export async function startCapture(sid: string, { textOnly = false, cropTo }: { textOnly?: boolean; cropTo?: Element } = {}): Promise<void> {
  if (current) return
  const tele = useTele.getState()
  tele.setLive(() => ({
    sid,
    startedAt: Date.now(),
    recording: 'off',
    channels: { doctor: 'connecting', patient: 'off', call: 'off' },
    partials: { doctor: '', patient: '', call: '' },
    levels: { doctor: 0, patient: 0, call: 0 },
    notices: [],
  }))

  let mic: MediaStream
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (err) {
    tele.setLive(() => undefined)
    throw new Error(mediaErrorNotice(err))
  }

  let display: MediaStream | null = null
  if (tabShareSupported()) {
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 15 },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
        } as MediaTrackConstraints,
        // Chrome's options: this tab, the one the call is in, with its sound — one Allow, nothing to pick.
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
      } as DisplayMediaStreamOptions)
    } catch {
      notice('This tab was not shared, so only your voice is being heard. To record the video and the patient too, stop recording, start again, and click Allow.')
    }
  } else notice('This browser can only hear your voice. Use Google Chrome to record the video and the patient too.')
  if (display && !display.getAudioTracks().length) notice('The patient cannot be heard because the tab was shared without its sound. Stop recording, start again, and leave “Also share tab audio” on.')
  // Keep just the video room, not the notes beside it, where the browser can crop a shared tab.
  const shot = display?.getVideoTracks()[0] as (MediaStreamTrack & { cropTo?: (t: unknown) => Promise<void> }) | undefined
  const Crop = (window as unknown as { CropTarget?: { fromElement: (e: Element) => Promise<unknown> } }).CropTarget
  if (shot?.cropTo && Crop && cropTo) {
    try {
      await shot.cropTo(await Crop.fromElement(cropTo))
    } catch {
      /* the whole tab is recorded instead */
    }
  }

  const ctx = new AudioContext()
  void ctx.resume().catch(() => undefined)
  await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}asr-capture-worklet.js`)
  const micSource = ctx.createMediaStreamSource(mic)
  const tabSource = display?.getAudioTracks().length ? ctx.createMediaStreamSource(display) : null

  // The recording: the tab's picture, and both voices mixed.
  const mix = ctx.createMediaStreamDestination()
  micSource.connect(mix)
  tabSource?.connect(mix)
  const video = display?.getVideoTracks()[0]
  const mime = pickMime(Boolean(video))
  let recorder: MediaRecorder | null = null
  // Each recording is its own part: a second Start in the same call never writes over the first.
  const key = `${sid}~${useTele.getState().sessions[sid]?.recordings?.length ?? 0}`
  const cap: Capture = {
    sid,
    mic,
    display,
    ctx,
    recorder: null,
    writes: Promise.resolve(),
    channels: [],
  }
  if (!textOnly) {
    try {
      recorder = new MediaRecorder(new MediaStream([...(video ? [video] : []), ...mix.stream.getAudioTracks()]), {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 96_000,
        ...(video ? { videoBitsPerSecond: 1_000_000 } : {}),
      })
      let chunk = 0
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return
        const n = chunk++
        cap.writes = cap.writes
          .then(() => putChunk(key, n, e.data))
          .then(() => {
            const r = useTele.getState().sessions[sid]?.recordings?.find((x) => x.key === key)
            if (r) useTele.getState().setRecording(sid, { ...r, bytes: r.bytes + e.data.size })
          })
          .catch(() => notice('The video could not be saved, because this computer may be out of space. The conversation is still being written down.'))
      }
      recorder.start(TIMESLICE_MS)
      tele.setRecording(sid, {
        key,
        mime: recorder.mimeType || mime || 'video/webm',
        startedAt: Date.now(),
        bytes: 0,
        video: Boolean(video),
      })
      tele.setLive((l) => (l ? { ...l, recording: 'recording' } : l))
    } catch {
      notice('This browser would not record video. The conversation is still being written down.')
    }
  }
  cap.recorder = recorder

  // The transcript: one channel per voice; without a service, the browser's recogniser for the doctor.
  let fellBack = false
  const fallBack = (unreachable: boolean) => {
    if (fellBack) return
    fellBack = true
    for (const ch of cap.channels) void ch.stop()
    // Each side's own browser writes down its own voice: the doctor's here, the patient's on their device.
    const room = useTele.getState().sessions[sid]?.meetCode
    cap.channels = room ? [new BrowserChannel(sid), new PatientLineChannel(sid, room)] : [new BrowserChannel(sid)]
    const browser = room
      ? 'Your words are written down by this browser, in English. The patient’s words are written down on their own device and come here line by line.'
      : 'Your words are written down by this browser, in English.'
    notice(unreachable ? `The speech service cannot be reached. ${browser}` : browser)
  }
  if (asrUrl()) {
    cap.channels.push(new StreamChannel('doctor', sid, ctx, micSource, () => fallBack(true)))
    if (tabSource) {
      channelState('patient', 'connecting')
      cap.channels.push(new StreamChannel('patient', sid, ctx, tabSource, () => fallBack(true)))
    }
  } else fallBack(false)

  // Ending the tab share from Chrome's own bar: the patient's side stops, the doctor's carries on.
  video?.addEventListener('ended', () => {
    if (current?.sid !== sid) return
    if (asrUrl()) channelState('patient', 'off')
    notice('Sharing this tab was stopped, so the video and the patient are no longer recorded. Stop recording and start again to fix it.')
  })

  current = cap
  window.addEventListener('beforeunload', warnUnload)
}

/** Stops it all and waits until the recording is saved and the last words have landed. */
export async function stopCapture(): Promise<void> {
  const cap = current
  if (!cap) return
  current = null
  window.removeEventListener('beforeunload', warnUnload)
  const tele = useTele.getState()
  tele.setLive((l) => (l ? { ...l, recording: cap.recorder ? 'finalising' : 'off' } : l))

  const recorded = new Promise<void>((resolve) => {
    if (!cap.recorder || cap.recorder.state === 'inactive') return resolve()
    cap.recorder.addEventListener('stop', () => resolve(), { once: true })
    cap.recorder.stop()
  })
  cap.mic.getTracks().forEach((t) => t.stop())
  cap.display?.getTracks().forEach((t) => t.stop())
  await Promise.all([recorded, ...cap.channels.map((c) => c.stop())])
  await cap.writes
  void cap.ctx.close().catch(() => undefined)
  tele.setLive(() => undefined)
}
