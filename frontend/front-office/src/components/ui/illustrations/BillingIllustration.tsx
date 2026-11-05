import { ILLUSTRATION_VIEWBOX } from './shared'
import type { IllustrationProps } from './shared'

/** Billing / estimates — a folded-corner document mark with line-item rows
 *  and a currency badge. `currentColor`-driven, same illustration language
 *  as the rest of this folder. */
export function BillingIllustration({ className, ...props }: IllustrationProps) {
  return (
    <svg viewBox={ILLUSTRATION_VIEWBOX} className={className} aria-hidden="true" focusable="false" {...props}>
      <rect x="6" y="6" width="52" height="52" rx="18" fill="currentColor" fillOpacity="0.1" />
      <path
        d="M20 14h14l6 6v28a2 2 0 01-2 2H20a2 2 0 01-2-2V16a2 2 0 012-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M34 14v6h6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M22 30h16M22 36h16M22 42h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="46" cy="46" r="8" fill="currentColor" fillOpacity="0.16" />
      <path d="M43 43h6M43 46h6M44 43l4 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
