// SHRI_HEALTH: after Sign, the pharmacy status is read again until it settles, so "Queued" turns
// into "Sent" or "Received" without a reload. No imports, so its stop rules have a unit test.

/** Statuses that can still change: only lines in one of these are read again. */
export const WAITING_STATUSES: readonly string[] = ['queued', 'sent']

export interface StatusPoll {
  /** The signed lines whose status can still change, read at each tick. None left stops the poll. */
  pending: () => string[]
  /** Reads one line's status and stores it. A failure keeps the last status shown. */
  read: (id: string) => Promise<void>
  /** A hidden tab stops the poll. */
  isHidden: () => boolean
  /** Called once, whatever stopped the poll. */
  onStop?: () => void
  everyMs?: number
  forMs?: number
  now?: () => number
}

/**
 * Reads the pending lines every `everyMs` (3 s) for `forMs` (30 s), one request at a time. It stops
 * when no line is pending, when the time is up, when the tab is hidden, or when the returned
 * function is called (the user left the screen). A line still waiting at the end stays as it is.
 */
export function pollStatus({ pending, read, isHidden, onStop, everyMs = 3000, forMs = 30000, now = Date.now }: StatusPoll): () => void {
  const started = now()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function stop(): void {
    if (stopped) return
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    onStop?.()
  }

  async function tick(): Promise<void> {
    timer = undefined
    if (stopped) return
    if (isHidden() || now() - started > forMs) return stop()
    const ids = pending()
    if (ids.length === 0) return stop()
    // One line at a time, so there is never more than one request in flight.
    for (const id of ids) {
      if (stopped) return
      await read(id).catch(() => undefined)
    }
    if (stopped) return
    if (pending().length === 0) return stop()
    timer = setTimeout(() => void tick(), everyMs)
  }

  timer = setTimeout(() => void tick(), everyMs)
  return stop
}
