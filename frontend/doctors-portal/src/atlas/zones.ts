/**
 * UI_ATLAS.md §5.2 — the zone vocabulary. FROZEN, closed set of 8.
 *
 * "Eight zones, a closed set. A screen specification describes only the zones
 * it changes — `Z1 Z2 Z3 — no deviation` is a legal and very common line."
 */

export const ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7a', 'Z7b', 'Z8'] as const
export type ZoneId = (typeof ZONES)[number]

export interface ZoneSpec {
  id: ZoneId
  name: string
  source: string
  geometry: string
}

export const ZONE_SPECS: Record<ZoneId, ZoneSpec> = {
  Z1: {
    id: 'Z1',
    name: 'App bar',
    source: 'GP-01 — identical everywhere',
    geometry: '56px',
  },
  Z2: {
    id: 'Z2',
    name: 'Nav rail / sidebar',
    source: 'GP-02 — identical everywhere',
    geometry: '240px, 64px collapsed',
  },
  Z3: {
    id: 'Z3',
    name: 'Patient context banner',
    // "Z3 is the highest-leverage component in the product. It appears on ~150
    // screens, it is where a wrong-patient error is caught, and it is where the
    // deterioration risk strip lives."
    source: 'GP-05 — on every patient-scoped screen; specified once, never redesigned per screen',
    geometry: '64px, 2 lines; +48px with a risk strip',
  },
  Z4: {
    id: 'Z4',
    name: 'Page header — breadcrumb, title, status chips, primary actions',
    source: 'Per screen',
    geometry: '64px',
  },
  Z5: {
    id: 'Z5',
    name: 'Main content — Z5a, Z5b… for stacked or split regions',
    source: 'Per screen',
    geometry: 'Fills',
  },
  Z6: {
    id: 'Z6',
    name: 'Right rail — AI panel, context, timeline',
    source: 'Per screen',
    geometry: '320px, collapsible',
  },
  Z7a: {
    id: 'Z7a',
    name: 'Sticky action bar / footer',
    source: 'Per screen',
    geometry: '64px',
  },
  Z7b: {
    id: 'Z7b',
    name: 'Assistant bubble',
    source: 'GP-17 — global, §6.1, specified once and never re-specified in a screen block',
    // "It does not occupy a bar, a strip or any layout width — it floats above
    // Z7a, so it costs no vertical space on any screen."
    geometry: '56px floating bubble, bottom-right, 24px inset. NOT a bar.',
  },
  Z8: {
    id: 'Z8',
    name: 'Overlays — modal, drawer, toast, confirm',
    source: 'Per screen',
    geometry: 'Varies; renders above all zones including the expanded GP-17 panel',
  },
}

/**
 * §6.1 — a screen's spec carries exactly one line about Z7b: "GP-17, no
 * deviation", or it names its deviation. Only three dispositions exist across
 * all 270 screens.
 */
export type Z7bDisposition =
  /** The 247-screen default: the bubble is present, unmodified. */
  | 'GP-17'
  /** ARC-12 command walls and kiosks: "a wall has no operator at it". */
  | 'absent'
  /** The assistant screens themselves: the bubble is their entry point, not an element on them. */
  | 'n/a'
