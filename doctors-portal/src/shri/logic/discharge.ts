// ported from src/screens/m13/S1301.tsx:105-123 — the board's hard rules, word
// for word, less the one "discharge now, sign later" retires ("A discharge
// without a signed summary is not a discharge"): an unsigned summary no longer
// blocks, it goes to the sign queue.
//
// The board is grouped by what is recorded, not by AI-610's forecast (this
// build shows no forecasts): cleared for discharge when no gate holds; waiting
// on a gate when the charted condition is deteriorating or the payer has not
// cleared; discharged once discharged. What is outstanding but does not block
// — the summary unsigned, the medicines not yet reconciled, transport — is
// listed on the patient, never hidden and never a gate.
//
// One discharge, wherever it is done: `useDischarge` records it once per
// admission, releases the bed to the bed board, tells the front office, and
// puts an unsigned summary in the sign queue. The board's drag and its button
// call it now; the discharge flow will call the same handler.

import { DISCHARGE_BOARD, DISCHARGE_DRAFT_SD_P_03, ENCOUNTERS, encounterForPatient, type DischargeRow } from '@/data/clinical'
import { inpatientRows, type Admissions } from '@/data/admissions'
import { NOW } from '@/data/format'
import { LANGUAGES, patient } from '@/data/kit'
import { conditionFor } from '@/data/record'
import { useAudit } from '@/store/audit'
import { useClinical, type DischargeRecord } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useNotifications } from '../state/notifications'

import { encounterLabel } from './encounter'
import { DEFAULT_LANGUAGE } from './instructions'

export type Readiness = 'cleared' | 'waiting' | 'gone'

/** What holds the discharge, in the old board's words — recorded facts, not predictions. */
export function gatesFor(row: DischargeRow): string[] {
  const name = patient(row.patientId).name
  const out: string[] = []
  if (conditionFor(row.patientId)?.status === 'Deteriorating') {
    out.push(`${name} is deteriorating. A patient on a rising deterioration score cannot be marked discharged.`)
  }
  if (row.financialClearance !== 'Clear') {
    // The old words, the state lower-cased as a phrase — an acronym ("TPA") kept whole.
    const state = /^[A-Z]{2}/.test(row.financialClearance) ? row.financialClearance : `${row.financialClearance.charAt(0).toLowerCase()}${row.financialClearance.slice(1)}`
    out.push(`Financial clearance is outstanding: ${state}. The bed cannot be released until it clears.`)
  }
  return out
}

/** What is still to do but does not block: the record's own summary and med-rec state, then the charted items. */
export function outstandingFor(row: DischargeRow, summarySigned: boolean, medRecOpen: boolean): string[] {
  // The deterioration is the gate, and the summary is read from the record — neither is repeated from the fixture's words.
  const charted = row.blockers.filter((b) => !/^deteriorating/i.test(b) && !/summary/i.test(b))
  return [...(summarySigned ? [] : ['Discharge summary unsigned']), ...(medRecOpen ? ['Medication reconciliation open'] : []), ...charted]
}

/** The key the discharge summary is kept under. */
export const summaryKey = (encounterId: string) => `${encounterId}:discharge`

/** What a discharge flow adds to the record: its kind and the answers that go with it. */
export type DischargeExtra = Partial<Pick<DischargeRecord, 'kind' | 'careOf' | 'followUp' | 'transfer' | 'lama'>>

const KIND_EVENT = { discharge: 'PATIENT.DISCHARGED', transfer: 'PATIENT.TRANSFERRED', lama: 'PATIENT.LEFT_AMA', death: 'PATIENT.DISCHARGED' } as const

