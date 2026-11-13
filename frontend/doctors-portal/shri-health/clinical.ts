// SHRI_HEALTH data layer: the consultation note's part of `useClinical` (src/store/clinical.ts),
// with the same state and actions, over the notes API (D8): a draft created from the SOAP
// template, saved with If-Match, signed, and appended to with addenda. Everything else the mock
// store holds stays on the mock store; these screens import only this part.
import { create } from 'zustand'

import type { RxLine } from '@/data/clinical'
import type { AddedProblem, NoteRecord, NoteStatus, RxOverride, RxRecord, SectionProvenance } from '@/store/clinical'
import { useUI } from '@/store/ui'
import { useAI } from '@/store/ai'
import { useScribeDrafts } from '@/data/scribe'
import type { ConfidenceBand } from '@/atlas/confidence'

import { ApiError, etagOf, newIdempotencyKey } from '../../src/api/client'
import {
  addEncounterDiagnosis,
  removeEncounterDiagnosis,
  addNoteAddendum,
  createAfterVisitSummary,
  getEncounter,
  createNote,
  getNote,
  listEncounterNotes,
  signNote as signNoteApi,
  updateNoteDraft,
} from '../../src/api/generated/endpoints/encounters/encounters'
import {
  checkPrescriptionSafety,
  createPrescription,
  getPrescription,
  listEncounterPrescriptions,
  listPharmacies,
  overrideAlert,
  signAndSendPrescription,
  updatePrescription,
} from '../../src/api/generated/endpoints/medications/medications'
import { listNoteTemplates } from '../../src/api/generated/endpoints/practice-setup/practice-setup'
import { createNoteDraft, decideAiSuggestion } from '../../src/api/generated/endpoints/ai/ai'
import { getPatient } from '../../src/api/generated/endpoints/patients/patients'
import type { AiSuggestionDecision, Encounter, EncounterDiagnosis, Note, NoteList, NoteTemplateList, Operation, Prescription, PrescriptionList, PrescriptionTransmission, SafetyAlert, SafetyCheckResult } from '../../src/api/generated/model'
import { problemCopy } from '../../src/design-system/problem/problem'

import { rxNormProduct } from './formulary'
import { maybeEncounter } from './encounter'
import { read } from './resource'
import { finished } from './aiChart'
import { WAITING_STATUSES, pollStatus } from './rxStatusPoll'
import { AiFeatureDown } from './aiStatus'

import type { RxLineEdit as ScreenRxLineEdit } from '@/store/clinical'

/**
 * A line's edit, with the contract's fields the prescription screen gained under the porting rule
 * (SCREEN_PORT.md): the quantity, its unit and refills, which signing needs (quantity) or allows.
 */
export type RxLineEdit = ScreenRxLineEdit & { quantity?: string; quantityUnit?: string; refills?: number }
export type { SectionProvenance }

/** The screen's four sections, by their LOINC section codes (the SOAP template). */
const KEY_BY_CODE: Record<string, string> = { '61150-9': 'subjective', '61149-1': 'objective', '51848-0': 'assessment', '18776-5': 'plan' }
const SOAP_TEMPLATE_CODE = 'SOAP'

/** What the store keeps per encounter besides the screen's NoteRecord. */
interface Server {
  noteId?: string
  etag?: string
  /** Section id by the screen's key. */
  sectionIds: Record<string, string>
  /** The text last saved, by key: autosave writes only when something changed. */
  saved: Record<string, string>
  /** Saves run one after another, so Sign never sends an old ETag. */
  queue: Promise<void>
  /**
   * AI-01's sections (createNoteDraft), by key: the suggestion to decide, the AI's text, and
   * whether it is decided. The server refuses Sign until each is (decideAiSuggestion).
   */
  ai?: Record<string, AiSection>
}

interface AiSection {
  suggestionId: string
  text: string
  decided: boolean
}

/** A section the AI drafted and nobody decided yet: shown as the ghost draft, never as typed text. */
function pendingAi(n: Note): Record<string, AiSection> {
  const out: Record<string, AiSection> = {}
  for (const sec of n.sections) {
    const key = KEY_BY_CODE[sec.code]
    if (!key || !sec.aiSuggestionId) continue
    const decided = sec.aiDecision !== undefined && sec.aiDecision !== 'pending'
    out[key] = { suggestionId: sec.aiSuggestionId, text: sec.aiSuggestion?.suggestedText ?? sec.text, decided }
  }
  return out
}

const BAND: Record<string, ConfidenceBand> = { low: 'LOW', medium: 'MED', high: 'HIGH' }

/** The AI suggestion each section's local decision belongs to, as last published (`encounterId:key`). */
const publishedSuggestion = new Map<string, string>()

/** Puts the undecided AI sections in the scribe's draft store, where the note shows them as ghosts.
 *  A local decision counts only for the suggestion it was made on: when a section's suggestion is
 *  new (a fresh draft, or the first load in this tab), any earlier decision for it is cleared. */
function publishAi(encounterId: string, n: Note): string[] {
  const pending = Object.entries(pendingAi(n)).filter(([, a]) => !a.decided)
  for (const [k, a] of pending) {
    const slot = `${encounterId}:${k}`
    if (publishedSuggestion.get(slot) !== a.suggestionId) {
      useAI.getState().clearDisposition(slot)
      publishedSuggestion.set(slot, a.suggestionId)
    }
  }
  if (pending.length === 0) return []
  const first = n.sections.find((sec) => sec.aiSuggestion)?.aiSuggestion
  useScribeDrafts.setState((st) => ({
    drafts: {
      ...st.drafts,
      [encounterId]: {
        patientId: n.patientId,
        sections: Object.fromEntries(pending.map(([k, a]) => [k, a.text])),
        transcript: '',
        model: 'Claude (AI-01, AI-generated)',
        band: BAND[first?.confidence ?? 'medium'] ?? 'MED',
        confidence: 0,
        scored: false,
        at: n.updatedAt,
      },
    },
  }))
  return pending.map(([k]) => k)
}



