/**
 * The mutable clinical record for this session.
 *
 * This is what makes the workflows walkable rather than illustrated: signing a
 * note removes it from the worklist and locks the screen, a resident's entry
 * appears in the consultant's co-sign queue, acknowledging a critical result
 * stops its escalation clock, and overriding a hard stop records both
 * identities.
 *
 * CMP-NABH-10 is enforced here, not just drawn: a signed entry is never
 * edited. `addendum()` is the only way to change one, and it appends.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { Problem, RxLine } from '@/data/clinical'

/** A problem added this session: the seeded list's shape, plus who added it and when. */
export type AddedProblem = Problem & { addedBy: string; addedAt: string }

export type NoteStatus = 'draft' | 'signed' | 'cosign-pending'

/**
 * Where a section's text came from. Only `'scribe'` is an AI DRAFT that needs a
 * C-41 disposition before the note can be signed; dictated text is the
 * clinician's own words transcribed (AI-101), and signing is its confirmation.
 */
export type SectionProvenance = 'typed' | 'dictated' | 'scribe' | 'carried'

export interface Addendum {
  id: string
  body: string
  by: string
  registrationNo: string
  at: string
}

export interface NoteRecord {
  encounterId: string
  /** Section text, by section key. Empty until the clinician dictates, types or accepts a draft. */
  text: Record<string, string>
  /** Per-section provenance. Absent ⇒ the section is untouched. */
  provenance: Record<string, SectionProvenance>
  status: NoteStatus
  signedBy?: string
  /** CMP-NABH-11 — stamped on sign, never typed. */
  registrationNo?: string
  signedAt?: string
  /** CMP-ABDM-03 — per-record publish status on the signed note. */
  publishStatus?: 'queued' | 'published' | 'failed'
  addenda: Addendum[]
  /** A draft save timestamp, shown in the Z7a bar. */
  savedAt?: string
  savedHow?: 'manual' | 'auto'
  /** The chosen ICD-10 leaf code — the truth for the coding field, however it was picked. */
  code?: string
  /** CMP-NABH-03 — the consultant who countersigned a registrar's entry, stamped alongside the author. */
  coSignedBy?: string
  coSignedRegistrationNo?: string
  coSignedAt?: string
  /** Sent back unsigned by the consultant, with what needs changing. Cleared when the author saves it again. */
  returned?: { by: string; at: string; comment: string }
}

/** A G4 override of one line's hard stop, with both identities, as §4.6 requires. */
export interface RxOverride {
  lineId: string
  reason: string
  reasonText?: string
  prescriber: string
  coSigner: string
  at: string
  auditEvent: string
}

/** The prescriber's change to one line. An absent field is the line as proposed. */
export interface RxLineEdit {
  dose?: string
  /** "Route · frequency", as the line's select offers it. */
  routeFrequency?: string
  durationDays?: number
  substitutionAllowed?: boolean
  instructions?: string
  /** A PRN line's stated 24-hour maximum (CMP-NABH-05). */
  maxDaily?: string
}

export interface RxRecord {
  encounterId: string
  status: 'draft' | 'signed'
  signedBy?: string
  registrationNo?: string
  signedAt?: string
  /** Lines the user removed from the proposed basket. */
  removedLines: string[]
  /** Alternatives accepted in place of a blocked drug. */
  substitutions: Record<string, string>
  /** The latest G4 override. */
  override?: RxOverride
  /** Every override, oldest first. Each clears only the line it was signed for. */
  overrides?: RxOverride[]
  /** Lines added from the formulary, kept with the prescription so what is signed is what was on the screen. */
  added?: RxLine[]
  /** The prescriber's changes, by line id. */
  edits?: Record<string, RxLineEdit>
  /** The last added line's number. Ids are never reused, so one line's decisions cannot pass to another. */
  lineSeq?: number
}

export interface CoSignOutcome {
  by: string
  at: string
  outcome: 'co-signed' | 'returned'
  /** What needs changing — recorded against a returned entry. */
  comment?: string
  patientId?: string
  documentKind?: string
}

/**
 * A patient discharged this session — the one record every discharge path
 * writes (S-13-01's board now; the discharge flow later). Under "discharge
 * now, sign later" the summary may still be unsigned; it then goes to the
 * sign queue, and the discharge stands.
 */
