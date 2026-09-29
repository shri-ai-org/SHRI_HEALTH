/**
 * UI_ATLAS.md §3 — personas and the permission model.
 *
 * Three rules from §3.2, carried unchanged, that every Permission line depends on:
 *   1. No authorization check compares a role name. Enforcement reads
 *      CAPABILITIES. "P-04 Consultant is a persona label for humans reading
 *      this document; the system checks `ip.note.write`, never
 *      `role == consultant`."
 *   2. Every decision is evaluated within a subject scope. "May Dr. Iyer read a
 *      chart" is not a question. "May Dr. Iyer read THIS patient's chart" is.
 *   3. Default is deny, evaluated at request time — never baked into a token.
 *
 * Only the eleven doctor personas exist in this build; the other 34 are out of
 * scope for a doctors portal.
 */

/** §3.2 — the closed verb set. Capability names are `<domain>.<object>.<verb>`. */
export const VERBS = [
  'read',
  'write',
  'sign',
  'cosign',
  'amend',
  'cancel',
  'approve',
  'override',
  'admin',
  'export',
] as const
export type Verb = (typeof VERBS)[number]

/** §3.2 — the four (plus one) scope qualifiers a capability is evaluated against. */
export const SCOPES = ['self', 'relationship', 'unit', 'facility', 'group'] as const
export type Scope = (typeof SCOPES)[number]

export const PERSONAS = ['P-04', 'P-05', 'P-06', 'P-13', 'P-35', 'P-36', 'P-38'] as const
export type PersonaId = (typeof PERSONAS)[number]

/** Personas referenced in screen specs but not selectable in this build. */
export type ReferencedPersonaId =
  | PersonaId
  | 'P-02'
  | 'P-03'
  | 'P-07'
  | 'P-08'
  | 'P-09'
  | 'P-10'
  | 'P-11'
  | 'P-12'
  | 'P-14'
  | 'P-16'
  | 'P-17'
  | 'P-18'
  | 'P-19'
  | 'P-21'
  | 'P-22'
  | 'P-24'
  | 'P-25'
  | 'P-26'
  | 'P-27'
  | 'P-33'
  | 'P-37'
  | 'P-39'
  | 'P-40'
  | 'P-41'
  | 'P-44'

export interface PersonaSpec {
  id: PersonaId
  name: string
  /** Role in one line. */
  role: string
  /** Atlas layer. */
  layer: string
  /** §5.4 — density is a typographic token. */
  density: 'compact' | 'comfortable'
  /** The device the atlas says they actually use. */
  device: string
  /** §5.3 — P-13 radiologists get night as the default, not an option. */
  nightByDefault: boolean
  /** Capabilities held. Default deny: anything absent here is refused. */
  capabilities: string[]
  /** The screen this persona lands on at sign-in. */
  landing: string
  /** Shown in the persona switcher so the gating consequence is legible. */
  note?: string
}

/**
 * The capability sets are deliberately narrow. The one that carries the most
 * weight in the UI is P-05's: it holds `note.write` but NOT `note.sign`, so on
 * the authoring screens the primary action becomes "Save for co-sign" and the
 * entry lands in the consultant's queue as `Co-sign pending` (CMP-NABH-03).
 */
