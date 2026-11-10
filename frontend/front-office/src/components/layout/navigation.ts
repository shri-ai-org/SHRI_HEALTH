import type { LucideIcon } from 'lucide-react'
import {
  ChartNoAxesCombined,
  FileWarning,
  IdCard,
  IndianRupee,
  LayoutGrid,
  Receipt,
  Users,
} from 'lucide-react'
import type { IconTone } from '../../utils/toneHex'

// The shell never hard-codes menus (DESIGN_SYSTEM §8.4): the sidebar, the
// tablet rail and the phone's scrolling nav row all render from this one
// list. Places only — actions (register, schedule, admit, discharge,
// collect) start from the app-bar search or a patient's profile.

export interface NavItem {
  label: string
  path: string
  icon: LucideIcon
  /** Match the path exactly (the dashboard at "/"). */
  end?: boolean
  /** One line saying what the place holds. */
  description: string
  /** The destination's own hue: its glyph, tile and headings use it. */
  hue: IconTone
}

export interface NavGroup {
  /** A heading for the group; the plain places have none. */
  label?: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', path: '/', icon: LayoutGrid, end: true, hue: 'blue', description: "Today's desk at a glance" },
      // One place for patients — everyone, outpatients and inpatients are its
      // tabs, and a patient's profile lives under it too.
      { label: 'Patients', path: '/patients', icon: Users, hue: 'teal', description: 'Everyone, outpatients and inpatients' },
      { label: 'Payments', path: '/billing', icon: IndianRupee, hue: 'amber', description: 'Whether each patient’s bill is pending or paid at the billing counter' },
      { label: 'Activity & Analytics', path: '/activity-analytics', icon: ChartNoAxesCombined, hue: 'violet', description: 'Desk activity, trends and performance' },
    ],
  },
  {
    label: 'Services',
    items: [
      { label: 'Guest Pass', path: '/services/guest-pass', icon: IdCard, hue: 'pink', description: 'Passes for visitors and attendants' },
      { label: 'Enquiry & Estimate', path: '/services/enquiry', icon: Receipt, hue: 'orange', description: 'Service rates and cost estimates' },
      { label: 'MLC', path: '/services/mlc', icon: FileWarning, hue: 'red', description: 'Medico-legal case records' },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/** Does `pathname` belong to this destination? */
export function isActivePath(item: Pick<NavItem, 'path' | 'end'>, pathname: string): boolean {
  if (item.end) return pathname === item.path
  return pathname === item.path || pathname.startsWith(`${item.path}/`)
}

// Document titles: `${pageTitle} · SHRI HEALTH`, longest-prefix match.
const ROUTE_TITLES: [string, string][] = [
  ['/patients/outpatients', 'Outpatients'],
  ['/patients/inpatients', 'Inpatients'],
  ['/patients/', 'Patient profile'],
  ['/patients', 'Patients'],
  ['/register/new', 'Register Patient'],
  ['/doctors/register', 'Register Doctor'],
  ['/doctors/', 'Doctor profile'],
  ['/doctors', 'Doctors'],
  ['/billing', 'Payments'],
  ['/payments/', 'Bill'],
  ['/activity-analytics', 'Activity & Analytics'],
  ['/services/guest-pass/print', 'Print Guest Pass'],
  ['/services/guest-pass', 'Guest Pass'],
  ['/services/enquiry', 'Enquiry & Estimate'],
  ['/services/mlc', 'MLC'],
]

export function pageTitleFor(pathname: string): string {
  if (pathname === '/') return 'Dashboard'
  const match = ROUTE_TITLES.filter(([prefix]) => pathname.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0]
  return match ? match[1] : 'Care Entry'
}
