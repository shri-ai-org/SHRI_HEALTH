/**
 * §10 Motion — one easing, one duration, a handful of variants. Anything not
 * listed here is CSS (pulse, waveform, knob, hover colour) and is stopped by
 * the global reduced-motion rule; framer's own transforms are stopped by the
 * `MotionConfig reducedMotion="user"` at the app root.
 */

import type { Transition, Variants } from 'framer-motion'

export const EASE: [number, number, number, number] = [0.2, 0, 0, 1]
export const T220: Transition = { duration: 0.22, ease: EASE }
export const T150: Transition = { duration: 0.15, ease: EASE }

/** Drawers from the right: translateX(24px) + fade → none. */
export const drawerRight: Variants = {
  hidden: { x: 24, opacity: 0 },
  shown: { x: 0, opacity: 1, transition: T220 },
  exit: { x: 24, opacity: 0, transition: T220 },
}

/** Under 768px drawers and modals are bottom sheets: they rise from the edge they sit on. */
export const sheetUp: Variants = {
  hidden: { y: 40, opacity: 0 },
  shown: { y: 0, opacity: 1, transition: T220 },
  exit: { y: 40, opacity: 0, transition: T220 },
}

/** Popovers, menus, modals: translateY(8px) + fade → none. */
export const popover: Variants = {
  hidden: { y: 8, opacity: 0 },
  shown: { y: 0, opacity: 1, transition: T220 },
  exit: { y: 8, opacity: 0, transition: T150 },
}

export const scrim: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.18 } },
  exit: { opacity: 0, transition: { duration: 0.18 } },
}

/** Month change slides from the side you moved towards. */
export const monthSlide: Variants = {
  enter: (dir: 1 | -1) => ({ x: dir * 28, opacity: 0 }),
  centre: { x: 0, opacity: 1, transition: T220 },
  exit: (dir: 1 | -1) => ({ x: dir * -28, opacity: 0, transition: T150 }),
}