interface NoteState {
  notes: Record<string, NoteRecord>
  server: Record<string, Server>
  note: (encounterId: string) => NoteRecord
  setSectionText: (encounterId: string, key: string, text: string, provenance?: SectionProvenance) => void
  applyScribeDraft: (encounterId: string, keys: string[], drafts?: Partial<Record<string, string>>) => string[]
  /** "Draft with AI" (AI-01): the dictated text to createNoteDraft; resolves with the drafted section keys. */
  draftWithAi: (encounterId: string, transcript: string) => Promise<string[]>
  setNoteCode: (encounterId: string, code: string | undefined) => void
  saveDraft: (encounterId: string, how?: 'manual' | 'auto') => void
  /** Resolves to the status the server gives the note, or null when it refused to sign it. */
  signNote: (args: { encounterId: string; by: string; registrationNo: string; canSign: boolean }) => Promise<NoteStatus | null>
  addendum: (args: { encounterId: string; body: string; by: string; registrationNo: string }) => void

  /** The encounter's diagnoses, in the problem rows the Problems and coding screen draws. */
  diagnoses: Record<string, AddedProblem[]>
  loadDiagnoses: (encounterId: string) => Promise<void>
  addProblem: (encounterId: string, dx: { label: string; icd10: string }, by: string, at: string) => AddedProblem | null
  /** Removes a diagnosis before the note is signed (D24: entered-in-error with the reason). True once the server has it. */
  removeProblem: (encounterId: string, diagnosisId: string, label: string, reason: string) => Promise<boolean>
  // TODO(gap 6): no operation changes a diagnosis's verification status, or confirms the list;
  // both stay on this screen only, as in the mock.
  problemConfirmations: Record<string, { by: string; at: string }>
  confirmProblem: (problemId: string, by: string, at: string) => void
  problemListConfirmed: Record<string, { by: string; at: string; codes: string[] }>
  confirmProblemList: (encounterId: string, codes: string[], by: string, at: string) => void

  /** The prescription screen's record per encounter; each line's id is its prescription's id. */
  prescriptions: Record<string, RxRecord>
  /** The pharmacy each visit's prescriptions go to (the server refuses to sign without one). */
  rxPharmacy: Record<string, RxPharmacy | null | undefined>
  /** Starts from the patient's preferred pharmacy on their record, when there is one. */
  loadRxPharmacy: (encounterId: string) => Promise<void>
  /** Sets the pharmacy for the visit and saves it on every draft line (If-Match). */
  chooseRxPharmacy: (encounterId: string, pharmacy: RxPharmacy) => void
  /** Per prescription: its ETag, and the alerts of its latest safety check. */
  rxServer: Record<string, { etag?: string; alerts: SafetyAlert[]; checkedAt?: string; queue: Promise<void>; signed?: boolean; transmission?: PrescriptionTransmission }>
  rx: (encounterId: string) => RxRecord
  addRxLine: (encounterId: string, line: Omit<RxLine, 'id'>) => string | null
  editRxLine: (encounterId: string, lineId: string, patch: RxLineEdit) => void
  // TODO(gap): discarding a draft (markPrescriptionEnteredInError) needs a reason the screen doesn't ask for; removal stays on the screen.
  removeRxLine: (encounterId: string, lineId: string) => void
  // TODO(gap): the server offers no alternatives; a substitution stays on the screen.
  substitute: (encounterId: string, lineId: string, drug: string) => void
  overrideHardStop: (args: { encounterId: string; lineId: string; reason: string; reasonText?: string; prescriber: string; coSigner: string; auditEvent: string }) => void
  /** Resolves true once every prescription is signed and sent; false when the API refused one. */
  signRx: (args: { encounterId: string; by: string; registrationNo: string }) => Promise<boolean>
  /** After Sign, reads the signed lines' pharmacy status again until it settles; returns the stop. */
  pollRxStatus: (encounterId: string) => () => void
}

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'
const blankRx = (encounterId: string): RxRecord => ({ encounterId, status: 'draft', removedLines: [], substitutions: {}, added: [], edits: {} })

/** Pages of a visit's prescriptions read at most (500): more than any visit holds. */
const RX_PAGES = 5

/** The visit's prescriptions, drafts included, oldest first (listEncounterPrescriptions, #291; gap 82). */
async function encounterRxIds(encounterId: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < RX_PAGES; page++) {
    const data = (await listEncounterPrescriptions(encounterId, { limit: 100, ...(cursor ? { cursor } : {}) })).data as PrescriptionList
    ids.push(...data.items.map((p) => p.id))
    cursor = data.nextCursor ?? undefined
    if (!cursor) break
  }
  return ids
}

/** The dispensing unit an RxNorm dose form suggests: `Oral Tablet` → `tablet`, a liquid → `mL`. */
function unitOf(doseForm?: string): string {
  const form = (doseForm ?? '').toLowerCase()
  if (/solution|suspension|syrup|elixir|liquid/.test(form)) return 'mL'
  const word = form.split(' ').pop() ?? ''
  return word.endsWith('s') ? word.slice(0, -1) : word
}

/** A new line's first edit: its dispensing unit, from the dose form. */
function unitEdit(doseForm?: string): RxLineEdit {
  return { quantityUnit: unitOf(doseForm) }
}

/**
 * The line a prescription is on the screen. TODO(gap): the contract keeps the sig as one
 * dosageText; a sig this screen wrote ("dose, route, frequency", `dosageText()` below) reads back
 * into its fields, and any other sig shows as the line's instructions.
 */
