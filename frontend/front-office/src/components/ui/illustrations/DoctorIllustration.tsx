import { ILLUSTRATION_VIEWBOX } from './shared'
import type { IllustrationProps } from './shared'

/** Doctor / clinician — the same rounded person mark as
 *  {@link PatientIllustration}, badged with a stethoscope instead of a
 *  cross, so the illustration language stays consistent across the
 *  patient/clinician pairing while still reading as distinct at a glance. */
export function DoctorIllustration({ className, ...props }: IllustrationProps) {
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
      <path d="M44 15v2.5a3 3 0 006 0V15" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="47" cy="21.5" r="1.4" fill="currentColor" />
    </svg>
  )
}
