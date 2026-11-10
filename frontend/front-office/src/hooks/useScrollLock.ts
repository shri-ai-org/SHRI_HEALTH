import { useEffect } from 'react'

// Counted, so two overlays open at once (a dialog over a flow sheet) do not
// unlock the page when the first one closes.
let locks = 0
let saved: { body: string; main: string } | null = null

/**
 * Stops the page behind an overlay from scrolling, and makes it inert. The shell scrolls inside
 * `#main-content`, not the body, so both are locked. `scrollbar-gutter:
 * stable` on <html> keeps the page from shifting sideways.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined
    const main = document.getElementById('main-content')
    if (locks === 0) {
      saved = { body: document.body.style.overflow, main: main?.style.overflow ?? '' }
      document.body.style.overflow = 'hidden'
      if (main) main.style.overflow = 'hidden'
      // The page behind an overlay is inert — no tabbing into it, and screen
      // readers stay in the dialog. Overlays are portalled outside #root.
      document.getElementById('root')?.setAttribute('inert', '')
    }
    locks += 1
    return () => {
      locks -= 1
      if (locks === 0 && saved) {
        document.getElementById('root')?.removeAttribute('inert')
        document.body.style.overflow = saved.body
        const current = document.getElementById('main-content')
        if (current) current.style.overflow = saved.main
        saved = null
      }
    }
  }, [active])
}
