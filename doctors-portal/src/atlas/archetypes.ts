/**
 * UI_ATLAS.md §10.1 — screen archetypes. 28 allocated, ARC-29…ARC-34 reserved.
 * Every screen declares exactly one.
 *
 * Listed in the atlas's own order: by usage, which is also the recommended
 * build order. "ARC-15 and ARC-01 together account for 75 of 256 screens."
 */

import type { ZoneId } from './zones'
import type { AIPattern } from './patterns'

export const ARCHETYPES = [
  'ARC-01',
  'ARC-02',
  'ARC-03',
  'ARC-04',
  'ARC-05',
  'ARC-06',
  'ARC-07',
  'ARC-08',
  'ARC-09',
  'ARC-10',
  'ARC-11',
  'ARC-12',
  'ARC-13',
  'ARC-14',
  'ARC-15',
  'ARC-16',
  'ARC-17',
  'ARC-18',
  'ARC-19',
  'ARC-20',
  'ARC-21',
  'ARC-22',
  'ARC-23',
  'ARC-24',
  'ARC-25',
  'ARC-26',
  'ARC-27',
  'ARC-28',
] as const
export type ArchetypeId = (typeof ARCHETYPES)[number]

export interface ArchetypeSpec {
  id: ArchetypeId
  name: string
  /** Screens in the full 270-screen product that use it. */
  usage: number
  zones: ZoneId[]
  /** The canonical AI slot for this layout shape. */
  aiSlot: AIPattern[]
  /** The layout shape it implies. */
  shape: string
  /** True where the atlas strips the shell: no Z1, no Z2, no assistant bubble. */
  bare?: boolean
}

