// ported from src/components/calm.tsx:234-254 (`useScope`): the slice of a list
// the doctor is looking at, kept in the URL so a link can open a screen already
// narrowed. The fallback is never written, so a plain address opens on it.

import { useSearchParams } from 'react-router-dom'

export function useScope<K extends string>(options: readonly K[], fallback: K, param = 'scope'): [K, (key: K) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get(param)
  const value = (options as readonly string[]).includes(raw ?? '') ? (raw as K) : fallback
  const set = (key: K) => {
    const next = new URLSearchParams(params)
    if (key === fallback) next.delete(param)
    else next.set(param, key)
    setParams(next, { replace: true })
  }
  return [value, set]
}
