// Which engine turns the doctor's voice into text. Shri Health's own speech service
// (`asrStream.ts`, Tamil and English to English) when a service is configured; the
// browser's recogniser (`dictation.ts`) otherwise — and as the fallback if the
// service cannot be reached, said once, so dictation never simply stops working.
// Both hold the microphone under the same arbiter id, so one box is one recorder.

import { useEffect, useRef, useState } from 'react'

import { asrUrl, useStreamingDictation } from './asrStream'
import { useDictation, type DictationOptions, type DictationState } from './dictation'

export type VoiceEngine = 'stream' | 'browser'

export const FALLBACK_NOTICE = 'The transcription service isn’t reachable, so this take uses the browser’s recogniser (English only).'

export function useVoiceEngine(opts: DictationOptions & { arbiterId: string }): DictationState & { engine: VoiceEngine; engineNotice: string | null } {
  const [engine, setEngine] = useState<VoiceEngine>(() => (asrUrl() ? 'stream' : 'browser'))
  const [engineNotice, setEngineNotice] = useState<string | null>(null)
  const startBrowser = useRef(false)

  const stream = useStreamingDictation({
    ...opts,
    onUnreachable: () => {
      setEngine('browser')
      setEngineNotice(FALLBACK_NOTICE)
      startBrowser.current = true
    },
  })
  const browser = useDictation(opts)

  // The take the doctor asked for carries on in the browser, without a second press.
  useEffect(() => {
    if (engine === 'browser' && startBrowser.current) {
      startBrowser.current = false
      browser.start()
    }
  }, [engine, browser])

  return { ...(engine === 'stream' ? stream : browser), engine, engineNotice }
}