function toLine(p: Prescription): RxLine {
  const parts = (p.dosageText ?? '').split(', ')
  const own = parts.length >= 3 && parts[0] !== '' && parts[1] !== ''
  return {
    id: p.id,
    drug: p.medication.text ?? p.medication.codings?.[0]?.display ?? '',
    dose: own ? parts[0] : '—',
    route: own ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : 'Oral',
    frequency: own ? parts.slice(2).join(', ') : 'as prescribed',
    durationDays: p.daysSupply ?? 0,
    substitutionAllowed: p.substitutionAllowed ?? true,
    instructions: own ? undefined : p.dosageText,
  }
}

/** The sig sent as dosageText: only what the screen states, never its placeholders. */
function dosageText(line: RxLine, edit: RxLineEdit = {}): string | undefined {
  const dose = (edit.dose ?? line.dose).trim()
  const [route, ...rest] = (edit.routeFrequency ?? `${line.route} · ${line.frequency}`).split(' · ')
  const frequency = rest.join(' · ').trim()
  if (dose === '' || dose === '—' || frequency === '' || frequency === 'as prescribed') return undefined
  return [dose, route.trim().toLowerCase(), frequency].join(', ')
}

const SNOMED = 'http://snomed.info/sct'

/** A diagnosis as the screen's problem row: leaf, since only billable ICD-10-CM codes are taken. */
function toProblem(d: EncounterDiagnosis, patientId: string): AddedProblem {
  return {
    id: d.id,
    patientId,
    label: d.code.display ?? d.code.code,
    icd10: d.code.code,
    snomed: d.additionalCodings?.find((c) => c.system === SNOMED)?.code ?? '—',
    onset: d.onsetDate ?? '—',
    status: 'Open',
    aiSuggested: d.entrySource === 'ai-generated' ? true : undefined,
    leaf: true,
    addedBy: d.recordedBy?.displayName ?? '',
    addedAt: d.recordedAt,
  }
}

const blank = (encounterId: string): NoteRecord => ({ encounterId, text: {}, provenance: {}, status: 'draft', addenda: [] })

function fromNote(encounterId: string, n: Note, local?: NoteRecord): NoteRecord {
  const text: Record<string, string> = {}
  for (const s of n.sections) if (KEY_BY_CODE[s.code]) text[KEY_BY_CODE[s.code]] = s.text
  const signed = n.status === 'final' || n.status === 'amended'
  // An undecided AI section is the ghost draft (publishAi), never the clinician's text.
  const undecided = signed ? [] : Object.entries(pendingAi(n)).filter(([, a]) => !a.decided).map(([k]) => k)
  for (const k of undecided) text[k] = local?.text[k] ?? ''
  const provenance: Record<string, SectionProvenance> = local?.provenance
    ? { ...local.provenance }
    : Object.fromEntries(Object.entries(text).filter(([, t]) => t).map(([k]) => [k, 'typed' as const]))
  for (const k of undecided) if (!local?.provenance[k] || local.provenance[k] === 'scribe') provenance[k] = 'scribe'
  return {
    encounterId,
    text,
    provenance,
    status: n.cosignStatus === 'pending' ? 'cosign-pending' : signed ? 'signed' : 'draft',
    signedBy: n.signedBy?.displayName,
    // TODO(gap): no registration number in the US; the NPI is not on ClinicianRef.
    registrationNo: '',
    signedAt: n.signedAt,
    addenda: n.addenda.map((a) => ({ id: a.id, body: a.text, by: a.author.displayName, registrationNo: '', at: a.signedAt })),
    savedAt: n.updatedAt,
    savedHow: local?.savedHow,
    // TODO(gap): the contract codes diagnoses on the encounter, not the note; this stays on screen only.
    code: local?.code,
    coSignedBy: n.cosignedBy?.displayName,
    coSignedAt: n.cosignedAt,
    returned: n.cosignReturn ? { by: n.cosignReturn.returnedBy.displayName, at: n.cosignReturn.returnedAt, comment: n.cosignReturn.comment } : undefined,
  }
}

function serverFrom(n: Note, etag: string | null): Server {
  const sectionIds: Record<string, string> = {}
  const saved: Record<string, string> = {}
  for (const s of n.sections) {
    const key = KEY_BY_CODE[s.code]
    if (key) {
      sectionIds[key] = s.id
      saved[key] = s.text
    }
  }
  return { noteId: n.id, etag: etag ?? undefined, sectionIds, saved, queue: Promise.resolve(), ai: pendingAi(n) }
}

function toastProblem(error: unknown, title: string) {
  const copy = error instanceof ApiError ? problemCopy(error.problem) : null
  useUI.getState().toast({ tone: 'critical', title: copy?.title ?? title, detail: copy?.message })
}

const RX_FIELDS: Record<string, string> = { '/dosageText': 'the directions', '/quantity': 'the quantity', '/pharmacyId': 'the pharmacy', '/daysSupply': 'the days supply', '/refills': 'the refills' }

const staleCheck = (error: ApiError) => ((error.problem as { errors?: { code?: string }[] }).errors ?? []).some((f) => f.code === 'safety-check-stale')

/** Why a prescription was not signed, in plain words: 409, 412, 428, 403 and a stale safety check each say what to do next. */
export function signRefusal(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Check the connection and sign again.'
  if (error.status === 412) return 'It changed since you opened it (another tab or user). The latest version is loaded; check it and sign again.'
  if (error.status === 428) return 'The latest version is loaded; sign again.'
  if (error.status === 409 && error.code === 'idempotency-request-in-progress') return 'Your earlier Sign is still being processed. Wait a moment.'
  if (error.status === 409) return "It isn't a draft any more (already signed or discarded). The latest status is loaded."
  if (error.status === 403 && error.code === 'break-glass-required') return 'Restricted chart: open the chart with a reason first, then sign.'
  if (error.status === 403) return 'Only a physician (MD) or an advanced practice provider (APP) may sign prescriptions.'
  if (staleCheck(error)) return 'The safety checks ran again on the latest version. Review any alert, then sign again.'
  const missing = ((error.problem as { errors?: { pointer?: string }[] }).errors ?? []).map((f) => RX_FIELDS[f.pointer ?? '']).filter(Boolean)
  if (missing.length > 0) return `Add ${missing.join(', ')} and sign again.`
  return problemCopy(error.problem).message
}

