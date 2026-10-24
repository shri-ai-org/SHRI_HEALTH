import { CalendarDays, CreditCard, FlaskConical, FolderHeart, GraduationCap, House, Mail, Pill, UserRound, Video } from 'lucide-react'

/** Each portal area's colour (classes in portal.css) and icon, used by the page banner and home cards. */
export interface Accent {
  className: string
  icon: typeof House
}

const AREAS: Array<[prefixes: string[], accent: Accent]> = [
  [['/test-results'], { className: 'accent-results', icon: FlaskConical }],
  [['/health-issues', '/health-trends', '/allergies', '/immunizations', '/patient-documents', '/reports', '/document-templates'], { className: 'accent-health', icon: FolderHeart }],
  [['/appointments', '/visit-summaries'], { className: 'accent-appointments', icon: CalendarDays }],
  [['/messages'], { className: 'accent-messages', icon: Mail }],
  [['/prescriptions'], { className: 'accent-prescriptions', icon: Pill }],
  [['/billing'], { className: 'accent-billing', icon: CreditCard }],
  [['/video-consult'], { className: 'accent-video', icon: Video }],
  [['/patient-education'], { className: 'accent-education', icon: GraduationCap }],
  [['/demographics', '/e-signature', '/change-password'], { className: 'accent-account', icon: UserRound }],
]

const BRAND: Accent = { className: 'accent-brand', icon: House }

export function accentFor(path: string): Accent {
  for (const [prefixes, accent] of AREAS) {
    if (prefixes.some((p) => path === p || path.startsWith(`${p}/`))) return accent
  }
  return BRAND
}