export interface DischargeRecord {
  patientId: string
  encounterId?: string
  at: string
  by: string
  /** `discharge` is home; the record's discharge flow adds a transfer out and leaving against medical advice. */
  kind: 'discharge' | 'transfer' | 'lama' | 'death'
  /** The bed released to the bed board. */
  bed?: string
  summarySigned: boolean
  /** Home: who the patient went home in the care of, if anyone was named. */
  careOf?: string
  followUp?: DischargeFollowUp
  transfer?: TransferOut
  lama?: LeftAgainstAdvice
}

/** A follow-up booked on discharge, or the recorded reason there is none. */
export type DischargeFollowUp = { kind: 'booked'; date: string; clinic: string; note: string } | { kind: 'none'; reason: string }

/** A transfer to another facility — who accepted the patient, why, and how they travel. */
export interface TransferOut {
  facility: string
  clinician: string
  reason: string
  escort: string
  transport: string
  handover: string
}

/** Leaving against medical advice — the form's signatory, the witness, and the reason given. */
export interface LeftAgainstAdvice {
  signedBy: string
  relationship: string
  witness: string
  reason: string
}

/**
 * S-13-06's Form 4 MCCD and the handover that follows it — every field the
 * old wizard asked for, kept, where it held most of them only on the screen
 * and some (the docket, the family, the identification, the belongings) not
 * at all.
 */
export interface DeathRecord {
  patientId: string
  encounterId: string
  /** As observed, 24-hour clock (a `datetime-local` value). */
  diedAt: string
  verifiedBy: string
  registrationNo: string
  familyInformed: string
  /** Part I, read downwards: (a) due to (b) due to (c). */
  causes: { a: string; b: string; c: string }
  /** Part II. */
  contributing: string
  mlc: boolean
  /** CMP-STAT-01 — the police station and docket, and the acknowledgement received. */
  police?: { stationDocket: string; acknowledged: boolean }
  handover: { releasedTo: string; identification: string; belongings: string }
  certifiedAt: string
}

/** S-13-03's four decisions per medicine line. */
export type MedRecDecision = 'continue' | 'changed' | 'stopped' | 'new'

/**
 * A discharge medicine reconciliation, kept with its encounter: the decision
 * on each line, the reason a stopped line needs, and who confirmed the list.
 * Once confirmed the list is fixed.
 */
export interface MedRecRecord {
  decisions: Record<string, MedRecDecision>
  reasons: Record<string, string>
  confirmedBy?: string
  confirmedAt?: string
}

export type OrderPriority = 'Routine' | 'Urgent' | 'Stat'

/** A line in S-09-01's basket — kept with the encounter, so leaving to check a result loses nothing. */
export interface BasketLine {
  id: string
  item: string
  priority: OrderPriority
  /** AI-304's duplicate warning, computed against existing orders at the moment of adding. */
  duplicateOf?: { id: string; placedAt: string; reason: string }
}

/** An order set made on S-06-10: personal scope until promoted — it has no review date of its own until then. */
export interface CreatedSet {
  id: string
  name: string
  scope: 'Personal'
  owner: string
  reviewDue: string
  items: string[]
  usedThisMonth: number
  /** From when this version is effective — the library "as it stood" on an earlier date does not have it. */
  createdAt: string
  createdBy: string
}

export type InstructionChannel = 'print' | 'app' | 'sms'

/** One issue of the instructions to the patient — what went out, how, in which language. */
export interface InstructionsIssue {
  at: string
  by: string
  channels: InstructionChannel[]
  language: string
  /** False where the document went out in English only, with the limitation stated. */
  translated: boolean
  /** The patient version as issued. */
  text: string
}

/** S-06-08 — what the patient is told, beside what the clinician wrote. */
export interface InstructionsRecord {
  encounterId: string
  /** The clinician's wording — the clinical record, exactly as said or written. */
  clinician: string
  /** What the patient reads. */
  patient: string
  /** Where the patient version came from: AI-111's rewrite (a G2 touchpoint) or the clinician's hand. */
  patientSource?: 'ai' | 'typed'
  channels: Record<InstructionChannel, boolean>
  /** Every issue, oldest first. */
  issued: InstructionsIssue[]
}