export interface RxPharmacy {
  id: string
  name: string
  detail: string
}

const pharmacyDetail = (a?: { line?: string; city?: string; state?: string; postalCode?: string }, mailOrder?: boolean) =>
  [mailOrder ? 'Mail order' : null, a?.line, [a?.city, a?.state].filter(Boolean).join(', '), a?.postalCode].filter(Boolean).join(' · ')

/** The pharmacy directory (listPharmacies, D50): a five-digit search is a ZIP code, anything else a name. */
export async function searchPharmacies(query: string): Promise<RxPharmacy[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const res = await listPharmacies(/^\d{5}$/.test(q) ? { postalCode: q, limit: 8 } : { q, limit: 8 })
  return res.status === 200 ? res.data.items.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, detail: pharmacyDetail(p.address, p.mailOrder) })) : []
}

/**
 * The after-visit summary, made from the note just signed (createAfterVisitSummary, D98: MD and
 * APP), so the front desk can print it at check-out (demo step 11). It runs in the background
 * (202); nothing waits for it. A role that may not make one (403) is left alone; any other failure
 * says so, and the summary is made again from the next signed version.
 */
function requestAfterVisitSummary(encounterId: string): void {
  createAfterVisitSummary(encounterId, undefined, { 'Idempotency-Key': newIdempotencyKey() }).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 403) return
    const copy = error instanceof ApiError ? problemCopy(error.problem) : null
    useUI.getState().toast({ tone: 'caution', title: 'The after-visit summary was not made', detail: copy?.message ?? 'Check-out still works; tell the front desk there is no summary to print.' })
  })
}

