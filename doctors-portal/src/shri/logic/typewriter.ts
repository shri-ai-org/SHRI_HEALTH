// Live words, typed in as they arrive (`ui/LiveTranscript.tsx`, `ui/VoiceField.tsx`).
// A streaming engine sends a running guess that is revised as the doctor speaks,
// then a settled sentence at each pause. The shown text approaches the target a few
// characters per tick, keeps what still matches when a revision arrives and backs
// up to the shared start when it does not, and catches up rather than lagging — the
// further behind, the more characters per tick. Under reduced motion, or when off,
// the target is shown as it is.

import { useEffect, useRef, useState } from 'react'

const TICK_MS = 24

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

export function useTypewriter(target: string, enabled = true): string {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const on = enabled && !reduced
  const [shown, setShown] = useState(target)
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  })
  const pending = on && shown !== target

  useEffect(() => {
    if (!pending) return
    const t = window.setInterval(() => {
      setShown((now) => {
        const goal = targetRef.current
        if (now === goal) return now
        const keep = commonPrefix(now, goal)
        if (keep < now.length) return goal.slice(0, keep)
        return goal.slice(0, now.length + Math.max(1, Math.ceil((goal.length - now.length) / 12)))
      })
    }, TICK_MS)
    return () => window.clearInterval(t)
  }, [pending])

  return on ? shown : target
}
