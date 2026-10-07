/**
 * The audit trail.
 *
 * Two atlas rules make this a store rather than a console line:
 *   §3.2 — an access decision, and anything that follows from one, is written
 *   SYNCHRONOUSLY. "If it cannot be written, the absence is itself an alert"
 *   (DD-014). A break-glass that is not logged has not happened.
 *   §4.7 — every AI-assisted entry carries the model and the gate it passed
 *   under, so a reviewer can answer "who accepted what, on whose advice".
 *
 * It is SURFACED, not just written: the Quick-Panel carries an Audit
 * disclosure and the explainability drawer's provenance panel reads from here.
 * A log nobody can see is indistinguishable from no log.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { Gate } from '@/atlas/gates'

/** A closed set — an audit event nobody declared is an audit event nobody reviews. */
export type AuditEvent =
  | 'PATIENT.MARKED_SEEN'
  | 'AI.SCRIBE.TRANSCRIPT_CREATED'
  | 'NOTE.DRAFT_SAVED'
  /** A saved draft thrown away before it was signed — the save was on record, so the discard is too. */
  | 'NOTE.DRAFT_DISCARDED'
  | 'NOTE.DRAFT_EDITED'
  | 'COHORT.EXPORTED'
  | 'NOTE.SIGNED'
  | 'NOTE.COSIGN_QUEUED'
  /** CMP-NABH-03 — a registrar's entry countersigned by a consultant. */
  | 'NOTE.COSIGNED'
  /** A registrar's entry sent back unsigned, with what needs changing. */
  | 'NOTE.RETURNED'
  /** CMP-NABH-10 — a signed note amended, never edited: the addendum is its own entry. */
  | 'NOTE.ADDENDUM_APPENDED'
  | 'ACCESS.BREAK_GLASS'
  | 'AI.SAF.HARD_STOP_OVERRIDDEN'
  /** A G3 output attested by a named clinician — "I have reviewed this content" — so it enters the record. */
  | 'AI.ATTESTED'
  /** A hard stop resolved without an override — the blocked drug replaced by an alternative, or removed. */
  | 'RX.HARD_STOP_RESOLVED'
  /** A prescription signed — committed to the pharmacy queue and the ABDM publish queue. */
  | 'RX.SIGNED'
  /** S-06-08 — instructions issued to the patient, with the channels and the language. */
  | 'INSTRUCTIONS.ISSUED'
  /** S-09-01 — orders placed against an encounter, with their priority. */
  | 'ORDER.PLACED'
  /** S-09-03 — an order voided, never deleted, with its reason. */
  | 'ORDER.CANCELLED'
  /** S-09-06 — a critical result acknowledged by a named clinician: the escalation clock stops. */
  | 'RESULT.ACKNOWLEDGED'
  /** S-09-06 — a critical result handed to the clinician it belongs to; it stays unacknowledged. */
  | 'RESULT.REASSIGNED'
  /** S-06-10 — a personal order set made. */
  | 'ORDERSET.CREATED'
  /** S-06-10 — a set promoted to facility-wide: a governance act, with a named owner and a review date. */
  | 'ORDERSET.PROMOTED'
  | 'ADMISSION.REQUESTED'
  /** A patient discharged and the bed released — the summary signed or, if not, queued to be. */
  | 'PATIENT.DISCHARGED'
  /** The record's discharge flow: a seriously ill patient transferred to another facility. */
  | 'PATIENT.TRANSFERRED'
  /** The record's discharge flow: a patient leaving against medical advice, with the form's signatory and witness. */
  | 'PATIENT.LEFT_AMA'
  /** S-15-06: a critical imaging finding told to a named clinician — who, how, what was said. */
  | 'IMAGING.CRITICAL_ESCALATED'
  /** S-15-04: a reading note saved against a study. */
  | 'IMAGING.NOTE_SAVED'
  | 'IMAGING.ANNOTATION_ADDED'
  | 'IMAGING.ANNOTATION_DELETED'
  | 'IMAGING.KEY_IMAGE'
  | 'IMAGING.REPORT_DRAFTED'
  | 'IMAGING.REPORT_SIGNED'
  | 'IMAGING.ADDENDUM_SIGNED'
  // — M-18 stroke, part A (S-18-01…10)
  /** S-18-04: a code stroke activated — one tap, never gated; the clock starts and the team is paged. */
  | 'STROKE.CODE_ACTIVATED'
  /** S-18-05: the activation intake saved as it stands — it never blocks the clock. */
  | 'STROKE.INTAKE_SAVED'
  /** S-18-06: an event stamped on the case clock — append-only, at the server's case time. */
  | 'STROKE.EVENT_STAMPED'
  /** S-18-06: why an interval breached its target, captured at the moment of breach. */
  | 'STROKE.BREACH_REASON_CAPTURED'
  /** S-18-06: a case de-activated with its reason — the record stays (a mimic is recorded, not deleted). */
  | 'STROKE.CASE_DEACTIVATED'
  /** S-18-07: a task moved on the parallel board — a hard rule refuses a clinically wrong move before this is written. */
  | 'STROKE.TASK_MOVED'
  /** S-18-08: an amendment appended to a reconciled timestamp — never an overwrite; the sources stay. */
  | 'STROKE.TIMESTAMP_AMENDED'
  /** S-18-09: an unanswered page pushed up the ladder by hand. */
  | 'STROKE.PAGE_ESCALATED'
  /** S-13-03: every medicine on the discharge list accounted for, the list fixed. */
  | 'MEDREC.CONFIRMED'
  /** S-13-06: the MCCD issued, the death registered, the body handed over. */
  | 'DEATH.CERTIFIED'
  /** A problem added to the list, with its code. */
  | 'PROBLEM.ADDED'
  /** The problem list confirmed for an encounter — every code on it reviewed. */
  | 'PROBLEM_LIST.CONFIRMED'
  /** The doctor blocked time in their own calendar; the front office is told. */
  | 'SCHEDULE.BLOCKED'
  | 'SCHEDULE.UNBLOCKED'
  /** The doctor opened extra hours outside their working day; the front office is told where they may book. */
  | 'SCHEDULE.HOURS_OPENED'
  | 'SCHEDULE.HOURS_CLOSED'
  /** A booked appointment moved to another slot; the patient and the front office are told. */
  | 'APPOINTMENT.RESCHEDULED'
  /** A booked appointment cancelled, with its reason. */
  | 'APPOINTMENT.CANCELLED'
  /** The front office asked to rebook an appointment with the patient. */
  | 'APPOINTMENT.REBOOK_REQUESTED'
  /** The doctor scheduled a patient into free time of their own; the patient and the front office are told. */
  | 'APPOINTMENT.SCHEDULED'