export const useClinical = create<NoteState>()((set, get) => {
  const patch = (encounterId: string, record: Partial<NoteRecord>) =>
    set({ notes: { ...get().notes, [encounterId]: { ...get().note(encounterId), ...record } } })
  const setServer = (encounterId: string, server: Partial<Server>) =>
    set({ server: { ...get().server, [encounterId]: { ...get().server[encounterId], ...server } } })

  const saveTimers = new Map<string, number>()

  /** Saves a line's stated sig, duration and substitution, then checks it again. */
  function saveLine(encounterId: string, lineId: string): void {
    saveTimers.delete(lineId)
    const rec = get().rx(encounterId)
    const line = (rec.added ?? []).find((l) => l.id === lineId)
    if (!line || rec.status === 'signed') return
    const edit: RxLineEdit = rec.edits?.[lineId] ?? {}
    const value = Number(edit.quantity)
    const unit = edit.quantityUnit?.trim()
    // TODO(gap): the indication, the PRN maximum and the instructions stay on the screen: the contract has no field for them.
    onLine(lineId, async () => {
      const res = await updatePrescription(
        lineId,
        {
          dosageText: dosageText(line, edit),
          daysSupply: edit.durationDays ?? (line.durationDays || undefined),
          substitutionAllowed: edit.substitutionAllowed ?? line.substitutionAllowed,
          quantity: value > 0 && unit ? { value, unit } : undefined,
          refills: edit.refills,
        },
        { 'If-Match': get().rxServer[lineId]?.etag ?? '' },
      )
      set({ rxServer: { ...get().rxServer, [lineId]: { ...get().rxServer[lineId], etag: etagOf(res) ?? undefined } } })
      await check(lineId)
    }).catch((error: unknown) => toastProblem(error, `${line.drug} was not saved`))
  }

  /** Runs one write on a prescription after the ones before it. */
  /**
   * Reads the visit's prescriptions from the server, in any browser and after a reload: on first
   * open, and again after a refusal. Each is read on its own as well, for its ETag (If-Match).
   */
  async function loadRx(encounterId: string): Promise<void> {
    const ids = await encounterRxIds(encounterId)
    const found = await Promise.all(ids.map((id) => getPrescription(id).then((res) => ({ p: res.data as Prescription, etag: etagOf(res) }))))
    const live = found.filter(({ p }) => p.status !== 'entered-in-error')
    set({
      prescriptions: {
        ...get().prescriptions,
        [encounterId]: {
          ...blankRx(encounterId),
          added: live.map(({ p }) => toLine(p)),
          edits: Object.fromEntries(live.map(({ p }): [string, RxLineEdit] => [p.id, { quantity: p.quantity ? String(p.quantity.value) : undefined, quantityUnit: p.quantity?.unit, refills: p.refills }])),
          status: live.length > 0 && live.every(({ p }) => p.status === 'active') ? 'signed' : 'draft',
          // When it was signed, from the server (the latest line's), so the read-only banner says it after a reload.
          signedAt: live.map(({ p }) => p.signedAt).filter((at): at is string => Boolean(at)).sort().pop() },
      },
      rxServer: { ...get().rxServer, ...Object.fromEntries(live.map(({ p, etag }) => [p.id, { etag: etag ?? undefined, alerts: p.alerts, queue: Promise.resolve(), transmission: p.transmission, signed: p.status === 'active' }])) },
    })
    // The pharmacy already saved on the lines (another tab, or before a reload) is the visit's pharmacy.
    const saved = live.find(({ p }) => p.pharmacyId)?.p
    if (saved?.pharmacyId && get().rxPharmacy[encounterId]?.id !== saved.pharmacyId) {
      const res = await getPatient(saved.patientId).catch(() => null)
      const pref = res?.status === 200 ? res.data.preferredPharmacy : undefined
      // TODO(gap): no pharmacy read by ID (#93): the preferred pharmacy, else the first page of the
      // directory, gives its name; past that it shows without one.
      const listed = pref?.id === saved.pharmacyId ? undefined
        : await listPharmacies({ limit: 100 }).then((r) => (r.status === 200 ? r.data.items.find((x) => x.id === saved.pharmacyId) : undefined)).catch(() => undefined)
      const pharmacy = pref?.id === saved.pharmacyId
        ? { id: pref.id, name: pref.name, detail: pharmacyDetail(pref.address) }
        : listed
        ? { id: listed.id, name: listed.name, detail: pharmacyDetail(listed.address, listed.mailOrder) }
        : { id: saved.pharmacyId, name: 'The pharmacy saved on this prescription', detail: 'Change it to see the list again' }
      set({ rxPharmacy: { ...get().rxPharmacy, [encounterId]: pharmacy } })
    }
  }

  function onLine(id: string, job: () => Promise<void>): Promise<void> {
    const before = get().rxServer[id]?.queue ?? Promise.resolve()
    const next = before.then(job)
    set({ rxServer: { ...get().rxServer, [id]: { ...(get().rxServer[id] ?? { alerts: [] }), queue: next.catch(() => undefined) } } })
    return next
  }

  /** The fixed-rule safety check (D99), run on every saved version of the draft. */
  async function check(id: string): Promise<void> {
    const res = await checkPrescriptionSafety(id)
    const result = res.data as SafetyCheckResult
    set({ rxServer: { ...get().rxServer, [id]: { ...get().rxServer[id], alerts: result.alerts, checkedAt: result.checkedAt } } })
    touchRecordOf(id)
  }

  /** The screen redraws on its prescription record: a new check or override refreshes it. */
  function touchRecordOf(lineId: string): void {
    const entry = Object.entries(get().prescriptions).find(([, rec]) => (rec.added ?? []).some((l) => l.id === lineId))
    if (entry) set({ prescriptions: { ...get().prescriptions, [entry[0]]: { ...entry[1] } } })
  }

  /** The encounter's patient, from the encounter already read for the screen. */
  function maybeEncounterRow(encounterId: string): { patientId: string } | undefined {
    try {
      return maybeEncounter(encounterId)
    } catch {
      return undefined
    }
  }

  /** The encounter's current note, read once (the latest that isn't entered in error). */
  async function load(encounterId: string): Promise<void> {
    const list = (await listEncounterNotes(encounterId)).data as NoteList
    const current = list.items.find((n) => n.status !== 'entered-in-error')
    if (!current) {
      set({ notes: { ...get().notes, [encounterId]: blank(encounterId) }, server: { ...get().server, [encounterId]: { sectionIds: {}, saved: {}, queue: Promise.resolve() } } })
      return
    }
    const res = await getNote(current.id)
    const n = res.data as Note
    publishAi(encounterId, n)
    set({ notes: { ...get().notes, [encounterId]: fromNote(encounterId, n) }, server: { ...get().server, [encounterId]: serverFrom(n, etagOf(res)) } })
  }

  /** Reread after a 412: someone else saved, so the screen shows their version. */
  async function reload(encounterId: string): Promise<void> {
    const noteId = get().server[encounterId]?.noteId
    if (!noteId) return
    const res = await getNote(noteId)
    const n = res.data as Note
    publishAi(encounterId, n)
    set({ notes: { ...get().notes, [encounterId]: fromNote(encounterId, n, get().notes[encounterId]) } })
    setServer(encounterId, serverFrom(n, etagOf(res)))
  }

  /**
   * Each AI section's decision, from what the clinician did (the note's Accept, Edit or Reject)
   * and the saved text: the server's rules (accepted = the AI text kept; edited = changed;
   * rejected = the AI text gone, with a reason). Undecided sections stop Sign: never decided
   * for the clinician.
   */
  async function decideAi(encounterId: string): Promise<void> {
    const server = get().server[encounterId]
    const ai = { ...(server?.ai ?? {}) }
    for (const [key, section] of Object.entries(ai)) {
      if (section.decided) continue
      const d = useAI.getState().dispositions[`${encounterId}:${key}`]
      if (!d) throw new Error('Accept, edit or reject each AI-drafted section before signing.')
      const text = (get().notes[encounterId]?.text[key] ?? '').trim()
      let body: AiSuggestionDecision
      if (d.disposition === 'Rejected' || text === '') body = { decision: 'rejected', reason: (d.reasonText || d.reason || 'Rejected by the clinician').slice(0, 500) }
      else if (text === section.text.trim()) body = { decision: 'accepted' }
      else body = { decision: 'edited' }
      await decideAiSuggestion(section.suggestionId, body, { 'Idempotency-Key': newIdempotencyKey() })
      ai[key] = { ...section, decided: true }
      setServer(encounterId, { ai })
    }
  }

  async function ensureNote(encounterId: string): Promise<void> {
    if (get().server[encounterId]?.noteId) return
    const templates = (await listNoteTemplates({ limit: 100 })).data as NoteTemplateList
    const soap = templates.items.find((t) => t.code === SOAP_TEMPLATE_CODE)
    if (!soap) throw new Error('The practice has no SOAP note template (see SCREEN_PORT.md, gap 2).')
    const res = await createNote(encounterId, { templateId: soap.id }, { 'Idempotency-Key': newIdempotencyKey() })
    setServer(encounterId, serverFrom(res.data as Note, etagOf(res)))
  }

  /** Writes the sections that changed since the last save. */
  async function flush(encounterId: string): Promise<void> {
    const text = get().note(encounterId).text
    const changed = () => Object.entries(text).filter(([k, t]) => (get().server[encounterId]?.saved[k] ?? '') !== t)
    if (changed().length === 0) return
    await ensureNote(encounterId)
    const server = get().server[encounterId]
    const sections = changed()
      .filter(([k]) => server.sectionIds[k])
      .map(([k, t]) => ({ id: server.sectionIds[k], text: t }))
    if (sections.length === 0) return
    const res = await updateNoteDraft(server.noteId!, { sections }, { 'If-Match': server.etag ?? '' })
    setServer(encounterId, { etag: etagOf(res) ?? undefined, saved: { ...server.saved, ...Object.fromEntries(sections.map((s) => [Object.keys(server.sectionIds).find((k) => server.sectionIds[k] === s.id)!, s.text])) } })
    patch(encounterId, { savedAt: (res.data as Note).updatedAt })
  }

  /** Runs one write after the ones before it. */
  function enqueue(encounterId: string, job: () => Promise<void>): Promise<void> {
    const before = get().server[encounterId]?.queue ?? Promise.resolve()
    const next = before.then(job)
    setServer(encounterId, { queue: next.catch(() => undefined) })
    return next
  }

  return {
    notes: {},
    server: {},
    diagnoses: {},
    problemConfirmations: {},
    problemListConfirmed: {},

    loadDiagnoses: async (encounterId) => {
      const e = (await getEncounter(encounterId)).data as Encounter
      const live = e.diagnoses.filter((d) => d.verificationStatus !== 'entered-in-error')
      const confirmed = Object.fromEntries(live.filter((d) => d.verificationStatus === 'confirmed').map((d) => [d.id, { by: d.recordedBy?.displayName ?? '', at: d.recordedAt }]))
      set({
        diagnoses: { ...get().diagnoses, [encounterId]: live.map((d) => toProblem(d, e.patientId)) },
        problemConfirmations: { ...get().problemConfirmations, ...confirmed },
      })
    },

    addProblem: (encounterId, dx, by, at) => {
      const existing = get().diagnoses[encounterId] ?? []
      if (existing.some((pr) => pr.icd10 === dx.icd10)) return null
      const pending: AddedProblem = { id: `pending:${dx.icd10}`, patientId: '', label: dx.label, icd10: dx.icd10, snomed: '—', onset: '—', status: 'Open', leaf: true, addedBy: by, addedAt: at }
      set({ diagnoses: { ...get().diagnoses, [encounterId]: [...existing, pending] } })
      const replace = (row?: AddedProblem) =>
        set({ diagnoses: { ...get().diagnoses, [encounterId]: (get().diagnoses[encounterId] ?? []).flatMap((pr) => (pr.id === pending.id ? (row ? [row] : []) : [pr])) } })
      addEncounterDiagnosis(encounterId, { code: { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: dx.icd10, display: dx.label } }, { 'Idempotency-Key': newIdempotencyKey() })
        .then((res) => {
          replace(toProblem(res.data as EncounterDiagnosis, ''))
          // Said once the server has it, never before: a refusal must not follow an "added".
          useUI.getState().toast({ tone: 'success', title: `${dx.label} added`, detail: `Coded ${dx.icd10}` })
        })
        .catch((error: unknown) => {
          replace()
          toastProblem(error, `${dx.label} was not added`)
        })
      return pending
    },

    removeProblem: async (encounterId, diagnosisId, label, reason) => {
      try {
        await removeEncounterDiagnosis(encounterId, diagnosisId, { reason: reason.trim() })
        set({ diagnoses: { ...get().diagnoses, [encounterId]: (get().diagnoses[encounterId] ?? []).filter((pr) => pr.id !== diagnosisId) } })
        useUI.getState().toast({ tone: 'success', title: `${label} removed`, detail: 'Kept in the record as entered in error, with your reason' })
        return true
      } catch (error) {
        toastProblem(error, `${label} was not removed`)
        return false
      }
    },

    rxPharmacy: {},

    loadRxPharmacy: async (encounterId) => {
      if (get().rxPharmacy[encounterId] !== undefined) return
      const patientId = maybeEncounterRow(encounterId)?.patientId
      if (!patientId) return
      const res = await getPatient(patientId).catch(() => null)
      const pref = res && res.status === 200 ? res.data.preferredPharmacy : undefined
      if (get().rxPharmacy[encounterId] !== undefined) return
      set({ rxPharmacy: { ...get().rxPharmacy, [encounterId]: pref ? { id: pref.id, name: pref.name, detail: pharmacyDetail(pref.address) } : null } })
    },

    chooseRxPharmacy: (encounterId, pharmacy) => {
      set({ rxPharmacy: { ...get().rxPharmacy, [encounterId]: pharmacy } })
      const rec = get().rx(encounterId)
      for (const line of rec.added ?? []) {
        if (line.id.startsWith('pending:') || rec.status === 'signed') continue
        onLine(line.id, async () => {
          const res = await updatePrescription(line.id, { pharmacyId: pharmacy.id }, { 'If-Match': get().rxServer[line.id]?.etag ?? '' })
          set({ rxServer: { ...get().rxServer, [line.id]: { ...get().rxServer[line.id], etag: etagOf(res) ?? undefined } } })
          // Any change makes the last safety check stale, and Sign is refused with
          // safety-check-stale; check again on the version just saved, as a line edit does.
          await check(line.id)
        }).catch((error: unknown) => toastProblem(error, `${line.drug}: the pharmacy was not saved`))
      }
    },

    prescriptions: {},
    rxServer: {},

    rx: (encounterId) => {
      read(`rx:${encounterId}`, () => loadRx(encounterId))
      return get().prescriptions[encounterId] ?? blankRx(encounterId)
    },

    addRxLine: (encounterId, line) => {
      const current = get().rx(encounterId)
      if (current.status === 'signed') return null
      const product = rxNormProduct(line.drug)
      if (!product) return null
      const pendingId = `pending:${Date.now()}`
      const setRx = (rec: RxRecord) => set({ prescriptions: { ...get().prescriptions, [encounterId]: rec } })
      // The dispensing unit starts from the drug's dose form; the prescriber can change it.
      setRx({ ...current, added: [...(current.added ?? []), { ...line, id: pendingId }], edits: { ...(current.edits ?? {}), [pendingId]: unitEdit(product.drug?.doseForm) } })
      const encounter = maybeEncounterRow(encounterId)
      createPrescription(
        { patientId: encounter?.patientId ?? '', encounterId, medication: { codings: [{ system: RXNORM, code: product.code, display: product.display }], text: product.display }, substitutionAllowed: line.substitutionAllowed, ...(get().rxPharmacy[encounterId] ? { pharmacyId: get().rxPharmacy[encounterId]!.id } : {}) },
        { 'Idempotency-Key': newIdempotencyKey() },
      )
        .then(async (res) => {
          const p = res.data as Prescription
          const rec = get().rx(encounterId)
          const edits = { ...(rec.edits ?? {}) }
          if (edits[pendingId]) {
            edits[p.id] = edits[pendingId]
            delete edits[pendingId]
          }
          setRx({ ...rec, edits, added: (rec.added ?? []).map((l) => (l.id === pendingId ? { ...l, id: p.id } : l)) })
          set({ rxServer: { ...get().rxServer, [p.id]: { etag: etagOf(res) ?? undefined, alerts: [], queue: Promise.resolve() } } })
          await check(p.id)
        })
        .catch((error: unknown) => {
          const rec = get().rx(encounterId)
          setRx({ ...rec, added: (rec.added ?? []).filter((l) => l.id !== pendingId) })
          toastProblem(error, `${line.drug} was not added`)
        })
      return pendingId
    },

    editRxLine: (encounterId, lineId, patch) => {
      const current = get().rx(encounterId)
      if (current.status === 'signed') return
      const edits = current.edits ?? {}
      const edit = { ...edits[lineId], ...patch }
      set({ prescriptions: { ...get().prescriptions, [encounterId]: { ...current, edits: { ...edits, [lineId]: edit } } } })
      const line = (current.added ?? []).find((l) => l.id === lineId)
      if (!line || lineId.startsWith('pending:')) return
      // Typing in the dose field edits on every key: the save waits until typing pauses.
      window.clearTimeout(saveTimers.get(lineId))
      saveTimers.set(lineId, window.setTimeout(() => saveLine(encounterId, lineId), 600))
    },

    removeRxLine: (encounterId, lineId) => {
      const current = get().rx(encounterId)
      if (current.status === 'signed') return
      set({ prescriptions: { ...get().prescriptions, [encounterId]: { ...current, removedLines: [...current.removedLines, lineId] } } })
    },

    substitute: (encounterId, lineId, drug) => {
      const current = get().rx(encounterId)
      if (current.status === 'signed') return
      set({ prescriptions: { ...get().prescriptions, [encounterId]: { ...current, substitutions: { ...current.substitutions, [lineId]: drug } } } })
    },

    overrideHardStop: ({ encounterId, lineId, reason, reasonText, prescriber, coSigner, auditEvent }) => {
      const current = get().rx(encounterId)
      const override: RxOverride = { lineId, reason, reasonText, prescriber, coSigner, at: new Date().toISOString(), auditEvent }
      set({ prescriptions: { ...get().prescriptions, [encounterId]: { ...current, override, overrides: [...(current.overrides ?? []), override] } } })
      // TODO(gap): the contract takes one reason per alert; the second clinician's signature stays on the screen.
      const open = (get().rxServer[lineId]?.alerts ?? []).filter((a) => a.overrideRequired && !a.override)
      onLine(lineId, async () => {
        for (const a of open) await overrideAlert(a.id, { reason: reasonText ? `${reason}: ${reasonText}` : reason })
        const res = await getPrescription(lineId)
        set({ rxServer: { ...get().rxServer, [lineId]: { ...get().rxServer[lineId], etag: etagOf(res) ?? undefined, alerts: (res.data as Prescription).alerts } } })
        touchRecordOf(lineId)
      }).catch((error: unknown) => toastProblem(error, 'The override was not recorded'))
    },

    signRx: ({ encounterId, by, registrationNo }) => {
      const current = get().rx(encounterId)
      if (current.status === 'signed') return Promise.resolve(false)
      const ids = (current.added ?? []).map((l) => l.id).filter((id) => !current.removedLines.includes(id) && !id.startsWith('pending:'))
      set({ prescriptions: { ...get().prescriptions, [encounterId]: { ...current, status: 'signed', signedBy: by, registrationNo, signedAt: new Date().toISOString() } } })
      // A save still waiting for typing to pause goes first, so the signed version is the one on screen.
      for (const id of ids) {
        if (saveTimers.has(id)) {
          window.clearTimeout(saveTimers.get(id))
          saveTimers.delete(id)
          saveLine(encounterId, id)
        }
      }
      // One prescription per drug: each is signed and sent on its own.
      return (async () => {
        for (const id of ids) {
          // A line signed before an earlier refusal is not signed twice.
          if (get().rxServer[id]?.signed) continue
          await onLine(id, async () => {
            const res = await signAndSendPrescription(id, { 'If-Match': get().rxServer[id]?.etag ?? '', 'Idempotency-Key': newIdempotencyKey() })
            // The transmission status as the sign answer gives it (sent, queued, rejected…), shown on the line.
            const transmission = (res.data as Prescription | undefined)?.transmission
            set({ rxServer: { ...get().rxServer, [id]: { ...get().rxServer[id], etag: etagOf(res) ?? undefined, signed: true, ...(transmission ? { transmission } : {}) } } })
            touchRecordOf(id)
          })
        }
        return true
      })().catch(async (error: unknown) => {
        set({ prescriptions: { ...get().prescriptions, [encounterId]: { ...get().rx(encounterId), status: 'draft', signedBy: undefined, registrationNo: undefined, signedAt: undefined } } })
        // 409, 412 and 428 mean the version on screen is not the server's: read the lines again, so
        // the screen shows what the next Sign sends (and a line signed elsewhere shows as signed).
        // A changed draft needs a safety check on its new version before it can be signed (D99).
        if (error instanceof ApiError && ([409, 412, 428].includes(error.status) || staleCheck(error))) {
          // A 409 means the line is no longer a draft, so there is nothing to check again.
          if (error.status !== 409) await Promise.all(ids.filter((id) => !get().rxServer[id]?.signed).map((id) => check(id).catch(() => undefined)))
          await loadRx(encounterId).catch(() => undefined)
        }
        useUI.getState().toast({ tone: 'critical', title: 'The prescription was not signed', detail: signRefusal(error) })
        return false
      })
    },

    pollRxStatus: (encounterId) => {
      const hidden = () => document.visibilityState === 'hidden'
      const onVisibility = () => {
        if (hidden()) stop()
      }
      const stop = pollStatus({
        pending: () =>
          (get().prescriptions[encounterId]?.added ?? [])
            .map((l) => l.id)
            .filter((id) => get().rxServer[id]?.signed && WAITING_STATUSES.includes(get().rxServer[id]?.transmission?.status ?? '')),
        // Only the status changes on screen; a failed read keeps the last one the server gave.
        read: async (id) => {
          const transmission = ((await getPrescription(id)).data as Prescription | undefined)?.transmission
          if (transmission) set({ rxServer: { ...get().rxServer, [id]: { ...get().rxServer[id], transmission } } })
        },
        isHidden: hidden,
        onStop: () => document.removeEventListener('visibilitychange', onVisibility),
      })
      document.addEventListener('visibilitychange', onVisibility)
      return stop
    },

    confirmProblem: (problemId, by, at) => set({ problemConfirmations: { ...get().problemConfirmations, [problemId]: { by, at } } }),
    confirmProblemList: (encounterId, codes, by, at) => set({ problemListConfirmed: { ...get().problemListConfirmed, [encounterId]: { by, at, codes } } }),

    note: (encounterId) => {
      read(`note:${encounterId}`, () => load(encounterId))
      return get().notes[encounterId] ?? blank(encounterId)
    },

    setSectionText: (encounterId, key, text, provenance = 'typed') => {
      const current = get().note(encounterId)
      if (current.status !== 'draft') return
      patch(encounterId, { text: { ...current.text, [key]: text }, provenance: { ...current.provenance, [key]: provenance } })
    },

    // The local scribe's routing is the sample's; with the API, drafting is draftWithAi.
    applyScribeDraft: () => [],

    draftWithAi: async (encounterId, transcript) => {
      if (get().note(encounterId).status !== 'draft') return []
      const templates = (await listNoteTemplates({ limit: 100 })).data as NoteTemplateList
      const soap = templates.items.find((t) => t.code === SOAP_TEMPLATE_CODE)
      if (!soap) throw new Error('The practice has no SOAP note template (see SCREEN_PORT.md, gap 2).')
      let op: Operation
      try {
        const res = await createNoteDraft({ encounterId, dictation: transcript, templateId: soap.id }, { 'Idempotency-Key': newIdempotencyKey() })
        op = res.data as Operation
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'feature-disabled' || error.status === 503)) throw new AiFeatureDown(problemCopy(error.problem).message)
        throw error
      }
      // A queued or running draft is waited for (as the chart AI does); a failed one is AiFeatureDown.
      const res = await getNote(await finished(op, 'AI draft'))
      const n = res.data as Note
      const keys = publishAi(encounterId, n)
      for (const k of keys) useAI.getState().clearDisposition(`${encounterId}:${k}`)
      set({ notes: { ...get().notes, [encounterId]: fromNote(encounterId, n) }, server: { ...get().server, [encounterId]: serverFrom(n, etagOf(res)) } })
      return keys
    },

    setNoteCode: (encounterId, code) => patch(encounterId, { code }),

    saveDraft: (encounterId, how = 'manual') => {
      if (get().note(encounterId).status !== 'draft') return
      enqueue(encounterId, () => flush(encounterId))
        .then(() => patch(encounterId, { savedHow: how }))
        .catch(async (error: unknown) => {
          if (error instanceof ApiError && error.status === 412) {
            await reload(encounterId)
            useUI.getState().toast({ tone: 'caution', title: 'The note changed elsewhere', detail: 'The saved version is shown. Your unsaved words were not kept.' })
          } else if (how === 'manual') toastProblem(error, 'The draft could not be saved')
        })
    },

    signNote: ({ encounterId }) => {
      let signed: NoteStatus = 'draft'
      return enqueue(encounterId, async () => {
        await flush(encounterId)
        await decideAi(encounterId)
        const server = get().server[encounterId]
        const res = await signNoteApi(server.noteId!, { 'If-Match': server.etag ?? '' })
        const n = res.data as Note
        set({ notes: { ...get().notes, [encounterId]: fromNote(encounterId, n, get().notes[encounterId]) } })
        setServer(encounterId, { etag: etagOf(res) ?? undefined })
        signed = get().notes[encounterId].status
      }).then(
        // What the server made of it: signed, or waiting for the co-signer its rule names.
        () => {
          if (signed === 'signed') requestAfterVisitSummary(encounterId)
          return signed
        },
        (error: unknown) => {
          toastProblem(error, 'The note was not signed')
          return null
        },
      )
    },

    addendum: ({ encounterId, body }) => {
      enqueue(encounterId, async () => {
        const server = get().server[encounterId]
        const res = await addNoteAddendum(server.noteId!, { text: body }, { 'If-Match': server.etag ?? '', 'Idempotency-Key': newIdempotencyKey() })
        setServer(encounterId, { etag: etagOf(res) ?? undefined })
        await reload(encounterId)
      }).catch((error: unknown) => toastProblem(error, 'The addendum was not added'))
    },
  }
})
