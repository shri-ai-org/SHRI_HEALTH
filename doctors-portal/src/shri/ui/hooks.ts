import { useEffect, useRef, useState, type RefObject } from 'react'

import { useModalLayer } from './layers'

/**
 * Keeps Tab inside an open overlay, focuses its first control, restores focus
 * on close — and, while it traps focus, registers the surface as a modal
 * layer, so the toast stack stays off it (`ui/layers.ts`).
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!active) return
    const node = ref.current
    const previous = document.activeElement as HTMLElement | null
    const focusable = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
    // A marked element first — a control, or a long dialog's title (tabindex -1), so its opening stays in view.
    const marked = Array.from(node?.querySelectorAll<HTMLElement>('[data-autofocus="true"]') ?? []).find((el) => !el.hasAttribute('disabled'))
    const first = marked ?? focusable()[0]
    first?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const a = items[0]
      const z = items[items.length - 1]
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault()
        z.focus()
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault()
        a.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
  }, [active])
  useModalLayer(ref, active)
  return ref
}

/** Calls `onOutside` on a pointerdown outside `ref` while `active`. */
export function useOutsideClick(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void) {
  useEffect(() => {
    if (!active) return
    function onDown(e: PointerEvent) {
      const node = ref.current
      if (node && !node.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [ref, active, onOutside])
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false))
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}