export interface AuditRow {
  id: string
  event: AuditEvent
  /** Who. Named, never a role or a pool. */
  actor: string
  actorId: string
  /** ISO. */
  at: string
  /** Which patient or record it concerns. */
  subject?: string
  /** The model version, where a capability contributed. */
  model?: string
  /** The gate the action passed under (§4.4). */
  gate?: Gate
  detail?: string
  /** Set while the event is held locally because the device is offline. */
  queued?: boolean
}

interface AuditState {
  rows: AuditRow[]
  record: (row: Omit<AuditRow, 'id' | 'at'> & { at?: string }) => void
  /** Marks every queued row as written — the flush after reconnecting. */
  flushQueued: () => void
  forSubject: (subject: string) => AuditRow[]
  clear: () => void
}

let seq = 0

export const useAudit = create<AuditState>()(
  persist(
    (set, get) => ({
      rows: [],

      record: ({ at, ...row }) =>
        set({
          rows: [
            ...get().rows,
            { ...row, id: `AU-${Date.now().toString(36)}-${++seq}`, at: at ?? new Date().toISOString() },
          ],
        }),

      flushQueued: () => set({ rows: get().rows.map((r) => (r.queued ? { ...r, queued: false } : r)) }),

      forSubject: (subject) =>
        get()
          .rows.filter((r) => r.subject === subject)
          .slice()
          .reverse(),

      clear: () => set({ rows: [] }),
    }),
    { name: 'indostates.audit' },
  ),
)