interface ClinicalState {
  notes: Record<string, NoteRecord>
  prescriptions: Record<string, RxRecord>
  /** Result ids acknowledged, with who and when. */
  acknowledgements: Record<string, { by: string; at: string; action?: string }>
  /**
   * A critical result handed to the clinician it belongs to (S-09-06's "Not me
   * — reassign"): a disposition, recorded, so closing the gate is never a way
   * round it. It stays unacknowledged — the escalation clock keeps running.
   */
  reassignedResults: Record<string, { to: string; by: string; at: string }>
  /** Co-sign queue items actioned this session — with the return comment, and whose entry it was. */
  coSigned: Record<string, CoSignOutcome>
  /** Orders placed from the basket this session. */
  placedOrders: { id: string; item: string; patientId: string; at: string; by: string; priority?: OrderPriority; encounterId?: string }[]
  /** S-09-01's baskets, by encounter; `seq` numbers the lines so no id is ever used twice. */
  orderBaskets: Record<string, { lines: BasketLine[]; seq: number }>
  /** Orders cancelled via a stewardship flag. */
  cancelledOrders: Record<string, { reason: string; at: string }>
  /** Order sets promoted to facility-wide — a governance act. */
  promotedSets: Record<string, { owner: string; reviewDue: string; at: string }>
  /** Order sets created on S-06-10, oldest first. */
  createdSets: CreatedSet[]
  /** Discharges this session, by patient — one per admission. */
  discharges: Record<string, DischargeRecord>
  medRecs: Record<string, MedRecRecord>
  deaths: Record<string, DeathRecord>
  /** Referrals triaged. */
  triagedReferrals: Record<string, { outcome: string; at: string }>
  /** Problems added to a patient's list this session, by patient — the seeded list is fixture data and stays as it is. */
  addedProblems: Record<string, AddedProblem[]>
  /** A problem's code confirmed, by problem id. */
  problemConfirmations: Record<string, { by: string; at: string }>
  /** The whole problem list confirmed for an encounter, by encounter id. */
  problemListConfirmed: Record<string, { by: string; at: string; codes: string[] }>
  /** S-06-08's instructions, by encounter id. */
  instructions: Record<string, InstructionsRecord>
  /** CMP-DPDP-02 — the language each patient reads, bound to the patient rather than the user. */
  patientLanguages: Record<string, string>
  /**
   * When this clinician last saw each patient. The "what changed since I last
   * saw them" cut-off — anything older than this is not a change.
   */
  seenAt: Record<string, string>
  /**
   * Mark-seen events held locally because the device is offline. §1.5's
   * OFFLINE rule: name what is queued, and never lose it.
   */
  pendingSeen: string[]
  /**
   * Dictated notes, per patient. The `'unattached'` key holds the doctor's own
   * to-do notes, which belong to no patient.
   */
  voiceNotes: Record<string, VoiceNote[]>

  setSectionText: (encounterId: string, key: string, text: string, provenance?: SectionProvenance) => void
  /**
   * Marks sections as AI-drafted by the scribe, so they need a disposition.
   * Text lands on Accept/Edit. A section the clinician has already dictated or
   * typed is LEFT ALONE — the scribe never overwrites the clinician's words.
   * `drafts`, when given, is what the scribe heard for each section: a key with
   * no drafted text is not marked, because there would be nothing to decide
   * on. The text itself is held by `useScribeDrafts` (data/scribe.ts), which
   * S-06-04 writes at the same moment, and it — not a seed — is the ghost.
   * Returns the keys it actually drafted.
   */
  applyScribeDraft: (encounterId: string, keys: string[], drafts?: Partial<Record<string, string>>) => string[]
  clearSection: (encounterId: string, key: string) => void
  setNoteCode: (encounterId: string, code: string | undefined) => void
  saveDraft: (encounterId: string, how?: 'manual' | 'auto') => void
  signNote: (args: { encounterId: string; by: string; registrationNo: string; canSign: boolean }) => NoteStatus
  addendum: (args: { encounterId: string; body: string; by: string; registrationNo: string }) => void
  setPublishStatus: (encounterId: string, status: NoteRecord['publishStatus']) => void

  signRx: (args: { encounterId: string; by: string; registrationNo: string }) => void
  /** Adds a formulary line and returns its id — or null, because a signed prescription is never edited. */
  addRxLine: (encounterId: string, line: Omit<RxLine, 'id'>) => string | null
  editRxLine: (encounterId: string, lineId: string, patch: RxLineEdit) => void
  removeRxLine: (encounterId: string, lineId: string) => void
  substitute: (encounterId: string, lineId: string, drug: string) => void
  overrideHardStop: (args: {
    encounterId: string
    lineId: string
    reason: string
    reasonText?: string
    prescriber: string
    coSigner: string
    auditEvent: string
  }) => void

