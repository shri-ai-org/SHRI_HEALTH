import type { ComponentPropsWithoutRef } from 'react'

/** Shared contract for every decorative illustration in this folder: a
 *  64x64 viewBox, fully `currentColor`-driven (a soft `fillOpacity` wash for
 *  the background shape, a solid stroke for the line art) so a single
 *  `className="text-primary-text"` (or any existing tone color) controls the
 *  whole illustration and it re-themes for free in dark mode — no hardcoded
 *  hex anywhere. Purely decorative: always `aria-hidden`, never a stand-in
 *  for text content. */
export type IllustrationProps = ComponentPropsWithoutRef<'svg'>

export const ILLUSTRATION_VIEWBOX = '0 0 64 64'
