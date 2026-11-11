// The app's tone system. Every tone resolves to a design token defined in
// shared/design-system.css; STATUS_TONE below maps each status word to one of them.

export type Tone = 'critical' | 'warning' | 'stable' | 'info' | 'brand' | 'neutral' | 'teal' | 'indigo' | 'purple' | 'cyan' | 'rose'

export interface ToneStyle {
  bg: string
  border: string
  text: string
  dot: string
  bar: string
}

export const TONE_STYLES: Record<Tone, ToneStyle> = {
  critical: {
    bg: 'bg-critical-bg',
    border: 'border-critical-fg/25',
    text: 'text-critical-fg',
    dot: 'bg-critical-fg',
    bar: 'bg-critical-fg',
  },
  warning: {
    bg: 'bg-warning-bg',
    border: 'border-warning-fg/25',
    text: 'text-warning-fg',
    dot: 'bg-warning-fg',
    bar: 'bg-warning-fg',
  },
  stable: {
    bg: 'bg-success-bg',
    border: 'border-success-fg/25',
    text: 'text-success-fg',
    dot: 'bg-success-fg',
    bar: 'bg-success-fg',
  },
  info: {
    bg: 'bg-info-bg',
    border: 'border-info-fg/25',
    text: 'text-info-fg',
    dot: 'bg-info-fg',
    bar: 'bg-info-fg',
  },
  brand: {
    bg: 'bg-primary-50',
    border: 'border-primary-100',
    text: 'text-primary-text',
    dot: 'bg-primary-500',
    bar: 'bg-primary-500',
  },
  neutral: {
    bg: 'bg-surface-2',
    border: 'border-border',
    text: 'text-ink-muted',
    dot: 'bg-ink-subtle',
    bar: 'bg-ink-subtle',
  },
  // Function-coded accents (patients/doctors/admissions) — the pastel accent-* /
  // therapy pairs in shared/design-system.css. Never used for STATUS, only
  // for coloring a section's own icon by what it's about.
  teal: {
    bg: 'bg-accent-teal',
    border: 'border-accent-teal-fg/25',
    text: 'text-accent-teal-fg',
    dot: 'bg-accent-teal-fg',
    bar: 'bg-accent-teal-fg',
  },
  indigo: {
    bg: 'bg-accent-indigo',
    border: 'border-accent-indigo-fg/25',
    text: 'text-accent-indigo-fg',
    dot: 'bg-accent-indigo-fg',
    bar: 'bg-accent-indigo-fg',
  },
  purple: {
    bg: 'bg-therapy-bg',
    border: 'border-therapy-fg/25',
    text: 'text-therapy-fg',
    dot: 'bg-therapy-fg',
    bar: 'bg-therapy-fg',
  },
  cyan: {
    bg: 'bg-accent-cyan',
    border: 'border-accent-cyan-fg/25',
    text: 'text-accent-cyan-fg',
    dot: 'bg-accent-cyan-fg',
    bar: 'bg-accent-cyan-fg',
  },
  rose: {
    bg: 'bg-accent-rose',
    border: 'border-accent-rose-fg/25',
    text: 'text-accent-rose-fg',
    dot: 'bg-accent-rose-fg',
    bar: 'bg-accent-rose-fg',
  },
}

/** The hue token behind each tone (`--color-hue-*` in shared/design-system.css)
 *  — shared by IconBadge and Card so their tints, gradients and glows mix
 *  from the same softened hues as the figures and chips. `neutral` has no
 *  accent by design. */
export const TONE_VAR: Partial<Record<Tone, string>> = {
  critical: 'hue-red',
  warning: 'hue-amber',
  stable: 'hue-green',
  info: 'hue-blue',
  teal: 'hue-teal',
  indigo: 'hue-indigo',
  purple: 'hue-violet',
  cyan: 'hue-cyan',
  rose: 'hue-pink',
  brand: 'hue-blue',
}

// One colour language for every status in the app:
//   red (critical)  — critical, failed, emergency
//   yellow (warning) — needs attention: pending, partial, running late, overdue
//   blue (info)     — normal, in progress: confirmed, checked in, admitted, in queue
//   green (stable)  — paid, available, linked
//   grey (neutral)  — closed or not applicable: completed, cancelled, discharged
const STATUS_TONE: Record<string, Tone> = {
  Emergency: 'critical',
  'Under Review': 'warning',
  New: 'info',
  Stable: 'stable',
  Active: 'stable',
  Connected: 'stable',
  Completed: 'neutral',
  Scheduled: 'info',
  Pending: 'warning',
  'Pending review': 'warning',
  Outstanding: 'warning',
  Unassigned: 'neutral',
  Eligible: 'stable',
  Indicated: 'stable',
  'Not eligible': 'neutral',
  'Not indicated': 'neutral',
  High: 'critical',
  Medium: 'warning',
  Low: 'neutral',
  // Front-office risk dot — see domain/patientSelectors.ts
  Watch: 'warning',
  Normal: 'info',

  // Front desk
  Waiting: 'info',
  Live: 'neutral',
  Forecast: 'brand',
  'Identity pending': 'warning',
  'Duplicate suspected': 'warning',
  'Checked-in': 'info',
  Linked: 'stable',
  'Not linked': 'neutral',
  'Consent pending': 'warning',
  Revoked: 'critical',

  // Appointment lifecycle
  'Payment Pending': 'warning',
  Confirmed: 'info',
  'In consultation': 'info',
  Cancelled: 'neutral',
  'No-show': 'warning',
  Booked: 'info',
  Called: 'info',

  // Derived doctor operational status — computed in domain/selectors.ts
  // (getDoctorStatus) from schedule + leave + breaks + queue state.
  Available: 'stable',
  'Running late': 'warning',
  'Fully booked': 'neutral',
  'On break': 'warning',
  'On leave': 'neutral',
  'Not scheduled': 'neutral',
  Inactive: 'neutral',
  Blocked: 'neutral',
  Issued: 'info',
  Returned: 'neutral',
  Overdue: 'warning',

  // Payment lifecycle — the display words from utils/billing.billDisplayStatus
  Paid: 'stable',
  Partial: 'warning',
  'Partially Paid': 'warning',
  Failed: 'critical',
  Refunded: 'info',

  // Estimate lifecycle — types/frontDesk.ts's EstimateStatus
  Draft: 'neutral',
  Saved: 'info',

  // Inpatients — types/admission.ts's BedStatus/AdmissionStatus
  Occupied: 'info',
  Reserved: 'warning',
  Maintenance: 'neutral',
  Admitted: 'info',
  'Bed Reserved': 'warning',
  Transferred: 'info',
  Discharged: 'neutral',
}

export function toneFor(status: string | null | undefined): Tone {
  if (!status) return 'neutral'
  return STATUS_TONE[status] ?? 'neutral'
}
