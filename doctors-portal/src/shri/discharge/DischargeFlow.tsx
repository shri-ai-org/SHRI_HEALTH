/**
 * The discharge workflow on the patient record (plan 4.6), opened by
 * "Discharge" in the record header, and shaped by how ill the patient is on
 * the record — recorded facts only: the condition record's status and whether
 * the bed is in intensive care.
 *
 * A stable patient goes home: the summary, the medicines and the instructions
 * are shown as they stand, each one tap away; a follow-up is booked or its
 * absence given a reason; the old board's hard rules stand in its words (the
 * financial one blocks the bed's release); an unsigned summary does not block
 * — "discharge now, sign later" — it goes to the sign queue.
 *
 * A seriously ill patient is not offered a routine discharge home — it is shown,
 * refused, with the reason. What is offered instead: a transfer to another
 * facility (who accepted, why, how they travel, the clinical handover); leaving
 * against medical advice (the risks explained, the form's signatory and a
 * witness); or recording a death, which is S-13-06's MCCD.
 *
 * Every path ends in the one handler (`useDischarge`): once per admission,
 * the bed released, the front office told, the audit written. New and
 * flagged: the old build had no discharge types, no transfer out and no LAMA.
 */

import { AlertOctagon, ArrowRight, Ban, Check, DoorOpen, FileText, HeartPulse, Home, ListChecks, Pill as PillIcon, Send, TriangleAlert, Truck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { DISCHARGE_BOARD, encounterForPatient } from '@/data/clinical'
import { NOW, formatDate } from '@/data/format'
import { FACILITIES, HUB, patient, type Patient } from '@/data/kit'
import { conditionFor } from '@/data/record'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'

import { useMayOpenPath } from '../app/landing'
import { cn } from '../lib/cn'
import { useProblemsFor } from '../logic/record'
import { FOLLOW_UP_CLINICS, SUMMARY_SECTIONS, inpatientBed, recordGates, severityFor, summaryKey, useDischarge } from '../logic/discharge'
import { medRecGaps, medRowsFor } from '../logic/medrec'
import { useDischargeFlow, type FlowDraft, type FlowKind } from '../state/dischargeFlow'
import { Alert } from '../ui/Alert'
import { Dialog } from '../ui/Dialog'
import { IcdField } from '../ui/IcdPicker'
import { CheckboxRow, Field, Select, TextInput } from '../ui/forms'
import { Icon, Pill, PillTag } from '../ui/primitives'
import { ValidationSummary } from '../ui/states'
import { VoiceField } from '../ui/VoiceField'

const ESCORTS = ['Doctor', 'Nurse', 'Paramedic'] as const
const TRANSPORT = ['ALS ambulance', 'BLS ambulance', 'Air ambulance'] as const
const RELATIONSHIPS = ['Patient', 'Relative', 'Guardian'] as const
const OUTSIDE = 'outside'

const pad = (n: number) => String(n).padStart(2, '0')
const TOMORROW = (() => {
  const d = new Date(NOW)
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()

export function DischargeFlow() {
  const openFor = useDischargeFlow((s) => s.openFor)
  const close = useDischargeFlow((s) => s.close)
  const p = openFor ? patient(openFor) : undefined
  return p ? <Sheet key={p.id} patient={p} onClose={close} /> : null
}

function Sheet({ patient: p, onClose }: { patient: Patient; onClose: () => void }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const discharge = useDischarge()
  const admissions = useAdmissions((s) => s.admissions)
  const draft = useDischargeFlow((s) => s.drafts[p.id]) ?? {}
  const update = useDischargeFlow((s) => s.update)
  const clear = useDischargeFlow((s) => s.clear)
  const notes = useClinical((s) => s.notes)
  const medRecs = useClinical((s) => s.medRecs)
  const instructions = useClinical((s) => s.instructions)
  const [showValidation, setShowValidation] = useState(false)
  // Offered, never chosen for the doctor: the admission's provisional code, then the open problems.
  const problemList = useProblemsFor(p.id)
  const provisional = admissions[p.id]?.diagnosis
  const dxSuggestions = [
    ...(provisional ? [provisional] : []),
    ...problemList.filter((pr) => pr.status === 'Open' && pr.leaf && pr.icd10 !== provisional?.code).map((pr) => ({ code: pr.icd10, label: pr.label })),
  ]

  const bed = inpatientBed(p.id, admissions)
  const enc = encounterForPatient(p.id)
  const { serious, reasons } = severityFor(p.id, bed)
  const status = conditionFor(p.id)?.status
  const gates = recordGates(p.id)
  const clinicalGates = gates.filter((g) => !g.startsWith('Financial clearance'))
  const board = DISCHARGE_BOARD.find((r) => r.patientId === p.id)
  const kind: FlowKind = draft.kind ?? (serious ? 'transfer' : 'discharge')
  const set = (patch: Partial<FlowDraft>) => {
    setShowValidation(false)
    update(p.id, patch)
  }

  // What the record holds for the three documents, as they stand now.
  const note = enc ? notes[summaryKey(enc.id)] : undefined
  const summarySigned = note?.status === 'signed'
  const written = SUMMARY_SECTIONS.filter((s) => (note?.text[s.key] ?? '').trim().length >= 20).length
  const rows = medRowsFor(p.id)
  const rec = enc ? medRecs[enc.id] : undefined
  const { undecided } = medRecGaps(rows, rec)
  const issued = enc ? (instructions[enc.id]?.issued.length ?? 0) > 0 : false
  const summaryPath = enc ? `/encounter/${enc.id}/discharge-summary` : undefined
  const medRecPath = enc ? `/encounter/${enc.id}/med-rec` : undefined
  const instructionsPath = enc ? `/encounter/${enc.id}/instructions` : undefined
  const deathPath = enc ? `/encounter/${enc.id}/death` : undefined

  const go = (to: string) => {
    onClose()
    navigate(to)
  }

  /* ------------------------------------------------------------ problems */
  const problems: { field: string; message: string }[] = []
  if (kind === 'discharge') {
    if (serious) problems.push({ field: 'Discharge home', message: `not offered while ${p.name} is ${reasons.join(' and ')}` })
    for (const g of gates) problems.push({ field: 'Hard rule', message: g })
    if (!draft.followUp) problems.push({ field: 'Follow-up', message: 'book one, or record that none is needed' })
    if (draft.followUp === 'booked' && !(draft.fuDate && draft.fuDate >= TOMORROW)) problems.push({ field: 'Follow-up date', message: 'a date from tomorrow' })
    if (draft.followUp === 'none' && (draft.fuNoneReason ?? '').trim().length < 5) problems.push({ field: 'No follow-up', message: 'say why none is needed' })
  } else if (kind === 'transfer') {
    if (!draft.facility) problems.push({ field: 'Receiving facility', message: 'choose one' })
    if (draft.facility === OUTSIDE && (draft.outsideName ?? '').trim().length < 3) problems.push({ field: 'Receiving hospital', message: 'name it' })
    if ((draft.clinician ?? '').trim().length < 3) problems.push({ field: 'Accepting clinician', message: 'who accepted the patient' })
    if ((draft.reason ?? '').trim().length < 10) problems.push({ field: 'Reason for transfer', message: 'at least 10 characters' })
    if (!draft.escort) problems.push({ field: 'Escort', message: 'choose one' })
    if (!draft.transport) problems.push({ field: 'Transport', message: 'choose one' })
    if ((draft.handover ?? '').trim().length < 20) problems.push({ field: 'Clinical handover', message: 'dictate or type at least 20 characters' })
    if (!draft.accepted) problems.push({ field: 'Acceptance', message: 'the receiving team has to have accepted the patient' })
  } else {
    if (!draft.lamaRisks) problems.push({ field: 'Risks explained', message: 'tick once the risks are explained' })
    if ((draft.lamaSignedBy ?? '').trim().length < 3) problems.push({ field: 'Form signed by', message: 'the name of whoever signs the form' })
    if (!draft.lamaRelationship) problems.push({ field: 'Relationship', message: 'choose one' })
    if ((draft.lamaWitness ?? '').trim().length < 3) problems.push({ field: 'Witness', message: 'the witness to the signature' })
    if ((draft.lamaReason ?? '').trim().length < 5) problems.push({ field: 'Reason given', message: 'what the patient or family gave as the reason' })
  }
  const ready = problems.length === 0

  function confirm() {
    if (!ready) {
      setShowValidation(true)
      return
    }
    const facility = draft.facility === OUTSIDE ? (draft.outsideName ?? '').trim() : (FACILITIES.find((f) => f.code === draft.facility)?.name ?? '')
    const ok = discharge(p.id, bed, {
      kind,
      careOf: kind === 'discharge' && draft.careOf?.trim() ? draft.careOf.trim() : undefined,
      followUp:
        kind === 'discharge'
          ? draft.followUp === 'booked'
            ? { kind: 'booked', date: draft.fuDate ?? '', clinic: draft.fuClinic || FOLLOW_UP_CLINICS[0], note: (draft.fuNote ?? '').trim() }
            : { kind: 'none', reason: (draft.fuNoneReason ?? '').trim() }
          : undefined,
      transfer:
        kind === 'transfer'
          ? { facility, clinician: (draft.clinician ?? '').trim(), reason: (draft.reason ?? '').trim(), escort: draft.escort ?? '', transport: draft.transport ?? '', handover: (draft.handover ?? '').trim() }
          : undefined,
      lama:
        kind === 'lama'
          ? { signedBy: (draft.lamaSignedBy ?? '').trim(), relationship: draft.lamaRelationship ?? '', witness: (draft.lamaWitness ?? '').trim(), reason: (draft.lamaReason ?? '').trim() }
          : undefined,
      diagnoses: draft.diagnoses?.length ? draft.diagnoses : undefined,
    })
    if (ok) clear(p.id)
    onClose()
  }

  /* ----------------------------------------------------------- the ways */
  const ways: { key: FlowKind; label: string; detail: string; icon: typeof Home; refused?: string }[] = [
    { key: 'discharge', label: 'Discharge home', detail: 'Summary, medicines, instructions and follow-up', icon: Home, refused: serious ? `Not offered while ${p.name} is ${reasons.join(' and ')}.` : undefined },
    { key: 'transfer', label: 'Transfer to another facility', detail: 'Accepted by the receiving team, with a clinical handover', icon: Truck },
    { key: 'lama', label: 'Leave against medical advice', detail: 'Risks explained; the form signed and witnessed', icon: Ban },
  ]
  // A seriously ill patient sees the ways that apply to them first; home stays visible, refused.
  const ordered = serious ? [...ways.filter((w) => w.key !== 'discharge'), ways[0]] : ways

  const footer = (
    // Flush with the dialog's edge (its padding is 22px, plus the safe area on a phone), so nothing scrolls into view beneath it.
    <div className="sticky -bottom-[22px] -mx-[22px] -mb-[22px] mt-[18px] flex flex-wrap items-center justify-end gap-x-[10px] gap-y-[10px] border-t border-sh-line bg-sh-card px-[22px] py-[14px] max-sm:-bottom-[calc(22px+var(--sa-b))] max-sm:-mb-[calc(22px+var(--sa-b))] max-sm:pb-[calc(14px+var(--sa-b))]">
      <Pill variant="control" size="lg" onClick={onClose}>
        Cancel
      </Pill>
      <Pill
        variant="primary"
        size="lg"
        icon={kind === 'transfer' ? Truck : kind === 'lama' ? Ban : DoorOpen}
        aria-disabled={!ready}
        className={cn(!ready && 'opacity-40')}
        onClick={confirm}
      >
        {kind === 'transfer' ? `Transfer ${p.name}` : kind === 'lama' ? 'Record leaving against advice' : 'Discharge home'}
      </Pill>
    </div>
  )

  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      icon={DoorOpen}
      tone={serious ? 'warn' : 'default'}
      title={`Discharge ${p.name}`}
      subtitle={`${p.uhid} · ${bed ?? 'no bed'} · ${status ? `${status} on the condition record` : 'no condition record'}`}
    >
      <div className="flex flex-col gap-[16px]">
        {serious ? (
          <Alert tone="crit" icon={AlertOctagon} title="Seriously ill — a routine discharge home is not offered">
            {p.name} is {reasons.join(' and ')}. A transfer, leaving against medical advice or a death are the ways out of this admission from here.
            {/* The clinical rule, in the old board's words; the financial one holds only a discharge home, and is said below. */}
            {clinicalGates.length > 0 && (
              <ul className="mt-[6px] flex flex-col gap-[4px]">
                {clinicalGates.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            )}
          </Alert>
        ) : (
          <p className="text-[13px] text-sh-text-2">
            {status ? `${status} on the condition record` : 'No condition record'}
            {bed ? ` · bed ${bed}` : ''} — a routine discharge home is available.
          </p>
        )}

        {/* How the patient leaves. */}
        <div role="radiogroup" aria-label="How the patient leaves" className="grid grid-cols-1 gap-[8px] sm:grid-cols-2">
          {ordered.map((w) => {
            const on = w.key === kind
            const refused = Boolean(w.refused)
            return (
              <button
                key={w.key}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={refused || undefined}
                onClick={() => {
                  // A refused way is not chosen; its reason is on its card.
                  if (!refused) set({ kind: w.key })
                }}
                className={cn(
                  'flex min-h-[64px] items-start gap-[12px] rounded-[16px] px-[14px] py-[12px] text-left transition-colors duration-150',
                  on ? 'bg-sh-inner shadow-[inset_0_0_0_2px_var(--primary)]' : 'bg-sh-inner hover:bg-sh-hover-strong',
                  refused && 'opacity-70',
                )}
              >
                <Icon icon={w.icon} size={18} className="mt-[2px] text-sh-text-2" />
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-sh-text">{w.label}</span>
                  <span className={cn('block text-[12px]', refused ? 'font-medium text-sh-crit-fg' : 'text-sh-text-2')}>{w.refused ?? w.detail}</span>
                </span>
              </button>
            )
          })}
        </div>
        {/* A death is certified on its own screen — S-13-06, which needs discharge.sign. */}
        {deathPath && may(deathPath) && (
          <Pill variant="ghost" size="md" icon={HeartPulse} className="self-start" onClick={() => go(deathPath)}>
            Record a death — MCCD and body handover
          </Pill>
        )}

        {showValidation && problems.length > 0 && <ValidationSummary problems={problems} />}

        {/* The documents, as the record holds them — none blocks; each is one tap away. */}
        <Section title="On the record">
          <DocRow
            icon={FileText}
            label="Discharge summary"
            state={!enc ? 'No encounter on record — no summary can be written for this admission' : summarySigned ? 'Signed' : note ? `${written} of 6 sections written · unsigned — it goes to the sign queue` : 'Not started · unsigned — it goes to the sign queue'}
            done={summarySigned}
            action={summaryPath && may(summaryPath) ? () => go(summaryPath) : undefined}
          />
          {kind !== 'lama' && (
            <DocRow
              icon={PillIcon}
              label="Medication reconciliation"
              state={rows.length === 0 ? 'No medicine list on the record to reconcile' : rec?.confirmedAt ? 'Confirmed' : `${rows.length - undecided.length} of ${rows.length} reconciled · open`}
              done={rows.length > 0 && Boolean(rec?.confirmedAt)}
              action={rows.length > 0 && medRecPath && may(medRecPath) ? () => go(medRecPath) : undefined}
            />
          )}
          {kind === 'discharge' && (
            <DocRow
              icon={ListChecks}
              label="Patient instructions"
              state={!enc ? 'No encounter on record' : issued ? 'Issued' : 'Not issued'}
              done={issued}
              action={instructionsPath && may(instructionsPath) ? () => go(instructionsPath) : undefined}
            />
          )}
          {board && board.financialClearance !== 'Clear' && kind !== 'discharge' && (
            <p className="flex items-start gap-[8px] px-[4px] text-[12px] font-medium text-sh-warn-fg">
              <Icon icon={TriangleAlert} size={13} className="mt-[2px] shrink-0" />
              Financial clearance is outstanding: {board.financialClearance}. It goes to the front office with this {kind === 'transfer' ? 'transfer' : 'record'}; it does not hold the patient.
            </p>
          )}
        </Section>

        <Section title="Final diagnosis">
          <IcdField
            id={`dc-dx-${p.id}`}
            label="ICD-10 codes (optional)"
            value={draft.diagnoses ?? []}
            onChange={(diagnoses) => set({ diagnoses })}
            suggestions={dxSuggestions}
            multiple
            hint="The first code is the principal diagnosis. It goes on the discharge record and into the audit."
          />
        </Section>

        {kind === 'discharge' && (
          <>
            <Section title="Going home">
              <Field label="In the care of" htmlFor="dc-careof" hint="Optional — the relative or carer taking the patient home">
                <TextInput id="dc-careof" value={draft.careOf ?? ''} onChange={(e) => set({ careOf: e.target.value })} placeholder="Name and relationship" />
              </Field>
            </Section>
            <Section title="Follow-up">
              <Choice
                label="Follow-up"
                value={draft.followUp ?? ''}
                options={[
                  { key: 'booked', label: 'Book a follow-up' },
                  { key: 'none', label: 'No follow-up needed' },
                ]}
                onChange={(v) => set({ followUp: v as FlowDraft['followUp'] })}
              />
              {draft.followUp === 'booked' && (
                <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
                  <Field label="Date" required htmlFor="dc-fu-date" hint={`From ${formatDate(new Date(`${TOMORROW}T00:00`))}`}>
                    <TextInput id="dc-fu-date" type="date" min={TOMORROW} value={draft.fuDate ?? ''} onChange={(e) => set({ fuDate: e.target.value })} />
                  </Field>
                  <Field label="Clinic" required htmlFor="dc-fu-clinic">
                    <Select id="dc-fu-clinic" value={draft.fuClinic || enc?.department || FOLLOW_UP_CLINICS[0]} onChange={(e) => set({ fuClinic: e.target.value })}>
                      {FOLLOW_UP_CLINICS.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Note for the front office" htmlFor="dc-fu-note" className="sm:col-span-2">
                    <TextInput id="dc-fu-note" value={draft.fuNote ?? ''} onChange={(e) => set({ fuNote: e.target.value })} placeholder="Tests to have done before the visit, say" />
                  </Field>
                </div>
              )}
              {draft.followUp === 'none' && (
                <Field label="Why no follow-up is needed" required htmlFor="dc-fu-none">
                  <TextInput id="dc-fu-none" value={draft.fuNoneReason ?? ''} onChange={(e) => set({ fuNoneReason: e.target.value })} placeholder="Resolved; the GP follows up, say" />
                </Field>
              )}
            </Section>
            {gates.length > 0 && !serious && (
              <Alert tone="warn" icon={TriangleAlert} title="Held by a hard rule">
                <ul className="flex flex-col gap-[4px]">
                  {gates.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </Alert>
            )}
          </>
        )}

        {kind === 'transfer' && (
          <Section title="Transfer">
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
              <Field label="Receiving facility" required htmlFor="tr-facility">
                <Select id="tr-facility" value={draft.facility ?? ''} onChange={(e) => set({ facility: e.target.value })}>
                  <option value="">Choose…</option>
                  {FACILITIES.filter((f) => f.code !== HUB.code).map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.name}
                    </option>
                  ))}
                  <option value={OUTSIDE}>Outside the network…</option>
                </Select>
              </Field>
              {draft.facility === OUTSIDE && (
                <Field label="Receiving hospital" required htmlFor="tr-outside">
                  <TextInput id="tr-outside" value={draft.outsideName ?? ''} onChange={(e) => set({ outsideName: e.target.value })} placeholder="Hospital and city" />
                </Field>
              )}
              <Field label="Accepting clinician" required htmlFor="tr-clinician">
                <TextInput id="tr-clinician" value={draft.clinician ?? ''} onChange={(e) => set({ clinician: e.target.value })} placeholder="Name, speciality" />
              </Field>
              <Field label="Escort" required htmlFor="tr-escort">
                <Select id="tr-escort" value={draft.escort ?? ''} onChange={(e) => set({ escort: e.target.value })}>
                  <option value="">Choose…</option>
                  {ESCORTS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Transport" required htmlFor="tr-transport">
                <Select id="tr-transport" value={draft.transport ?? ''} onChange={(e) => set({ transport: e.target.value })}>
                  <option value="">Choose…</option>
                  {TRANSPORT.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason for transfer" required htmlFor="tr-reason" className="sm:col-span-2">
                <TextInput id="tr-reason" value={draft.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} placeholder="The care needed that is not available here" />
              </Field>
            </div>
            <VoiceField
              id={`tr-handover-${p.id}`}
              label="Clinical handover"
              required
              rows={4}
              value={draft.handover ?? ''}
              onChange={(v) => set({ handover: v })}
              placeholder="Diagnosis, current state, treatment given, lines and drains, what the receiving team must watch for…"
              typedPlaceholder="Diagnosis, current state, treatment given, lines and drains, what the receiving team must watch for…"
            />
            <CheckboxRow checked={Boolean(draft.accepted)} onChange={(v) => set({ accepted: v })} className="-mx-[10px] w-[calc(100%+20px)]">
              The receiving team has accepted the patient
              <span className="block text-[12px] text-sh-text-3">A transfer is sent only once it has been accepted — never on the way to asking.</span>
            </CheckboxRow>
          </Section>
        )}

        {kind === 'lama' && (
          <Section title="Leaving against medical advice">
            <Alert tone="warn" icon={Send} title="The patient leaves with the risks understood">
              The team&rsquo;s advice stands on the record. The form is signed by the patient, or by a relative or guardian for them, and witnessed.
            </Alert>
            <CheckboxRow checked={Boolean(draft.lamaRisks)} onChange={(v) => set({ lamaRisks: v })} className="-mx-[10px] w-[calc(100%+20px)]">
              I have explained the risks of leaving now — including worsening, disability and death — in a language they understand, and that they can come back at any time.
            </CheckboxRow>
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
              <Field label="Form signed by" required htmlFor="lama-signed">
                <TextInput id="lama-signed" value={draft.lamaSignedBy ?? ''} onChange={(e) => set({ lamaSignedBy: e.target.value })} placeholder="Full name" />
              </Field>
              <Field label="Relationship" required htmlFor="lama-rel">
                <Select id="lama-rel" value={draft.lamaRelationship ?? ''} onChange={(e) => set({ lamaRelationship: e.target.value })}>
                  <option value="">Choose…</option>
                  {RELATIONSHIPS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Witness" required htmlFor="lama-witness">
                <TextInput id="lama-witness" value={draft.lamaWitness ?? ''} onChange={(e) => set({ lamaWitness: e.target.value })} placeholder="Staff member's name" />
              </Field>
              <Field label="Reason given" required htmlFor="lama-reason">
                <TextInput id="lama-reason" value={draft.lamaReason ?? ''} onChange={(e) => set({ lamaReason: e.target.value })} placeholder="In their words" />
              </Field>
            </div>
          </Section>
        )}

        {footer}
      </div>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[10px]">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{title}</h3>
      {children}
    </section>
  )
}

function DocRow({ icon, label, state, done, action }: { icon: typeof Home; label: string; state: string; done: boolean; action?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] rounded-[14px] bg-sh-inner px-[14px] py-[10px]">
      <Icon icon={icon} size={16} className="text-sh-text-2" />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-sh-text">{label}</span>
        <span className="block text-[12px] text-sh-text-2">{state}</span>
      </span>
      {done && (
        <PillTag tone="norm" size="xs" icon={Check} className="font-semibold">
          Done
        </PillTag>
      )}
      {action && (
        <Pill variant="control" size="md" icon={ArrowRight} onClick={action}>
          Open
        </Pill>
      )}
    </div>
  )
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: { key: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-x-[8px] gap-y-[10px]">
      {options.map((o) => {
        const on = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.key)}
            className={cn('inline-flex h-[44px] items-center gap-[6px] rounded-full px-[16px] text-[13px] font-medium transition-colors duration-150', on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-control text-sh-text-2 hover:text-sh-text')}
          >
            {on && <Icon icon={Check} size={14} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