export const PERSONA_SPECS: Record<PersonaId, PersonaSpec> = {
  'P-04': {
    id: 'P-04',
    name: 'Consultant / Specialist',
    role: 'Attending physician — authors, signs, prescribes; owns the OP clinical workspace',
    layer: 'C · Clinical core',
    density: 'compact',
    device: 'Tablet + desktop',
    nightByDefault: false,
    capabilities: [
      'op.encounter.read',
      'ip.encounter.read',
      'op.note.write',
      'op.note.sign',
      'op.note.amend',
      'ip.note.write',
      'ip.note.sign',
      'ip.note.amend',
      'note.cosign',
      'rx.write',
      'rx.sign',
      'rx.override',
      'order.write',
      'order.sign',
      'order.cancel',
      'result.read',
      /*
       * READ ONLY. A hub consultant receives stroke transfers and is asked to
       * look at the console; activating a code stroke, dosing thrombolysis and
       * selecting for thrombectomy all stay with the stroke personas.
       */
      'stroke.case.read',
      'result.approve',
      'problem.write',
      'discharge.write',
      'discharge.sign',
      'template.write',
      'schedule.write',
      'referral.read',
      'imaging.read',
      'tele.write',
      'tele.sign',
      'adr.write',
      'record.export',
    ],
    landing: '/clinician',
  },
  'P-05': {
    id: 'P-05',
    name: 'Resident / Junior Doctor',
    role: 'Junior doctor — may author but not sign; entries queue for consultant co-sign',
    layer: 'C · Clinical core',
    density: 'compact',
    device: 'Phone + ward desktop',
    nightByDefault: false,
    capabilities: [
      'op.encounter.read',
      'ip.encounter.read',
      'op.note.write',
      'ip.note.write',
      'order.write',
      'result.read',
      'problem.write',
      'discharge.write',
      'imaging.read',
    ],
    landing: '/clinician',
    // The atlas is explicit: "P-05 holds note.write but not note.sign for the
    // classes requiring a consultant. Their entries land in S-06-09 as
    // `Co-sign pending` (CMP-NABH-03)."
    note: 'Cannot sign. Sign becomes "Save for co-sign"; no prescribing.',
  },
  'P-06': {
    id: 'P-06',
    name: 'Emergency Physician',
    role: 'ED attending — triage-to-disposition decision maker',
    layer: 'C · Clinical core',
    density: 'compact',
    device: 'Wall display + workstation',
    nightByDefault: false,
    capabilities: [
      'op.encounter.read',
      'ip.encounter.read',
      'ed.encounter.read',
      'ed.encounter.write',
      'ed.note.sign',
      'ed.disposition.write',
      'order.write',
      'order.sign',
      'rx.write',
      'rx.sign',
      'result.read',
      'stroke.activate',
      'stroke.case.read',
      'mlc.write',
      'imaging.read',
      'patient.breakglass',
    ],
    landing: '/ed/board',
    note: 'Can activate a code stroke. Break-glass without a prior relationship.',
  },
  'P-13': {
    id: 'P-13',
    name: 'Radiologist',
    role: 'Imaging physician — reads studies, dictates reports, escalates critical findings',
    layer: 'D · Diagnostics',
    density: 'compact',
    device: 'Diagnostic workstation, 2–3 screens',
    // §3.3 — "Night theme is the default, not an option; no large white fields."
    nightByDefault: true,
    capabilities: [
      'imaging.read',
      'imaging.study.read',
      'imaging.report.write',
      'imaging.report.sign',
      'imaging.critical.escalate',
      'op.encounter.read',
      'result.read',
      'stroke.case.read',
      'stroke.aspects.write',
    ],
    landing: '/radiology/worklist',
    note: 'Night theme is the default for this persona, not an option.',
  },
  'P-35': {
    id: 'P-35',
    name: 'Stroke Neurologist (hub, on-call)',
    role: 'Hub neurologist — telestroke, thrombolysis decision',
    layer: 'E · Flagship',
    density: 'compact',
    // The only persona whose primary device is a phone at 02:00.
    device: 'Phone first, then desktop',
    nightByDefault: true,
    capabilities: [
      'stroke.case.read',
      'stroke.case.write',
      'stroke.thrombolysis.sign',
      'stroke.transfer.approve',
      'stroke.telestroke.write',
      'stroke.nihss.write',
      'op.encounter.read',
      'ip.encounter.read',
      'order.write',
      'order.sign',
      'rx.write',
      'rx.sign',
      'result.read',
      'imaging.read',
      'patient.breakglass',
    ],
    landing: '/stroke/wall',
    note: 'Phone-first, wall-second — the inverse of every other persona.',
  },
  'P-36': {
    id: 'P-36',
    name: 'Neuro-Interventionist',
    role: 'EVT / cath-lab physician — perfusion review and EVT selection',
    layer: 'E · Flagship',
    density: 'compact',
    device: 'Tablet + cath lab console',
    nightByDefault: true,
    capabilities: [
      'stroke.case.read',
      'stroke.evt.write',
      'stroke.evt.sign',
      'imaging.read',
      'op.encounter.read',
      'ip.encounter.read',
      'result.read',
    ],
    landing: '/stroke/wall',
  },
  'P-38': {
    id: 'P-38',
    name: 'Spoke-Site Physician',
    role: 'Remote-site doctor — often a general physician, alone, on poor bandwidth',
    layer: 'E · Flagship',
    // Comfortable, not compact: the atlas gives the spoke a deliberately
    // simplified, larger console because of who is using it and when.
    density: 'comfortable',
    device: 'Desktop or phone',
    nightByDefault: true,
    capabilities: [
      'stroke.activate',
      'stroke.case.read',
      'stroke.case.write',
      'stroke.thrombolysis.write',
      'stroke.nihss.write',
      'op.encounter.read',
      'order.write',
      'result.read',
      'imaging.read',
    ],
    landing: '/stroke/spoke',
    note: 'Deliberately simplified console. Cannot sign a thrombolysis decision alone.',
  },
}

export const PERSONA_LIST: PersonaSpec[] = PERSONAS.map((id) => PERSONA_SPECS[id])

/**
 * §3.2 rule 3 — default is deny. There is no wildcard and no role shortcut.
 */
export function can(persona: PersonaId, capability: string): boolean {
  return PERSONA_SPECS[persona].capabilities.includes(capability)
}

/** True when this persona may commit a clinical entry to the legal record. */
export function canSignNotes(persona: PersonaId): boolean {
  return can(persona, 'op.note.sign') || can(persona, 'ip.note.sign') || can(persona, 'ed.note.sign')
}

/** True when this persona may prescribe. */
export function canPrescribe(persona: PersonaId): boolean {
  return can(persona, 'rx.sign')
}