export function useDischarge() {
  const me = useCurrentStaff()
  const dischargePatient = useClinical((s) => s.dischargePatient)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const toast = useUI((s) => s.toast)

  return (patientId: string, bed?: string, extra: DischargeExtra = {}): boolean => {
    const p = patient(patientId)
    const enc = encounterForPatient(patientId)
    const kind = extra.kind ?? 'discharge'
    const summarySigned = enc ? useClinical.getState().note(summaryKey(enc.id)).status === 'signed' : false
    const done = dischargePatient({ patientId, encounterId: enc?.id, at: NOW.toISOString(), by: me.name, kind, bed, summarySigned, ...extra })
    if (!done) {
      toast({ tone: 'info', title: `${p.name} is already discharged`, detail: 'One discharge per admission — nothing was changed.' })
      return false
    }
    const where = kind === 'transfer' ? `transferred to ${extra.transfer?.facility}` : kind === 'lama' ? 'left against medical advice' : 'discharged home'
    const followUp = extra.followUp?.kind === 'booked' ? `follow-up ${extra.followUp.date}, ${extra.followUp.clinic}` : extra.followUp?.kind === 'none' ? `no follow-up: ${extra.followUp.reason}` : undefined
    audit({
      event: KIND_EVENT[kind],
      actor: me.name,
      actorId: me.id,
      subject: patientId,
      detail: [
        enc ? encounterLabel(enc) : undefined,
        where,
        kind === 'transfer' && extra.transfer ? `accepted by ${extra.transfer.clinician} · ${extra.transfer.transport}, ${extra.transfer.escort} escort · ${extra.transfer.reason}` : undefined,
        kind === 'lama' && extra.lama ? `form signed by ${extra.lama.signedBy} (${extra.lama.relationship}) · witness ${extra.lama.witness} · ${extra.lama.reason}` : undefined,
        followUp,
        `bed ${bed ?? '—'} released`,
        `summary ${summarySigned ? 'signed' : 'unsigned, to the sign queue'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    })
    send({
      severity: kind === 'transfer' ? 'urgent' : 'routine',
      kind: 'discharge',
      title: `Bed ${bed ?? ''} released`.trim(),
      detail: [`${p.name} ${where}`, followUp && `book ${followUp.replace(/^follow-up /, 'the follow-up ')}`, summarySigned ? undefined : 'summary to follow'].filter(Boolean).join(' · '),
      to: '/discharge/board',
      recipient: 'front office',
    })
    if (kind === 'transfer' && extra.transfer) {
      send({
        severity: 'urgent',
        kind: 'discharge',
        title: `Transfer — ${p.name}`,
        detail: `To ${extra.transfer.facility} · accepting ${extra.transfer.clinician} · ${extra.transfer.transport}, ${extra.transfer.escort} escort`,
        to: `/patient/${p.uhid}`,
        recipient: 'colleague',
      })
    }
    const summaryLine = summarySigned ? '' : ' The summary is unsigned — it goes to the sign queue.'
    toast({
      tone: 'success',
      title: kind === 'transfer' ? `${p.name} transferred to ${extra.transfer?.facility}` : kind === 'lama' ? `${p.name} left against medical advice` : `${p.name} discharged`,
      detail:
        kind === 'transfer'
          ? `Bed released to the bed board. The receiving team and the front office are told.${summaryLine}`
          : kind === 'lama'
            ? `Recorded with the form's signatory and witness. Bed released to the bed board.${summaryLine}`
            : `Bed released to the bed board.${summaryLine}`,
    })
    return true
  }
}

/* ------------------------------------------------------ the record's flow */

/**
 * How ill the patient is, from what is recorded — the condition record's
 * status and where the bed is — never from a forecast. A seriously ill patient
 * is not offered a routine discharge home.
 */
export function severityFor(patientId: string, bed?: string): { serious: boolean; reasons: string[] } {
  const status = conditionFor(patientId)?.status
  const reasons: string[] = []
  if (status === 'Critical' || status === 'Deteriorating') reasons.push(`${status.toLowerCase()} on the condition record`)
  if (bed && /^(ICU|HDU|NICU)/.test(bed)) reasons.push(`in intensive care (${bed})`)
  return { serious: reasons.length > 0, reasons }
}

/** The bed an inpatient is in, or undefined when the patient is not admitted (an ED trolley is not an admission). */
export function inpatientBed(patientId: string, admissions: Admissions): string | undefined {
  const board = DISCHARGE_BOARD.find((r) => r.patientId === patientId)
  if (board) return board.bed
  const row = inpatientRows(admissions).find((r) => r.patientId === patientId)
  if (row) return row.bed ?? patient(patientId).bed ?? undefined
  const bed = patient(patientId).bed
  return bed && !/^ED/.test(bed) ? bed : undefined
}

/** The old board's hard rules for this patient, in its words: the board's own row where there is one, else the deterioration rule alone. */
export function recordGates(patientId: string): string[] {
  const row = DISCHARGE_BOARD.find((r) => r.patientId === patientId)
  if (row) return gatesFor(row)
  return conditionFor(patientId)?.status === 'Deteriorating' ? [`${patient(patientId).name} is deteriorating. A patient on a rising deterioration score cannot be marked discharged.`] : []
}

/** Clinics a follow-up can be booked in — the departments the build's encounters run, less the emergency ones. */
export const FOLLOW_UP_CLINICS = [...new Set(ENCOUNTERS.map((e) => e.department))].filter((d) => !/^Emergency/.test(d))

/* ------------------------------------------------------------ S-13-02 */

// ported from src/screens/m13/S1302.tsx:45-49, 155-167 — the six sections and
// what signing does. The old screen offered SD-P-03's AI-106 draft on every
// patient's summary; the sections are everyone's, the draft is his alone.

export interface SummarySection {
  key: string
  label: string
  required: boolean
}

/** The six sections, all required — the handover that decides whether the patient comes back. */
export const SUMMARY_SECTIONS: SummarySection[] = DISCHARGE_DRAFT_SD_P_03.map(({ key, label, required }) => ({ key, label, required }))

/** AI-106's draft of each section — only for the patient it was drafted from. */
export function summaryDraftFor(patientId: string): Record<string, string> | undefined {
  return patientId === 'SD-P-03' ? Object.fromEntries(DISCHARGE_DRAFT_SD_P_03.map((s) => [s.key, s.draft])) : undefined
}

/** The summary's key into the draft's touchpoints: `${enc}:disch:${section}`, the old build's. */
export const summaryTouchpoint = (encounterId: string, section: string) => `${encounterId}:disch:${section}`

/** The summary has no translation in this build; it says so rather than printing a partial one. */
export const SUMMARY_ENGLISH_ONLY = 'Printed in English only. A translation of this summary is not available, and a partial translation is never printed.'

export const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code

/**
 * What happens on signing, in the old words, less two promises this build
 * cannot keep. "The bed is released on the discharge board" — under "discharge
 * now, sign later" the discharge releases the bed, and the summary can follow
 * it. And "bilingual" / "in their language" — no translation of the summary
 * exists, so it goes out in English with that stated (as S-06-08 does).
 */
export const ON_SIGNING = ['Printed A4, 2–4 pages', 'Published to ABDM as a DischargeSummary', 'Pushed to the patient app', 'Copy to the referring doctor']

/**
 * A signed summary goes out: to the patient's app and to the referring doctor,
 * kept as sent items. One handler, whether the consultant signed it on S-13-02
 * or co-signed a registrar's on S-06-09.
 */
export function usePublishSummary() {
  const send = useNotifications((s) => s.send)
  return (patientId: string, encounterId: string) => {
    const p = patient(patientId)
    const language = useClinical.getState().patientLanguages[patientId] ?? DEFAULT_LANGUAGE
    const to = `/encounter/${encounterId}/discharge-summary`
    send({
      severity: 'routine',
      kind: 'discharge',
      title: 'Discharge summary',
      detail: `${p.name} · pushed to the patient app${language === 'EN' ? '' : ` in English — no ${languageLabel(language)} translation is available`}`,
      to,
      recipient: 'patient',
    })
    send({ severity: 'routine', kind: 'discharge', title: 'Discharge summary', detail: `${p.name} · copy to the referring doctor`, to, recipient: 'colleague' })
  }
}