export const ARCHETYPE_SPECS: Record<ArchetypeId, ArchetypeSpec> = {
  'ARC-15': {
    id: 'ARC-15',
    name: 'Form / single-page capture',
    usage: 41,
    zones: ['Z4', 'Z5', 'Z7a'],
    aiSlot: ['AIP-01', 'AIP-02'],
    shape:
      'Z4 title plus primary actions; Z5 field groups, one column at <=1024px and two above; Z7a sticky save bar with an autosave timestamp; Z8 for confirm and reason dialogs. Validation on blur, never on keystroke.',
  },
  'ARC-01': {
    id: 'ARC-01',
    name: 'Worklist / queue',
    usage: 34,
    zones: ['Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-07', 'AIP-06'],
    shape:
      'Z4 title, filter chips, sort control; Z5 table with a sticky header and a row-count line; Z6 optional preview of the selected row. The current sort is always named in the header and is one click from deterministic.',
  },
  'ARC-03': {
    id: 'ARC-03',
    name: 'Multi-step wizard',
    usage: 18,
    zones: ['Z4', 'Z5', 'Z7a'],
    aiSlot: ['AIP-02', 'AIP-09'],
    shape: 'C-27 progress stepper in Z4; one step per Z5 panel; gate before submit.',
  },
  'ARC-18': {
    id: 'ARC-18',
    name: 'Master-data CRUD, effective-dated',
    usage: 15,
    zones: ['Z4', 'Z5', 'Z8'],
    aiSlot: ['AIP-03'],
    shape: 'Z4 search plus an "effective on" date picker and add; Z5 table of effective-dated rows; Z8 add/edit modal.',
  },
  'ARC-04': {
    id: 'ARC-04',
    name: 'Board / kanban',
    usage: 14,
    zones: ['Z4', 'Z5'],
    aiSlot: ['AIP-06', 'AIP-05'],
    shape:
      'Z4 title, facility/ward scope, legend, "as of" timestamp; Z5 columns by state with cards by entity. No Z6 — detail opens in Z8 or expands in place. A drag that violates a hard rule is refused with an inline reason on the target, never silently reverted.',
  },
  'ARC-06': {
    id: 'ARC-06',
    name: 'Flowsheet / charting grid',
    usage: 14,
    zones: ['Z3', 'Z4', 'Z5', 'Z7a'],
    aiSlot: ['AIP-05', 'AIP-02'],
    shape: 'Time across, parameters down. Tabular figures mandatory. Night theme mandatory.',
  },
  'ARC-20': {
    id: 'ARC-20',
    name: 'Dashboard / tile grid',
    usage: 14,
    zones: ['Z4', 'Z5'],
    aiSlot: ['AIP-06', 'AIP-04'],
    shape: 'Z4 scope selector, period, refresh state; Z5 a C-24 stat tile grid.',
  },
  'ARC-08': {
    id: 'ARC-08',
    name: 'Approval queue',
    usage: 13,
    zones: ['Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-07', 'AIP-03'],
    shape: 'Ranked queue plus a recommended disposition per item.',
  },
  'ARC-19': {
    id: 'ARC-19',
    name: 'Report viewer with parameters',
    usage: 11,
    zones: ['Z4', 'Z5'],
    aiSlot: ['AIP-04', 'AIP-05'],
    shape: 'Parameter bar in Z4; the rendered report in Z5, exportable.',
  },
  'ARC-24': {
    id: 'ARC-24',
    name: 'Barcode-scan transaction',
    usage: 10,
    zones: ['Z4', 'Z5', 'Z8'],
    aiSlot: ['AIP-09'],
    shape: 'Scan-first, keyed fallback never removed. Mismatch opens a gate.',
  },
  'ARC-02': {
    id: 'ARC-02',
    name: 'Record detail with tabs',
    usage: 8,
    zones: ['Z3', 'Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-04'],
    shape: 'Z3 patient banner; Z4 breadcrumb, title, status chips, C-28 tabs; Z5 active tab panel; Z6 context/summary rail.',
  },
  'ARC-05': {
    id: 'ARC-05',
    name: 'Scheduler grid',
    usage: 7,
    zones: ['Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-03'],
    shape: 'Resources down, time across; C-22 cells.',
  },
  'ARC-07': {
    id: 'ARC-07',
    name: 'Order entry / basket',
    usage: 7,
    zones: ['Z3', 'Z4', 'Z5', 'Z6', 'Z7a'],
    aiSlot: ['AIP-03', 'AIP-09'],
    shape:
      'Z5 catalogue and search; Z6 the basket; Z7a commit bar. Safety checks run BEFORE commit, and a hard stop is deterministic.',
  },
  'ARC-09': {
    id: 'ARC-09',
    name: 'Reconciliation / two-column match',
    usage: 6,
    zones: ['Z4', 'Z5', 'Z7a'],
    aiSlot: ['AIP-02'],
    shape: 'Source on the left, target on the right, a proposed match per row.',
  },
  'ARC-14': {
    id: 'ARC-14',
    name: 'Checklist runner',
    usage: 6,
    zones: ['Z3', 'Z4', 'Z5', 'Z7a'],
    aiSlot: ['AIP-02', 'AIP-05'],
    shape: 'One item per row, blockers banner-surfaced, completion gated on every item.',
  },
  'ARC-10': {
    id: 'ARC-10',
    name: 'Document viewer / annotator',
    usage: 5,
    zones: ['Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-01'],
    shape: 'Document in Z5, drafted narrative and annotations in Z6.',
  },
  'ARC-11': {
    id: 'ARC-11',
    name: 'Imaging viewer',
    usage: 4,
    zones: ['Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-02', 'AIP-05'],
    shape: 'Image fills Z5 on a dark field; AI overlay is a toggle; findings in Z6. Night theme mandatory.',
  },
  'ARC-12': {
    id: 'ARC-12',
    name: 'Command wall',
    usage: 4,
    zones: ['Z5'],
    aiSlot: ['AIP-06', 'AIP-05'],
    shape:
      'Z5 only. No Z1, no Z2, no input affordances, no Z7b bubble. Read at 3-4 metres, runs unattended for a shift, read-only. A stale wall dims and states its last-good timestamp in large type. It must also work on a phone.',
    bare: true,
  },
  'ARC-13': {
    id: 'ARC-13',
    name: 'Clock / timer panel',
    usage: 3,
    zones: ['Z3', 'Z4', 'Z5'],
    aiSlot: ['AIP-05'],
    shape: 'C-26 clock rings plus C-25 timer chips; a projected-breach strip when a target will be missed.',
  },
  'ARC-16': {
    id: 'ARC-16',
    name: 'Signature & consent capture',
    usage: 3,
    zones: ['Z5', 'Z8'],
    aiSlot: ['AIP-09'],
    shape:
      'Attestation gate. C-18 supports draw, Aadhaar eSign, DSC and thumb-impression-with-witness as PEERS, not fallbacks.',
  },
  'ARC-17': {
    id: 'ARC-17',
    name: 'Search & pick',
    usage: 3,
    zones: ['Z4', 'Z5'],
    aiSlot: ['AIP-07', 'AIP-04'],
    shape: 'Query in Z4, ranked results in Z5.',
  },
  'ARC-21': {
    id: 'ARC-21',
    name: 'Conversational / thread',
    usage: 3,
    zones: ['Z4', 'Z5'],
    aiSlot: ['AIP-04'],
    // "the archetype IS the AI"
    shape: 'Z4 header with scope; Z5 a C-40 thread; a composer at the foot. The archetype is the AI.',
  },
  'ARC-25': {
    id: 'ARC-25',
    name: 'Timeline / chart review',
    usage: 3,
    zones: ['Z3', 'Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-04', 'AIP-06'],
    shape: 'Chronological spine in Z5 with filters in Z4 and a summary in Z6.',
  },
  'ARC-22': {
    id: 'ARC-22',
    name: 'Video session',
    usage: 2,
    zones: ['Z5', 'Z6'],
    aiSlot: ['AIP-01'],
    shape: 'Video fills Z5; live transcript and drafted note in Z6.',
  },
  'ARC-23': {
    id: 'ARC-23',
    name: 'Map / dispatch',
    usage: 2,
    zones: ['Z4', 'Z5', 'Z6'],
    aiSlot: ['AIP-03'],
    shape: 'Map in Z5, inbound list and routing recommendation in Z6.',
  },
  'ARC-26': {
    id: 'ARC-26',
    name: 'Comparison / variance',
    usage: 2,
    zones: ['Z4', 'Z5'],
    aiSlot: ['AIP-05'],
    shape: 'Two datasets side by side with the variance called out.',
  },
  'ARC-27': {
    id: 'ARC-27',
    name: 'Payment & collection (digital modes only)',
    usage: 2,
    zones: ['Z3', 'Z4', 'Z5', 'Z7a'],
    aiSlot: ['AIP-02'],
    shape: 'UPI, QR, card, POS, netbanking. No cash tender, no drawer, no denomination count (A10).',
  },
  'ARC-28': {
    id: 'ARC-28',
    name: 'Kiosk / quick-capture',
    usage: 2,
    zones: ['Z5'],
    aiSlot: ['AIP-02', 'AIP-10'],
    shape: 'Z5 only. Large targets, no staff assistant surface.',
    bare: true,
  },
}
