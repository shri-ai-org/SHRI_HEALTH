import type { CSSProperties } from 'react'
import { cn } from './cn'
import { TONE_HEX, toneTint } from './toneHex'
import type { IconTone } from './toneHex'

/** The outer element of a dashboard figure — see components/ui/Figure.tsx. */
export function figureClasses({ interactive, selected }: { interactive: boolean; selected?: boolean }) {
  return cn(
    // The icon sits over the figure (§9.4 KPI tile), so a figure in a six-up
    // row or on a phone keeps whole words.
    'surface-raised relative flex min-w-0 flex-col items-start justify-start gap-2 overflow-hidden rounded-xl border bg-surface-1 p-3 text-left sm:gap-2.5 sm:p-3.5',
    interactive && 'focus-ring surface-raised-hover',
    // The chosen figure is ringed in its own hue (--fig-tone, set by figureStyle).
    selected && 'ring-2 ring-[var(--fig-tone)] ring-offset-2 ring-offset-bg',
  )
}

/**
 * The figure card's surface: a pastel diagonal gradient of its hue with a
 * soft light in one corner, over the card's own white (or dark) surface —
 * colourful but calm, never a saturated fill. The hue also tints the edge
 * and is exposed as --fig-tone for the icon chip, sparkline, hint, watermark
 * and the selected ring.
 */
export function figureStyle(hue: IconTone, selected?: boolean): CSSProperties {
  return {
    '--fig-tone': TONE_HEX[hue],
    borderColor: toneTint(hue, selected ? 0.55 : 0.3),
    backgroundImage: [
      // A soft light in the top-right corner, over a pastel diagonal of the hue.
      `radial-gradient(90% 80% at 100% 0%, ${toneTint(hue, selected ? 0.2 : 0.14)} 0%, transparent 60%)`,
      `linear-gradient(140deg, ${toneTint(hue, selected ? 0.24 : 0.17)} 0%, ${toneTint(hue, selected ? 0.1 : 0.06)} 55%, ${toneTint(hue, 0.02)} 100%)`,
    ].join(', '),
  } as CSSProperties
}

/**
 * A row of figures: a grid from 640px; on a phone a horizontal scroll row
 * (a little over two cards in view, so the next one shows there is more),
 * snapping card by card. `columns` are the grid's column classes.
 */
export function figureRowClass(columns: string) {
  return cn(
    'scrollbar-hide -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 py-1',
    '[&>*]:w-[44%] [&>*]:min-w-[8.5rem] [&>*]:shrink-0 [&>*]:snap-start',
    'sm:mx-0 sm:grid sm:gap-3 sm:overflow-visible sm:p-0 sm:[&>*]:w-auto sm:[&>*]:min-w-0',
    columns,
  )
}
