import { useCallback, useEffect, useRef, useState } from 'react'
import { isProblem, type Problem } from '../../../design-system'

export type Resource<T> =
  | { status: 'loading'; data?: undefined; problem?: undefined; reload: () => void }
  | { status: 'error'; data?: undefined; problem: Problem; reload: () => void }
  | { status: 'ready'; data: T; problem?: undefined; reload: () => void; setData: (update: (current: T) => T) => void }

/** Any thrown value as a Problem, so screens always switch on `code`. */
export function toProblem(error: unknown): Problem {
  if (isProblem(error)) return error
  return { type: 'about:blank', title: 'Network error', status: 0, code: 'service-unavailable' }
}

type Settled<T> = { key: string } & ({ status: 'error'; problem: Problem } | { status: 'ready'; data: T })

/**
 * Loads one thing for a panel: loading, error (with Retry) and ready states. `deps` re-run the load;
 * a response that arrives after the panel moved on is dropped. Loading is derived (the last settled
 * result is for an older key), so the effect only sets state when the request settles.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([...deps, attempt])
  const loadRef = useRef(load)
  // Declared before the load effect, so the load below always calls the latest function.
  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    let live = true
    loadRef.current().then(
      (data) => live && setSettled({ key, status: 'ready', data }),
      (error: unknown) => live && setSettled({ key, status: 'error', problem: toProblem(error) }),
    )
    return () => {
      live = false
    }
  }, [key])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const setData = useCallback((update: (current: T) => T) => {
    setSettled((s) => (s && s.status === 'ready' ? { ...s, data: update(s.data) } : s))
  }, [])

  if (!settled || settled.key !== key) return { status: 'loading', reload }
  if (settled.status === 'ready') return { status: 'ready', data: settled.data, reload, setData }
  return { status: 'error', problem: settled.problem, reload }
}