  acknowledge: (resultId: string, by: string, action?: string) => void
  reassignResult: (resultId: string, to: string, by: string) => void
  coSign: (itemId: string, by: string, outcome: 'co-signed' | 'returned') => void
  /**
   * S-06-09's decision on an entry. A session note (with its encounter) moves
   * with it: co-signed, it is signed and stamped with both names; returned, it
   * goes back to the author's drafts with the comment against it.
   */
  resolveCoSign: (args: {
    itemId: string
    by: string
    registrationNo: string
    outcome: 'co-signed' | 'returned'
    comment?: string
    patientId: string
    documentKind: string
    encounterId?: string
  }) => void
  /** `at` is the build's own clock where the caller has it; the old screen let the store stamp it. */
  placeOrders: (items: { id: string; item: string; priority?: OrderPriority; encounterId?: string }[], patientId: string, by: string, at?: string) => void
  basketAdd: (encounterId: string, lines: Omit<BasketLine, 'id'>[]) => void
  basketUpdate: (encounterId: string, lineId: string, patch: Partial<Omit<BasketLine, 'id'>>) => void
  basketRemove: (encounterId: string, lineId: string) => void
  basketClear: (encounterId: string) => void
  cancelOrder: (orderId: string, reason: string) => void
  /** `at` is the build's own clock where the caller has it; the old screen let the store stamp it. */
  promoteSet: (setId: string, owner: string, reviewDue: string, at?: string) => void
  createSet: (set: Omit<CreatedSet, 'id'>) => CreatedSet
  /** Records a discharge; false, and nothing written, if the patient is already discharged. */
  dischargePatient: (record: DischargeRecord) => boolean
  /** A decision on one line, or null to undecide it; nothing changes once the list is confirmed. */
  setMedRecDecision: (encounterId: string, rowId: string, decision: MedRecDecision | null) => void
  setMedRecReason: (encounterId: string, rowId: string, reason: string) => void
  /** Fixes the list; false, and nothing written, if it already was. */
  confirmMedRec: (encounterId: string, by: string, at: string) => boolean
  /** Issues the MCCD; false, and nothing written, if this patient's death is already certified. */
  certifyDeath: (record: DeathRecord) => boolean
  triageReferral: (referralId: string, outcome: string) => void
  /**
   * `at` is passed in rather than read from the clock, because this build runs
   * on the frozen §8.6 moment. Stamping `new Date()` would put the marker in
   * 2026-real-time, ahead of every seeded delta, and clear badges by accident.
   */
  markSeen: (patientId: string, at: string, offline?: boolean) => void
  flushPendingSeen: (at: string) => void
  /** Returns the new note's id. */
  saveVoiceNote: (args: {
    patientId: string
    body: string
    by: string
    model: string
    band: string
  }) => string
  /** A patient's dictated draft becomes part of the record once signed. */
  signVoiceNote: (patientId: string, id: string, by: string) => void
  /** Rewrites a draft before it is signed; a signed note is never changed. */
  editVoiceNote: (patientId: string, id: string, body: string) => void
  /** Ticks a to-do note off (or back on). */
  toggleVoiceNoteDone: (patientId: string, id: string) => void
  deleteVoiceNote: (patientId: string, id: string) => void

  note: (encounterId: string) => NoteRecord
  rx: (encounterId: string) => RxRecord
  addProblem: (patientId: string, dx: { label: string; icd10: string }, by: string, at: string) => AddedProblem | null
  confirmProblem: (problemId: string, by: string, at: string) => void
  confirmProblemList: (encounterId: string, codes: string[], by: string, at: string) => void
  instructionsFor: (encounterId: string) => InstructionsRecord
  setInstructions: (encounterId: string, patch: Partial<Pick<InstructionsRecord, 'clinician' | 'patient' | 'patientSource' | 'channels'>>) => void
  issueInstructions: (encounterId: string, issue: InstructionsIssue) => void
  setPatientLanguage: (patientId: string, language: string) => void
  reset: () => void
}

/** The key that holds notes attached to no patient — the doctor's to-do list. */
export const UNATTACHED = 'unattached'

export interface VoiceNote {
  id: string
  body: string
  /** ISO timestamp of the save. */
  at: string
  by: string
  model: string
  band: string
  /** A patient's dictated note is a draft until signed. To-do notes stay drafts. */
  status: 'draft' | 'signed'
  signedAt?: string
  signedBy?: string
  /** To-do notes only: ticked off. */
  done?: boolean
  /** ISO timestamp of the last edit to the draft. */
  editedAt?: string
}

let voiceSeq = 0
function voiceId(): string {
  voiceSeq += 1
  return `VN-${Date.now().toString(36)}-${voiceSeq}`
}

