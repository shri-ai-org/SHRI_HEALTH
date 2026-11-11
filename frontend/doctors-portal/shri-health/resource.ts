// SHRI_HEALTH data layer. The screens read their mock data synchronously (`patient(id)`,
// `maybeEncounter(id)`); these readers keep that shape over the API with React Suspense: `read()`
// returns the value once it has loaded, and until then throws the pending promise, which the
// route's <Suspense> (RouteBoundary) waits on. A failure goes to RouteBoundary's "This screen
// could not open" card. It is kept for a few seconds, so React's retry right after an error
// shows the card instead of loading again, and then forgotten, so "Try again" loads again.

type Entry = { status: 'pending'; promise: Promise<void> } | { status: 'done'; value: unknown } | { status: 'failed'; error: unknown; at: number }

const FAILURE_KEPT_MS = 3000

const cache = new Map<string, Entry>()

export function read<T>(key: string, load: () => Promise<T>): T {
  const entry = cache.get(key)
  if (entry?.status === 'done') return entry.value as T
  if (entry?.status === 'failed' && Date.now() - entry.at < FAILURE_KEPT_MS) throw entry.error
  if (entry?.status === 'pending') throw entry.promise
  const promise = load().then(
    (value) => void cache.set(key, { status: 'done', value }),
    (error: unknown) => void cache.set(key, { status: 'failed', error, at: Date.now() }),
  )
  cache.set(key, { status: 'pending', promise })
  throw promise
}

/** Forget a loaded value (after a write changed it), so the next read loads it again. */
export function forget(key: string): void {
  cache.delete(key)
}

/** Forget every loaded value (after break-glass opened a chart the server refused before). */
export function forgetAll(): void {
  cache.clear()
}