const LABELS: Record<AuditEvent, string> = {
  'PATIENT.MARKED_SEEN': 'Marked seen',
  'AI.SCRIBE.TRANSCRIPT_CREATED': 'Dictation captured',
  'NOTE.DRAFT_SAVED': 'Note draft saved',
  'NOTE.DRAFT_DISCARDED': 'Note draft discarded',
  'NOTE.DRAFT_EDITED': 'Note draft edited before signing',
  'COHORT.EXPORTED': 'Cohort exported, de-identified',
  'NOTE.SIGNED': 'Note signed',
  'NOTE.COSIGN_QUEUED': 'Queued for co-sign',
  'NOTE.COSIGNED': 'Co-signed',
  'NOTE.RETURNED': 'Returned to the author',
  'NOTE.ADDENDUM_APPENDED': 'Addendum appended',
  'ACCESS.BREAK_GLASS': 'Break-glass access',
  'AI.SAF.HARD_STOP_OVERRIDDEN': 'Hard stop overridden',
  'AI.ATTESTED': 'AI output attested',
  'RX.HARD_STOP_RESOLVED': 'Hard stop resolved',
  'RX.SIGNED': 'Prescription signed',
  'INSTRUCTIONS.ISSUED': 'Instructions issued',
  'ORDER.PLACED': 'Orders placed',
  'ORDER.CANCELLED': 'Order voided',
  'RESULT.ACKNOWLEDGED': 'Critical result acknowledged',
  'RESULT.REASSIGNED': 'Critical result reassigned',
  'ORDERSET.CREATED': 'Order set created',
  'ORDERSET.PROMOTED': 'Order set promoted',
  'ADMISSION.REQUESTED': 'Admission requested',
  'PATIENT.DISCHARGED': 'Discharged',
  'PATIENT.TRANSFERRED': 'Transferred out',
  'PATIENT.LEFT_AMA': 'Left against medical advice',
  'IMAGING.CRITICAL_ESCALATED': 'Critical finding escalated',
  'IMAGING.NOTE_SAVED': 'Reading note saved',
  'IMAGING.ANNOTATION_ADDED': 'Mark added to an image',
  'IMAGING.ANNOTATION_DELETED': 'Mark deleted from an image',
  'IMAGING.KEY_IMAGE': 'Key image marked',
  'IMAGING.REPORT_DRAFTED': 'Imaging report drafted',
  'IMAGING.REPORT_SIGNED': 'Imaging report signed',
  'IMAGING.ADDENDUM_SIGNED': 'Imaging addendum signed',
  // — M-18 stroke, part A
  'STROKE.CODE_ACTIVATED': 'Code stroke activated',
  'STROKE.INTAKE_SAVED': 'Stroke intake saved',
  'STROKE.EVENT_STAMPED': 'Stroke event stamped',
  'STROKE.BREACH_REASON_CAPTURED': 'Breach reason captured',
  'STROKE.CASE_DEACTIVATED': 'Code stroke de-activated',
  'STROKE.TASK_MOVED': 'Stroke task moved',
  'STROKE.TIMESTAMP_AMENDED': 'Stroke timestamp amended',
  'STROKE.PAGE_ESCALATED': 'Stroke page escalated',
  'MEDREC.CONFIRMED': 'Discharge medicines reconciled',
  'DEATH.CERTIFIED': 'Death certified',
  'PROBLEM.ADDED': 'Problem added',
  'PROBLEM_LIST.CONFIRMED': 'Problem list confirmed',
  'SCHEDULE.BLOCKED': 'Time blocked',
  'SCHEDULE.UNBLOCKED': 'Block removed',
  'SCHEDULE.HOURS_OPENED': 'Extra hours opened',
  'SCHEDULE.HOURS_CLOSED': 'Extra hours closed',
  'APPOINTMENT.RESCHEDULED': 'Appointment rescheduled',
  'APPOINTMENT.CANCELLED': 'Appointment cancelled',
  'APPOINTMENT.REBOOK_REQUESTED': 'Rebooking requested',
  'APPOINTMENT.SCHEDULED': 'Appointment scheduled',
}

export function auditLabel(event: AuditEvent): string {
  return LABELS[event]
}
