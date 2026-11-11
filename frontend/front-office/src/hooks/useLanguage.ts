import { useSyncExternalStore } from 'react'

// UI-only language choice (GP-08): it changes a local label, it does not
// translate the app. One shared value so the header switcher and the phone
// More sheet always agree.

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ta', label: 'தமிழ்' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

let current: LanguageCode = 'en'
const listeners = new Set<() => void>()

export function setLanguage(code: LanguageCode): void {
  if (code === current) return
  current = code
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLanguage(): LanguageCode {
  return useSyncExternalStore(subscribe, () => current)
}
