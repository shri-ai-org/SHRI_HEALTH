import { ILLUSTRATION_VIEWBOX } from './shared'
import type { IllustrationProps } from './shared'

/** Appointments / scheduling — a calendar mark with a confirmed-slot check
 *  badge. `currentColor`-driven, same illustration language as the rest of
 *  this folder (soft background wash + a solid-stroke badge accent). */
export function AppointmentIllustration({ className, ...props }: IllustrationProps) {
  return (
    <svg viewBox={ILLUSTRATION_VIEWBOX} className={className} aria-hidden="true" focusable="false" {...props}>
      <rect x="6" y="6" width="52" height="52" rx="18" fill="currentColor" fillOpacity="0.1" />
      <rect x="15" y="20" width="30" height="26" rx="4" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M15 27h30" stroke="currentColor" strokeWidth="2" />
      <path d="M21 16v8M39 16v8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22" cy="35" r="1.6" fill="currentColor" />
      <circle cx="30" cy="35" r="1.6" fill="currentColor" />
      <circle cx="22" cy="41" r="1.6" fill="currentColor" />
      <circle cx="46" cy="43" r="8" fill="currentColor" fillOpacity="0.16" />
      <path d="M42.5 43l2.5 2.5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
