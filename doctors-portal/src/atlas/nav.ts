/**
 * UI_ATLAS.md GP-02 — the nav rail (Z2).
 *
 * "Module-level navigation, scoped to the user's capabilities — a module the
 * user cannot enter is ABSENT, NOT DISABLED."
 *
 * That rule is why the rail is computed from the signed-in persona's
 * capabilities rather than rendered from a static list with disabled items.
 */

import { can } from './personas'
import type { PersonaId } from './personas'
import type { NavSection } from './registry'

export interface NavItem {
  section: Exclude<NavSection, null>
  label: string
  /** Short label for the collapsed 64px icon rail and the phone tab bar. */
  short: string
  /** A lucide-react icon name. */
  icon: string
  /** Where the rail item lands. */
  to: string
  /** Capability required to enter. Absent from the rail without it. */
  permission: string
  /**
   * Behind "More". The brief's rule is that no core flow may depend on the
   * sidebar, which My Day satisfies by carrying the whole day and every
   * attention item itself. This goes one step further and demotes the two rail
   * items that are not day-to-day destinations for a general physician:
   * order-set governance, and the imaging worklist (a radiologist's home, and
   * reachable from every patient's record). GP-02 is untouched — these are
   * still present and still capability-scoped, just not surfaced by default.
   */
  secondary?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  {
    section: 'home',
    label: 'My Day',
    short: 'Home',
    icon: 'House',
    to: '/clinician',
    permission: 'ip.encounter.read',
  },
  {
    section: 'queue',
    label: 'OPD',
    short: 'OPD',
    icon: 'Users',
    to: '/op-queue',
    permission: 'op.encounter.read',
  },
  {
    section: 'inpatients',
    label: 'Inpatients',
    short: 'IP',
    icon: 'BedDouble',
    to: '/ip/patients',
    permission: 'ip.encounter.read',
  },
  {
    section: 'results',
    label: 'Results',
    short: 'Results',
    icon: 'FlaskConical',
    to: '/results/inbox',
    permission: 'result.read',
  },
  {
    section: 'orders',
    label: 'Orders',
    short: 'Orders',
    icon: 'ClipboardList',
    to: '/orders/sets',
    permission: 'order.write',
    secondary: true,
  },
  {
    section: 'discharge',
    label: 'Discharge',
    short: 'Disch',
    icon: 'DoorOpen',
    to: '/discharge/board',
    permission: 'ip.encounter.read',
  },
  {
    section: 'imaging',
    label: 'Imaging',
    short: 'Imaging',
    icon: 'Scan',
    to: '/radiology/worklist',
    permission: 'imaging.read',
    secondary: true,
  },
  {
    section: 'stroke',
    label: 'Stroke-AI Console',
    short: 'Stroke-AI',
    icon: 'Brain',
    to: '/stroke/ai-console',
    permission: 'stroke.case.read',
  },
  {
    section: 'telehealth',
    label: 'Telehealth',
    short: 'Tele',
    icon: 'Video',
    to: '/tele/queue',
    permission: 'tele.write',
  },
  {
    section: 'assistant',
    label: 'Assistant',
    short: 'Ask',
    icon: 'MessageSquare',
    to: '/assistant/clinician',
    permission: 'op.encounter.read',
  },
]

/**
 * The rail for a given persona. Items the persona cannot enter are omitted
 * entirely — never greyed — per GP-02.
 */
export function navFor(persona: PersonaId): NavItem[] {
  return NAV_ITEMS.filter((item) => can(persona, item.permission))
}

/** The rail, split into what is surfaced and what sits behind "More". */
export function navGroupsFor(persona: PersonaId): { primary: NavItem[]; secondary: NavItem[] } {
  const items = navFor(persona)
  return {
    primary: items.filter((i) => !i.secondary),
    secondary: items.filter((i) => i.secondary),
  }
}

/**
 * The stroke personas land in the stroke centre and have no outpatient clinic,
 * so their assistant is the stroke one. §M-28.1: "'What can I usefully ask'
 * differs completely by portal" — the bubble picks the assistant by who is
 * asking, not by what they pick.
 */
export function assistantRouteFor(persona: PersonaId): string {
  switch (persona) {
    case 'P-35':
    case 'P-36':
    case 'P-38':
      return '/assistant/stroke'
    default:
      return '/assistant/clinician'
  }
}

export function assistantScreenFor(persona: PersonaId): string {
  return assistantRouteFor(persona) === '/assistant/stroke' ? 'S-28-09' : 'S-28-02'
}
