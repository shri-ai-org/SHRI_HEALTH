import { ILLUSTRATION_VIEWBOX } from './shared'
import type { IllustrationProps } from './shared'

/** Payment / collection — a card mark with a confirmed-payment check badge.
 *  `currentColor`-driven, same illustration language as the rest of this
 *  folder. */
export function PaymentIllustration({ className, ...props }: IllustrationProps) {
  return (
    <svg viewBox={ILLUSTRATION_VIEWBOX} className={className} aria-hidden="true" focusable="false" {...props}>
      <rect x="6" y="6" width="52" height="52" rx="18" fill="currentColor" fillOpacity="0.1" />
      <rect x="13" y="21" width="34" height="23" rx="4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <rect x="13" y="27" width="34" height="5" fill="currentColor" fillOpacity="0.25" />
      <path d="M19 39h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="46" cy="44" r="8" fill="currentColor" fillOpacity="0.18" />
      <path d="M42.5 44l2.5 2.5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
