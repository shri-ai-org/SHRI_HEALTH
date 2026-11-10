// One tab of the doctor's portal per browser does the work that needs doing only
// once: saying the demo code (CodeBeacon) and asking the Jitsi server who is in
// each visit's room (roomWatch), and raising the notice on this computer. The
// browser's lock decides which; when that tab closes, the next one takes over.
// Every tab still shows the alert — the waiting list is shared between tabs.

import { useEffect, useState } from 'react'

const LOCK = 'shri-portal-leader'

export function useLeader(): boolean {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const [leader, setLeader] = useState(!locks)
  useEffect(() => {
    if (!locks) return
    const stop = new AbortController()
    let release = () => {}
    locks
      .request(LOCK, { signal: stop.signal }, () =>
        new Promise<void>((done) => {
          release = done
          setLeader(true)
        }),
      )
      .catch(() => {
        /* this tab closed before it led */
      })
    return () => {
      stop.abort()
      release()
      setLeader(false)
    }
  }, [locks])
  return leader
}
