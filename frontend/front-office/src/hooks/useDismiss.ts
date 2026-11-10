import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useLayer } from './useLayer'

/**
 * The shared close behaviour of a header menu or popover: a press outside
 * `root` closes it, and Esc closes it (only when it is the top-most layer)
 * and returns focus to `trigger`.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
  trigger?: RefObject<HTMLElement | null>,
): void {
  useLayer(open, () => {
    close()
    trigger?.current?.focus()
  })

  useEffect(() => {
    if (!open) return undefined
    function handlePointerDown(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open, close, root])
}
