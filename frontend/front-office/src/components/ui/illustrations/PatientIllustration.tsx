import { ILLUSTRATION_VIEWBOX } from './shared'
import type { IllustrationProps } from './shared'

/** Patient / identity — a rounded person mark with a small health-cross
 *  badge. Color comes entirely from `currentColor` (set the wrapper's text
 *  color, e.g. `text-primary-text`), so it re-themes for dark mode for free. */
export function PatientIllustration({ className, ...props }: IllustrationProps) {
  return (
    <svg viewBox={ILLUSTRATION_VIEWBOX} className={className} aria-hidden="true" focusable="false" {...props}>
      <rect x="6" y="6" width="52" height="52" rx="18" fill="currentColor" fillOpacity="0.1" />
      <circle cx="30" cy="27" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <path
        d="M14 50c0-9.9 7.2-16 16-16s16 6.1 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="47" cy="18" r="7" fill="currentColor" fillOpacity="0.16" />
      <path d="M47 14v8M43 18h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