/** Notes saved before ids and status existed are given both on load. */
function normaliseVoiceNotes(raw: unknown): Record<string, VoiceNote[]> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, VoiceNote[]> = {}
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    out[key] = list.map((n: Partial<VoiceNote>, i) => ({
      id: n.id ?? `VN-legacy-${key}-${i}`,
      body: n.body ?? '',
      at: n.at ?? new Date().toISOString(),
      by: n.by ?? '',
      model: n.model ?? '',
      band: n.band ?? 'MED',
      status: n.status ?? 'draft',
      signedAt: n.signedAt,
      signedBy: n.signedBy,
      done: n.done,
    }))
  }
  return out
}

function blankNote(encounterId: string): NoteRecord {
  return { encounterId, text: {}, provenance: {}, status: 'draft', addenda: [] }
}

function blankRx(encounterId: string): RxRecord {
  return { encounterId, status: 'draft', removedLines: [], substitutions: {} }
}

/** The old screen's channel defaults: the A5 print and the patient app on, SMS off. */
function blankInstructions(encounterId: string): InstructionsRecord {
  return { encounterId, clinician: '', patient: '', channels: { print: true, app: true, sms: false }, issued: [] }
}

export const useClinical = create<ClinicalState>()(
  persist(
    (set, get) => ({
      notes: {},
      prescriptions: {},
      acknowledgements: {},
      reassignedResults: {},
      coSigned: {},
      placedOrders: [],
      orderBaskets: {},
      cancelledOrders: {},
      promotedSets: {},
      createdSets: [],
      discharges: {},
      medRecs: {},
      deaths: {},
      triagedReferrals: {},
      seenAt: {},
      pendingSeen: [],
      voiceNotes: {},
      addedProblems: {},
      problemConfirmations: {},
      problemListConfirmed: {},
      instructions: {},
      patientLanguages: {},

      // A record persisted before provenance existed is normalised on read.
      note: (encounterId) => {
        const stored = get().notes[encounterId]
        return stored ? { ...blankNote(encounterId), ...stored, provenance: stored.provenance ?? {} } : blankNote(encounterId)
      },
      rx: (encounterId) => get().prescriptions[encounterId] ?? blankRx(encounterId),

      setSectionText: (encounterId, key, text, provenance) => {
        const current = get().note(encounterId)
        // CMP-NABH-10 — a signed note is never edited. Silently refusing would
        // be worse than the UI simply not offering it, which it does not.
        if (current.status === 'signed') return
        const prior = current.provenance[key]
        // An explicit provenance wins; otherwise the section keeps what it had;
        // text arriving in an untouched section was typed.
        const next = provenance ?? prior ?? (text.trim() === '' ? undefined : 'typed')
        const nextProvenance = { ...current.provenance }
        if (next === undefined) delete nextProvenance[key]
        else nextProvenance[key] = next
        set({
          notes: {
            ...get().notes,
            [encounterId]: { ...current, text: { ...current.text, [key]: text }, provenance: nextProvenance },
          },
        })
      },

      applyScribeDraft: (encounterId, keys, drafts) => {
        const current = get().note(encounterId)
        if (current.status === 'signed') return []
        const provenance = { ...current.provenance }
        const applied: string[] = []
        for (const k of keys) {
          if (drafts && (drafts[k] ?? '').trim() === '') continue
          const own = current.provenance[k]
          if ((current.text[k] ?? '').trim() !== '' && own !== undefined && own !== 'scribe') continue
          provenance[k] = 'scribe'
          applied.push(k)
        }
        set({ notes: { ...get().notes, [encounterId]: { ...current, provenance } } })
        return applied
      },

      clearSection: (encounterId, key) => {
        const current = get().note(encounterId)
        if (current.status === 'signed') return
        const text = { ...current.text }
        const provenance = { ...current.provenance }
        delete text[key]
        delete provenance[key]
        set({ notes: { ...get().notes, [encounterId]: { ...current, text, provenance } } })
      },

      setNoteCode: (encounterId, code) => {
        const current = get().note(encounterId)
        if (current.status === 'signed') return
        set({ notes: { ...get().notes, [encounterId]: { ...current, code } } })
      },

      saveDraft: (encounterId, how = 'manual') => {
        const current = get().note(encounterId)
        if (current.status === 'signed') return
        set({
          notes: {
            ...get().notes,
            [encounterId]: { ...current, savedAt: new Date().toISOString(), savedHow: how },
          },
        })
      },

      /**
       * `canSign` comes from the persona's capabilities. A resident holds
       * note.write but not note.sign, so their entry becomes `cosign-pending`
       * and lands in the consultant's queue (CMP-NABH-03).
       */
      signNote: ({ encounterId, by, registrationNo, canSign }) => {
        const current = get().note(encounterId)
        const status: NoteStatus = canSign ? 'signed' : 'cosign-pending'
        set({
          notes: {
            ...get().notes,
            [encounterId]: {
              ...current,
              status,
              signedBy: by,
              registrationNo,
              signedAt: new Date().toISOString(),
              publishStatus: canSign ? 'queued' : undefined,
              returned: undefined,
            },
          },
        })
        return status
      },

      addendum: ({ encounterId, body, by, registrationNo }) => {
        const current = get().note(encounterId)
        set({
          notes: {
            ...get().notes,
            [encounterId]: {
              ...current,
              addenda: [
                ...current.addenda,
                {
                  id: `AD-${current.addenda.length + 1}`,
                  body,
                  by,
                  registrationNo,
                  at: new Date().toISOString(),
                },
              ],
            },
          },
        })
      },

      setPublishStatus: (encounterId, publishStatus) => {
        const current = get().note(encounterId)
        set({ notes: { ...get().notes, [encounterId]: { ...current, publishStatus } } })
      },

      signRx: ({ encounterId, by, registrationNo }) => {
        const current = get().rx(encounterId)
        if (current.status === 'signed') return
        set({
          prescriptions: {
            ...get().prescriptions,
            [encounterId]: {
              ...current,
              status: 'signed',
              signedBy: by,
              registrationNo,
              signedAt: new Date().toISOString(),
            },
          },
        })
      },

      addRxLine: (encounterId, line) => {
        const current = get().rx(encounterId)
        if (current.status === 'signed') return null
        const seq = (current.lineSeq ?? 0) + 1
        const id = `RX-NEW-${seq}`
        set({
          prescriptions: {
            ...get().prescriptions,
            [encounterId]: { ...current, lineSeq: seq, added: [...(current.added ?? []), { ...line, id }] },
          },
        })
        return id
      },

      editRxLine: (encounterId, lineId, patch) => {
        const current = get().rx(encounterId)
        if (current.status === 'signed') return
        const edits = current.edits ?? {}
        set({
          prescriptions: {
            ...get().prescriptions,
            [encounterId]: { ...current, edits: { ...edits, [lineId]: { ...edits[lineId], ...patch } } },
          },
        })
      },

      removeRxLine: (encounterId, lineId) => {
        const current = get().rx(encounterId)
        if (current.status === 'signed' || current.removedLines.includes(lineId)) return
        set({
          prescriptions: {
            ...get().prescriptions,
            [encounterId]: { ...current, removedLines: [...current.removedLines, lineId] },
          },
        })
      },

      substitute: (encounterId, lineId, drug) => {
        const current = get().rx(encounterId)
        if (current.status === 'signed') return
        // The alternative arrives with its own dose, route and frequency: nothing typed for the blocked drug carries over.
        const edits = { ...current.edits }
        delete edits[lineId]
        set({
          prescriptions: {
            ...get().prescriptions,
            [encounterId]: {
              ...current,
              substitutions: { ...current.substitutions, [lineId]: drug },
              edits,
            },
          },
        })
      },

      overrideHardStop: ({ encounterId, lineId, reason, reasonText, prescriber, coSigner, auditEvent }) => {
        const current = get().rx(encounterId)
        if (current.status === 'signed') return
        const override: RxOverride = { lineId, reason, reasonText, prescriber, coSigner, at: new Date().toISOString(), auditEvent }
        set({
          prescriptions: {
            ...get().prescriptions,
            [encounterId]: { ...current, override, overrides: [...(current.overrides ?? []), override] },
          },
        })
      },

      acknowledge: (resultId, by, action) =>
        set({
          acknowledgements: {
            ...get().acknowledgements,
            [resultId]: { by, at: new Date().toISOString(), action },
          },
        }),

      reassignResult: (resultId, to, by) =>
        set({ reassignedResults: { ...get().reassignedResults, [resultId]: { to, by, at: new Date().toISOString() } } }),

      coSign: (itemId, by, outcome) =>
        set({
          coSigned: { ...get().coSigned, [itemId]: { by, at: new Date().toISOString(), outcome } },
        }),

      resolveCoSign: ({ itemId, by, registrationNo, outcome, comment, patientId, documentKind, encounterId }) => {
        const at = new Date().toISOString()
        const coSigned = { ...get().coSigned, [itemId]: { by, at, outcome, comment, patientId, documentKind } }
        const note = encounterId ? get().notes[encounterId] : undefined
        if (!encounterId || !note || note.status !== 'cosign-pending') {
          set({ coSigned })
          return
        }
        const next: NoteRecord =
          outcome === 'co-signed'
            ? { ...note, status: 'signed', coSignedBy: by, coSignedRegistrationNo: registrationNo, coSignedAt: at, publishStatus: 'queued' }
            : { ...note, status: 'draft', returned: { by, at, comment: comment ?? '' } }
        set({ coSigned, notes: { ...get().notes, [encounterId]: next } })
      },

      placeOrders: (items, patientId, by, at) =>
        set({
          placedOrders: [
            ...get().placedOrders,
            ...items.map((i) => ({ ...i, patientId, by, at: at ?? new Date().toISOString() })),
          ],
        }),

      basketAdd: (encounterId, lines) => {
        const basket = get().orderBaskets[encounterId] ?? { lines: [], seq: 0 }
        let seq = basket.seq
        const added = lines.map((l) => ({ ...l, id: `B-${++seq}` }))
        set({ orderBaskets: { ...get().orderBaskets, [encounterId]: { lines: [...basket.lines, ...added], seq } } })
      },

      basketUpdate: (encounterId, lineId, patch) => {
        const basket = get().orderBaskets[encounterId]
        if (!basket) return
        set({ orderBaskets: { ...get().orderBaskets, [encounterId]: { ...basket, lines: basket.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) } } })
      },

      basketRemove: (encounterId, lineId) => {
        const basket = get().orderBaskets[encounterId]
        if (!basket) return
        set({ orderBaskets: { ...get().orderBaskets, [encounterId]: { ...basket, lines: basket.lines.filter((l) => l.id !== lineId) } } })
      },

      basketClear: (encounterId) => {
        const basket = get().orderBaskets[encounterId]
        if (!basket) return
        set({ orderBaskets: { ...get().orderBaskets, [encounterId]: { ...basket, lines: [] } } })
      },

      cancelOrder: (orderId, reason) =>
        set({
          cancelledOrders: {
            ...get().cancelledOrders,
            [orderId]: { reason, at: new Date().toISOString() },
          },
        }),

      promoteSet: (setId, owner, reviewDue, at) =>
        set({
          promotedSets: {
            ...get().promotedSets,
            [setId]: { owner, reviewDue, at: at ?? new Date().toISOString() },
          },
        }),

      dischargePatient: (record) => {
        if (get().discharges[record.patientId]) return false
        set({ discharges: { ...get().discharges, [record.patientId]: record } })
        return true
      },

      setMedRecDecision: (encounterId, rowId, decision) => {
        const rec = get().medRecs[encounterId] ?? { decisions: {}, reasons: {} }
        if (rec.confirmedAt) return
        const decisions = { ...rec.decisions }
        if (decision) decisions[rowId] = decision
        else delete decisions[rowId]
        set({ medRecs: { ...get().medRecs, [encounterId]: { ...rec, decisions } } })
      },

      setMedRecReason: (encounterId, rowId, reason) => {
        const rec = get().medRecs[encounterId] ?? { decisions: {}, reasons: {} }
        if (rec.confirmedAt) return
        set({ medRecs: { ...get().medRecs, [encounterId]: { ...rec, reasons: { ...rec.reasons, [rowId]: reason } } } })
      },

      certifyDeath: (record) => {
        if (get().deaths[record.patientId]) return false
        set({ deaths: { ...get().deaths, [record.patientId]: record } })
        return true
      },

      confirmMedRec: (encounterId, by, at) => {
        const rec = get().medRecs[encounterId] ?? { decisions: {}, reasons: {} }
        if (rec.confirmedAt) return false
        set({ medRecs: { ...get().medRecs, [encounterId]: { ...rec, confirmedBy: by, confirmedAt: at } } })
        return true
      },

      createSet: (created) => {
        const made: CreatedSet = { ...created, id: `OS.NEW-${get().createdSets.length + 1}` }
        set({ createdSets: [...get().createdSets, made] })
        return made
      },

      triageReferral: (referralId, outcome) =>
        set({
          triagedReferrals: {
            ...get().triagedReferrals,
            [referralId]: { outcome, at: new Date().toISOString() },
          },
        }),

      /**
       * The UI updates optimistically either way; `offline` only decides
       * whether the write is recorded as still queued.
       */
      markSeen: (patientId, at, offline) =>
        set({
          seenAt: { ...get().seenAt, [patientId]: at },
          pendingSeen: offline
            ? get().pendingSeen.includes(patientId)
              ? get().pendingSeen
              : [...get().pendingSeen, patientId]
            : get().pendingSeen,
        }),

      flushPendingSeen: (at) => {
        const pending = get().pendingSeen
        if (pending.length === 0) return
        const seenAt = { ...get().seenAt }
        for (const id of pending) seenAt[id] = seenAt[id] ?? at
        set({ seenAt, pendingSeen: [] })
      },

      saveVoiceNote: ({ patientId, body, by, model, band }) => {
        const id = voiceId()
        set({
          voiceNotes: {
            ...get().voiceNotes,
            [patientId]: [
              ...(get().voiceNotes[patientId] ?? []),
              { id, body, at: new Date().toISOString(), by, model, band, status: 'draft' },
            ],
          },
        })
        return id
      },

      signVoiceNote: (patientId, id, by) =>
        set({
          voiceNotes: {
            ...get().voiceNotes,
            [patientId]: (get().voiceNotes[patientId] ?? []).map((n) =>
              n.id === id ? { ...n, status: 'signed', signedAt: new Date().toISOString(), signedBy: by } : n,
            ),
          },
        }),

      editVoiceNote: (patientId, id, body) =>
        set({
          voiceNotes: {
            ...get().voiceNotes,
            [patientId]: (get().voiceNotes[patientId] ?? []).map((n) => (n.id === id && n.status === 'draft' ? { ...n, body, editedAt: new Date().toISOString() } : n)),
          },
        }),

      toggleVoiceNoteDone: (patientId, id) =>
        set({
          voiceNotes: {
            ...get().voiceNotes,
            [patientId]: (get().voiceNotes[patientId] ?? []).map((n) => (n.id === id ? { ...n, done: !n.done } : n)),
          },
        }),

      deleteVoiceNote: (patientId, id) =>
        set({
          voiceNotes: {
            ...get().voiceNotes,
            [patientId]: (get().voiceNotes[patientId] ?? []).filter((n) => n.id !== id),
          },
        }),

      addProblem: (patientId, dx, by, at) => {
        // One entry per code per patient: adding a code the list already holds adds nothing.
        const existing = get().addedProblems[patientId] ?? []
        if (existing.some((pr) => pr.icd10 === dx.icd10)) return null
        const problem: AddedProblem = {
          id: `PR-${patientId}-${dx.icd10}`,
          patientId,
          label: dx.label,
          icd10: dx.icd10,
          snomed: '—',
          onset: at.slice(0, 10),
          status: 'Open',
          leaf: true,
          addedBy: by,
          addedAt: at,
        }
        set({ addedProblems: { ...get().addedProblems, [patientId]: [...existing, problem] } })
        return problem
      },

      confirmProblem: (problemId, by, at) => set({ problemConfirmations: { ...get().problemConfirmations, [problemId]: { by, at } } }),

      confirmProblemList: (encounterId, codes, by, at) => set({ problemListConfirmed: { ...get().problemListConfirmed, [encounterId]: { by, at, codes } } }),

      instructionsFor: (encounterId) => get().instructions[encounterId] ?? blankInstructions(encounterId),

      setInstructions: (encounterId, patch) =>
        set({ instructions: { ...get().instructions, [encounterId]: { ...get().instructionsFor(encounterId), ...patch } } }),

      issueInstructions: (encounterId, issue) => {
        const current = get().instructionsFor(encounterId)
        set({ instructions: { ...get().instructions, [encounterId]: { ...current, issued: [...current.issued, issue] } } })
      },

      setPatientLanguage: (patientId, language) => set({ patientLanguages: { ...get().patientLanguages, [patientId]: language } }),

      reset: () =>
        set({
          notes: {},
          prescriptions: {},
          acknowledgements: {},
          reassignedResults: {},
          coSigned: {},
          placedOrders: [],
          orderBaskets: {},
          cancelledOrders: {},
          promotedSets: {},
          createdSets: [],
          discharges: {},
          medRecs: {},
          deaths: {},
          triagedReferrals: {},
          seenAt: {},
          pendingSeen: [],
          voiceNotes: {},
          addedProblems: {},
          problemConfirmations: {},
          problemListConfirmed: {},
          instructions: {},
          patientLanguages: {},
        }),
    }),
    {
      name: 'indostates.clinical',
      version: 1,
      // v0 stored voice notes without an id or status.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<ClinicalState>
        if (version < 1) state.voiceNotes = normaliseVoiceNotes(state.voiceNotes)
        return state as ClinicalState
      },
    },
  ),
)
