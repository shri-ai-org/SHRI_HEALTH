import { useEffect, useState } from 'react'

// A real, ticking clock — NOT a random-number generator. Screens use this to
// recompute genuine elapsed time ("waiting 6 min", derived from
// currentTime - createdAt) so those numbers advance naturally without ever
// touching the underlying data. This is the only thing that changes on a
// timer in this app; nothing here mutates the operational store.
//
// Ticks land on the wall clock (every 15 s means :00, :15, :30, :45), not on
// whenever the screen mounted — so every clock on screen, the live time in
// the bar and each chart's Now pin, turns the minute at the same moment.
export function useNow(intervalMs: number = 15000): number {
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    let timer: number | undefined
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, intervalMs - (Date.now() % intervalMs))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [intervalMs])

  return now
}
