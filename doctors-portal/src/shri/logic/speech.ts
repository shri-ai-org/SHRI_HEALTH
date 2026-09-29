// ported from src/components/dictation.tsx:106-153 (`BCP47`, `browserName`, the
// model line, `NOTICE`, `languageNotice`, `mediaErrorNotice`) and 255-260
// (`UNSCORED_CONFIDENCE`): what the dictation box says about the engine that
// heard the doctor, and what it says when that engine cannot run.

import { LANGUAGES, type LanguageCode } from '@/data/kit'

export const BCP47: Record<LanguageCode, string> = {
  EN: 'en-IN',
  HI: 'hi-IN',
  KN: 'kn-IN',
}

/** The engine is the browser's, so the model line names the browser. */
function browserName(): string {
  const ua = navigator.userAgent
  if ((navigator as unknown as { brave?: unknown }).brave) return 'Brave'
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Chrome|Chromium|CriOS/.test(ua)) return 'Chrome'
  if (/Safari/.test(ua)) return 'Safari'
  return 'this browser'
}

export function speechModel(language: LanguageCode): string {
  return `Web Speech API · ${browserName()} · ${BCP47[language]}`
}

/** A note typed without the microphone names no engine. */
export const TYPED_MODEL = 'Typed — no speech recognition'

/**
 * Chrome reports 0 in some builds and Safari often reports nothing at all. A
 * reported 0 is not a measured 0, so it is "no score" — shown as the MED band
 * with no percentage — rather than LOW.
 */
export const UNSCORED_CONFIDENCE = 0.7

export const NOTICE = {
  insecure: 'The microphone needs a secure page — open this site over https or on localhost.',
  unsupported: 'This browser can’t turn speech into text. Use Chrome, Edge or Safari — or type instead.',
  blocked: 'Microphone access was blocked. Allow it from the padlock / site settings in the address bar, then press Dictate again.',
  noMic: 'No microphone was found on this device.',
  network:
    'The browser’s speech service could not be reached (Brave and some privacy settings block it). Use Chrome, Edge or Safari, or type instead.',
  keepsStopping: 'Speech recognition keeps stopping on its own. What was heard is kept — press Dictate again, or type instead.',
  wouldNotStart: 'Speech recognition would not start in this browser. Type instead.',
} as const

export function languageNotice(language: LanguageCode): string {
  const label = LANGUAGES.find((l) => l.code === language)?.label ?? BCP47[language]
  return `This browser’s speech recognition does not support ${label}. Switch your language in settings, or type instead.`
}

/** Why the microphone would not open — each cause has its own fix, so each has its own sentence. */
export function mediaErrorNotice(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return NOTICE.blocked
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return NOTICE.noMic
  if (name === 'NotReadableError' || name === 'AbortError')
    return 'The microphone is in use by another app or tab. Close it there, then press Dictate again — or type instead.'
  return 'The microphone could not be opened. Press Dictate again, or type instead.'
}
