import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab inside `container` while `active`, moves focus into it on open and gives focus back to
 * the element that had it on close (WCAG 2.4.3 focus order, 2.1.2 no keyboard trap outside dialogs).
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active: boolean, initialFocus?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return
    const node = container.current
    if (!node) return
    const previous = document.activeElement as HTMLElement | null
    const first = initialFocus?.current ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node
    first.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !node) return
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstItem = items[0]!
      const lastItem = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [active, container, initialFocus])
}
