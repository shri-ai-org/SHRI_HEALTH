import { ILLUSTRATION_VIEWBOX } from './shared'
import type { IllustrationProps } from './shared'

/** IP Admission / bed allocation — a simple hospital bed mark with a
 *  hospital-cross badge, matching the same illustration language as the
 *  rest of this folder. */
export function AdmissionIllustration({ className, ...props }: IllustrationProps) {
  return (
    <svg viewBox={ILLUSTRATION_VIEWBOX} className={className} aria-hidden="true" focusable="false" {...props}>
      <rect x="6" y="6" width="52" height="52" rx="18" fill="currentColor" fillOpacity="0.1" />
      <path d="M15 46V28a3 3 0 013-3h3v9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="18" y="32" width="9" height="7" rx="2" fill="currentColor" fillOpacity="0.2" />
      <rect x="15" y="36" width="34" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M13 50v-4M51 50v-4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="47" cy="18" r="7" fill="currentColor" fillOpacity="0.16" />
      <path d="M47 14v8M43 18h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
