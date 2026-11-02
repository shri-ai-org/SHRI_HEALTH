/**
 * Where an overlay sits, by width. Every overlay is `position: fixed` to the
 * viewport — the surface is the page now, and it scrolls — and under 768px
 * drawers and modals become sheets that rise from the bottom edge. Each
 * overlay keeps its own markup; these hand it the frame classes, the size and
 * the motion to use.
 */

import type { CSSProperties } from 'react'
import { useIsPresent, type Variants } from 'framer-motion'

import { drawerRight, popover, sheetUp } from '../lib/motion'

import { useMediaQuery } from './hooks'

/**
 * An overlay on its way out stops taking the pointer at once: a click made
 * while it fades belongs to what is underneath, not to the leaving overlay.
 * Call it in the component `AnimatePresence` holds.
 */
export function useLeavingStyle(): CSSProperties | undefined {
  return useIsPresent() ? undefined : { pointerEvents: 'none' }
}

/** The project's `sm` breakpoint: below it is a phone. */
export function useIsPhone() {
  return useMediaQuery('(max-width: 767.98px)')
}

export interface DrawerFrame {
  phone: boolean
  className: string
  style: CSSProperties | undefined
  variants: Variants
}

/**
 * A right drawer (Quick-Panel, Why?) at ≥ 768px; a full-width bottom sheet
 * below, content-sized up to 88% of the viewport. The insets keep its header
 * off the status bar and its footer off the home indicator.
 */
export function useDrawerFrame(width: number): DrawerFrame {
  const phone = useIsPhone()
  const leaving = useLeavingStyle()
  return phone
    ? {
        phone,
        className: 'fixed inset-x-0 bottom-0 max-h-[88dvh] rounded-t-sh-modal pb-(--sa-b) pl-(--sa-l) pr-(--sa-r) shadow-sh-pop',
        style: leaving,
        variants: sheetUp,
      }
    : {
        phone,
        className: 'fixed inset-y-0 right-0 max-w-full pb-(--sa-b) pr-(--sa-r) pt-(--sa-t) shadow-sh-drawer',
        style: { width, ...leaving },
        variants: drawerRight,
      }
}

export interface ModalFrame {
  phone: boolean
  /** The positioning wrapper. */
  outer: string
  outerStyle: CSSProperties | undefined
  /** Added to the dialog card itself. */
  inner: string
  variants: Variants
}

/**
 * A centred modal (or, with `top`, one hung from the top like the search
 * palette) at ≥ 768px, never taller than the viewport; a near-full-screen
 * sheet below 768px that leaves 12px of the page showing above it.
 */
export function useModalFrame(width: number, place: 'centre' | 'top' = 'centre'): ModalFrame {
  const phone = useIsPhone()
  const leaving = useLeavingStyle()
  if (phone) {
    return {
      phone,
      outer: 'fixed inset-x-0 bottom-0 top-[calc(var(--sa-t)_+_12px)] flex flex-col',
      outerStyle: leaving,
      inner: 'flex min-h-0 flex-1 flex-col overflow-y-auto rounded-b-none pb-[calc(22px_+_var(--sa-b))] pl-[max(22px,var(--sa-l))] pr-[max(22px,var(--sa-r))]',
      variants: sheetUp,
    }
  }
  return {
    phone,
    outer:
      place === 'top'
        ? 'fixed left-1/2 top-[110px] max-w-[calc(100%-32px)] -translate-x-1/2'
        : 'fixed left-1/2 top-1/2 max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2',
    outerStyle: { width, ...leaving },
    inner: place === 'top' ? 'max-h-[calc(100dvh-140px)] overflow-y-auto' : 'max-h-[calc(100dvh-32px)] overflow-y-auto',
    variants: popover,
  }
}
