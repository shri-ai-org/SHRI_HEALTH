import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  )
}

/**
 * Keeps keyboard focus inside `container` while `active`: focus moves in on
 * open (the first `[data-autofocus]` element, else the first focusable that
 * isn't marked `data-skip-autofocus` — e.g. a close button — else the
 * container), Tab cycles within it, and on close focus returns to whatever
 * opened it.
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = container.current
    if (!active || !root) return undefined
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const initial =
      root.querySelector<HTMLElement>('[data-autofocus]') ??
      focusables(root).find((el) => !el.hasAttribute('data-skip-autofocus')) ??
      root
    initial.focus({ preventScroll: true })

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !root) return
      const items = focusables(root)
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault()
        first.focus()
      }
    }

    root.addEventListener('keydown', handleKeyDown)
    return () => {
      root.removeEventListener('keydown', handleKeyDown)
      if (opener && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [container, active])
}
