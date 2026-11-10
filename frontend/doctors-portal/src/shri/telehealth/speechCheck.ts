// Can this page turn speech into text right now? Asked before the doctor starts, so
// a missing speech service is said plainly up front instead of a transcript that
// silently stays empty. The Shri speech service is asked by opening its socket and
// waiting for "ready" (then closing at once). Without it, the only fallback is the
// browser's own recogniser, which hears only the doctor, only in English, and which
// some browsers (Brave) block entirely.

import { useEffect, useState } from 'react'

import { asrUrl } from '../logic/asrStream'

export type SpeechState = 'checking' | 'ready' | 'busy' | 'browser' | 'none'

const TOKEN: string | undefined = import.meta.env.VITE_ASR_TOKEN || undefined

export const isBrave = () => Boolean((navigator as Navigator & { brave?: unknown }).brave)
const browserCanListen = () => !isBrave() && Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)

function probe(): Promise<SpeechState> {
  const base = asrUrl()
  const fallback: SpeechState = browserCanListen() ? 'browser' : 'none'
  if (!base) return Promise.resolve(fallback)
  return new Promise((resolve) => {
    let settled = false
    const done = (s: SpeechState) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      resolve(s)
    }
    const ws = new WebSocket(TOKEN ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : base)
    const timer = window.setTimeout(() => done(fallback), 5000)
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string }
      if (m.type === 'ready') done('ready')
    }
    ws.onclose = (e) => done(e.code === 4429 ? 'busy' : fallback)
  })
}

/** The speech check, repeated every 20 s while `active`. */
export function useSpeechCheck(active: boolean): SpeechState {
  const [state, setState] = useState<SpeechState>('checking')
  useEffect(() => {
    if (!active) return
    let alive = true
    const run = () => void probe().then((s) => alive && setState(s))
    run()
    const t = window.setInterval(run, 20_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [active])
  return state
}
