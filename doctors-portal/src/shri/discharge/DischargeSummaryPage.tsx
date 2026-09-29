/**
 * S-13-02 · Discharge summary — `/encounter/:id/discharge-summary`
 * (`src/screens/m13/S1302.tsx`): "The discharge summary, drafted from the
 * admission and blocked until complete."
 *
 * AI-106 is a G3 touchpoint — attest, not merely confirm — because a discharge
 * summary enters the legal record and is published to ABDM. The six sections
 * open empty; each is a `VoiceField`, spoken first, typed always. "Draft with
 * AI" fills them as AI-106 ghost drafts, each needing a decision, and the
 * whole document is then attested once, in fixed words, and signed by name.
 * The text lives in the clinical store, so leaving and returning loses nothing.
 *
 * Where the old screen fell short: it offered R. Lakshmanan's draft on every
 * patient's summary, and fell back to his encounter at an unknown address —
 * here the draft is his alone, and an unknown encounter says so. It let anyone
 * who could write the summary sign it — here signing needs discharge.sign, and
 * a registrar saves it for co-sign. Its attestation stood once ticked, whatever
 * changed afterwards — here a change after the tick asks for it again. It
 * promised a bilingual print with no translation to print — here the summary
 * prints in English and says why. And "discharge now, sign later" moves the
 * bed release from signing to the discharge itself.
 */

import { ArrowRight, Check, FileSignature, Lock, PenLine, Pill as PillIcon, Printer, Save, Signature, Sparkles, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { can } from '@/atlas/personas'
import { problemsFor, type Encounter } from '@/data/clinical'
import { NOW, formatDate, formatDateTime, formatTime } from '@/data/format'
import { LANGUAGES, patient } from '@/data/kit'
import { decided, useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical, type SectionProvenance } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import {
  ON_SIGNING,
  SUMMARY_ENGLISH_ONLY,
  SUMMARY_SECTIONS,
  languageLabel,
  summaryDraftFor,
  summaryKey,
  summaryTouchpoint,
  usePublishSummary,
} from '../logic/discharge'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { DEFAULT_LANGUAGE } from '../logic/instructions'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { useAiActive, useForcedState } from '../state/ai'
import { GhostSection } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Select } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { PrintPreview } from '../ui/PrintPreview'
import { LockedBanner, ValidationSummary } from '../ui/states'
import { VoiceField } from '../ui/VoiceField'

const MODEL = 'discharge-draft v3.1.0'

export function DischargeSummaryPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-13-02" />
  return <DischargeSummary key={enc.id} enc={enc} />
}

function DischargeSummary({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const persona = useSession((s) => s.persona)
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const dispositions = useAI((s) => s.dispositions)
  const publish = usePublishSummary()

  const note = useClinical((s) => s.note)
  const setSectionText = useClinical((s) => s.setSectionText)
  const applyScribeDraft = useClinical((s) => s.applyScribeDraft)
  const saveDraft = useClinical((s) => s.saveDraft)
  const signNote = useClinical((s) => s.signNote)
  const setPatientLanguage = useClinical((s) => s.setPatientLanguage)
  const noteId = summaryKey(enc.id)
  // Subscribing to this summary's record re-renders on every change to it.
  useClinical((s) => s.notes[noteId])
  const record = note(noteId)

  const p = patient(enc.patientId)
  const discharged = useClinical((s) => s.discharges[p.id])
  const language = useClinical((s) => s.patientLanguages[p.id]) ?? DEFAULT_LANGUAGE
  const drafts = summaryDraftFor(p.id)

  const [confirming, setConfirming] = useState(false)
  const [showValidation, setShowValidation] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  /** The text as it stood when the declaration was ticked — a change after it asks for it again. */
  const [attestedOver, setAttestedOver] = useState<string | null>(null)

  const locked = record.status === 'signed' || forced === 'LOCKED'
  const maySign = can(persona, 'discharge.sign')
  const medRec = `/encounter/${enc.id}/med-rec`
  const board = '/discharge/board'
  // A forced AI-LOW shows how a low-confidence draft arrives: collapsed, to be expanded before it can be accepted.
  const band = forced === 'AI-LOW' ? ('LOW' as const) : ('MED' as const)
  const score = band === 'LOW' ? undefined : 0.81

  // ARC-15: autosave every 20 s, silently.
  useEffect(() => {
    if (locked) return
    const t = window.setInterval(() => saveDraft(noteId, 'auto'), 20_000)
    return () => window.clearInterval(t)
  }, [noteId, locked, saveDraft])

  /** The stored text is the only text that counts — never the draft on its own. */
  const valueOf = (key: string) => record.text[key] ?? ''
  const isScribe = (key: string) => aiActive && drafts !== undefined && record.provenance[key] === 'scribe'
  // Deferred is undecided: it must never let a blank section through to attestation.
  const outstanding = SUMMARY_SECTIONS.filter((s) => isScribe(s.key) && !decided(dispositions[summaryTouchpoint(enc.id, s.key)])).length
  const written = SUMMARY_SECTIONS.filter((s) => valueOf(s.key).trim().length >= 20).length
  const snapshot = JSON.stringify(SUMMARY_SECTIONS.map((s) => valueOf(s.key)))
  const attested = attestedOver === snapshot
  const staleAttestation = attestedOver !== null && !attested

  const problems: { field: string; message: string }[] = []
  for (const s of SUMMARY_SECTIONS) {
    if (s.required && valueOf(s.key).trim().length < 20) problems.push({ field: s.label, message: 'required — dictate or type at least 20 characters' })
  }
  if (outstanding > 0) problems.push({ field: 'AI-106 drafts', message: `${outstanding} drafted ${outstanding === 1 ? 'section needs' : 'sections need'} a decision` })
  if (!attested) problems.push({ field: 'Attestation', message: staleAttestation ? 'the summary changed after you ticked it — review it and tick it again' : 'a G3 touchpoint needs your signature, not just a click' })
  const canSign = !locked && problems.length === 0

  const label = languageLabel(language)
  const printsIn = language === 'EN' ? 'prints in English' : `prints in English only — no ${label} translation`
  const aiAccepted = SUMMARY_SECTIONS.filter((s) => {
    const d = dispositions[summaryTouchpoint(enc.id, s.key)]?.disposition
    return isScribe(s.key) && (d === 'Accepted' || d === 'Accepted with edits')
  }).length

  function draftAll() {
    const applied = applyScribeDraft(
      noteId,
      SUMMARY_SECTIONS.map((s) => s.key),
      drafts,
    )
    toast({
      tone: 'info',
      title: applied.length === 0 ? 'Nothing to draft — every section already has your words' : `${applied.length} of 6 sections drafted from the record`,
      detail:
        applied.length === 0
          ? 'The scribe never overwrites what you dictated or typed.'
          : 'AI-106 read signed entries only. Each drafted section needs a decision, then you attest by name.',
    })
  }

  function askToSign() {
    if (!canSign) {
      setShowValidation(true)
      return
    }
    setConfirming(true)
  }

  function sign() {
    setConfirming(false)
    const status = signNote({ encounterId: noteId, by: me.name, registrationNo: me.identifier, canSign: maySign })
    if (status === 'signed') {
      audit({ event: 'NOTE.SIGNED', actor: me.name, actorId: me.id, subject: p.id, detail: `Discharge summary signed · ${encounterLabel(enc)} · ABDM publish queued` })
      if (aiAccepted > 0) {
        audit({
          event: 'AI.ATTESTED',
          actor: me.name,
          actorId: me.id,
          subject: p.id,
          model: MODEL,
          gate: 'G3',
          detail: `AI-106 · discharge summary, ${aiAccepted} drafted ${aiAccepted === 1 ? 'section' : 'sections'} · ${me.identifierKind} ${me.identifier}`,
        })
      }
      publish(p.id, enc.id)
      toast({
        tone: 'success',
        title: 'Discharge summary published',
        detail: `Stamped ${me.name} · ${me.identifier}. ABDM publish queued; ${discharged ? 'the bed was released at discharge.' : 'discharging from the board releases the bed.'}`,
      })
    } else {
      audit({ event: 'NOTE.COSIGN_QUEUED', actor: me.name, actorId: me.id, subject: p.id, detail: `Discharge summary saved for co-sign · ${encounterLabel(enc)}` })
      toast({ tone: 'caution', title: 'Saved for co-sign', detail: "You hold discharge.write but not discharge.sign. It is now in the consultant's queue." })
    }
  }

  const signedLine = `${record.signedBy ?? me.name}${record.coSignedBy ? `, co-signed by ${record.coSignedBy}` : ''}`
  const signedAt = formatDateTime(record.signedAt ? new Date(record.signedAt) : NOW)

  const section = (s: (typeof SUMMARY_SECTIONS)[number]) => {
    const key = summaryTouchpoint(enc.id, s.key)
    const scribe = isScribe(s.key)
    const d = dispositions[key]
    const accepted = d?.disposition === 'Accepted' || d?.disposition === 'Accepted with edits'
    /** Accepted text stays the AI's; words typed into an empty or rejected section are the clinician's. */
    const provenanceFor = (v: string): SectionProvenance | undefined => (!scribe ? undefined : accepted || v.trim() === '' ? 'scribe' : 'typed')
    const field = (
      <VoiceField
        id={key}
        label={s.label}
        required={s.required}
        rows={s.key === 'course' ? 6 : 3}
        value={valueOf(s.key)}
        disabled={locked}
        onChange={(v) => setSectionText(noteId, s.key, v, provenanceFor(v))}
        onDictated={(meta) => setSectionText(noteId, s.key, meta.text, 'dictated')}
        placeholder={d?.disposition === 'Rejected' ? `Draft rejected. Dictate or type the ${s.label.toLowerCase()}…` : undefined}
      />
    )
    const draft = scribe ? drafts?.[s.key] : undefined
    return (
      <GhostSection
        key={s.key}
        touchpointId={key}
        capabilityId="AI-106"
        label={s.label}
        draft={draft}
        band={band}
        score={score}
        gate="G3"
        attestation="page"
        locked={locked}
        value={valueOf(s.key)}
        field={field}
        onAccept={() => setSectionText(noteId, s.key, draft ?? '', 'scribe')}
        onEdit={() => setSectionText(noteId, s.key, draft ?? '', 'scribe')}
        onReject={() => setSectionText(noteId, s.key, '', 'scribe')}
        onUndo={() => setSectionText(noteId, s.key, '', 'scribe')}
        explain={{
          touchpointId: key,
          capabilityId: 'AI-106',
          claim: `The ${s.label.toLowerCase()} section, drafted from the admission record and the course of treatment.`,
          confidence: score ?? 0.42,
          band,
          computedAt: formatTime(NOW),
          inputs: [
            { label: 'Admission note', source: `IP number ${enc.encounterNo.split('/').slice(1).join('/')}` },
            { label: 'Signed progress notes', source: 'Notes, whole admission' },
            { label: 'Results across the admission', source: `Results for ${p.id}` },
            ...problemsFor(p.id).map((pr) => ({ label: `${pr.label} (${pr.icd10})`, source: 'Problem list' })),
          ],
          evidence: ['Assembled from signed entries only — it does not read unsigned drafts.'],
          model: MODEL,
          limits: [
            'Drafts from what was charted. A conversation with the family that was not documented is not in it.',
            'At G3 it does not enter the record until you attest to it by name.',
            'Dictating or typing the section yourself is always available.',
          ],
        }}
      />
    )
  }

  return (
    <>
      <ScreenFrame
        screenId="S-13-02"
        patient={p}
        heading="Discharge summary"
        sub={locked ? `Signed · ${printsIn}` : `${written} of ${SUMMARY_SECTIONS.length} sections written · ${printsIn}`}
        chips={
          record.status === 'cosign-pending' && !locked ? (
            <PillTag tone="pend" size="sm" icon={PenLine}>
              Co-sign pending
            </PillTag>
          ) : (
            <PillTag tone={locked ? 'neu' : 'warn'} size="sm" icon={locked ? Lock : PenLine}>
              {locked ? 'Signed' : 'Draft'}
            </PillTag>
          )
        }
        actions={
          <>
            {/* The one AI path — only where there is a draft of this patient's admission to offer. */}
            {!locked && aiActive && drafts && (
              <Pill variant="accent" size="xl" icon={Sparkles} iconSize={17} onClick={draftAll}>
                Draft with AI
              </Pill>
            )}
            {may(medRec) && (
              <Pill variant="card" size="xl" icon={PillIcon} iconSize={17} onClick={() => navigate(medRec)}>
                Medication reconciliation
              </Pill>
            )}
          </>
        }
        rail={
          <div className="flex flex-col gap-[16px]">
            <Card titleSize="sm" title="Patient's language">
              <Select value={language} disabled={locked} onChange={(e) => setPatientLanguage(p.id, e.target.value)} aria-label="Patient's language">
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
              <p className="mt-[8px] text-[12px] text-sh-text-3">
                Follows the patient&rsquo;s preference, not yours.
                {language !== 'EN' && ` No ${label} translation of the summary is available, so it prints in English with that stated on it.`}
              </p>
            </Card>
            <Why label="What happens on signing">
              <ul className="flex flex-col gap-[8px]">
                {ON_SIGNING.map((t) => (
                  <li key={t} className="flex gap-[8px]">
                    <Icon icon={Check} size={13} className="mt-[3px] shrink-0 text-sh-norm-fg" />
                    {t}
                  </li>
                ))}
              </ul>
              <p className="mt-[8px]">The bed is released by the discharge itself, on the board — the summary can be signed after it.</p>
              <p className="mt-[8px] text-sh-text-3">
                On request, AI-106 drafts the six sections from the admission note, the course of treatment, the results and the medication record, from signed entries only.
                Dictating or typing each section yourself is the default.
              </p>
            </Why>
          </div>
        }
        railTitle="Discharge"
        actionBar={
          locked ? (
            <>
              <span className="flex items-center gap-[8px] text-[13px] tabular-nums text-sh-text-2">
                <Icon icon={Lock} size={14} />
                Signed by {signedLine} · {signedAt}
              </span>
              <div className="ml-auto flex flex-wrap gap-x-[8px] gap-y-[10px]">
                <Pill variant="control" size="lg" icon={Printer} onClick={() => setPrintOpen(true)}>
                  Print A4
                </Pill>
                {may(board) && (
                  <Pill variant="primary" size="lg" icon={ArrowRight} onClick={() => navigate(board)}>
                    Back to the board
                  </Pill>
                )}
              </div>
            </>
          ) : (
            <>
              <Pill
                variant="control"
                size="lg"
                icon={Save}
                onClick={() => {
                  saveDraft(noteId, 'manual')
                  toast({ tone: 'info', title: 'Draft saved', detail: 'Nothing is signed. The summary stays a draft until you attest and sign it.' })
                }}
              >
                Save draft
              </Pill>
              <span className="text-[12px] tabular-nums text-sh-text-2">
                {record.savedAt ? `${record.savedHow === 'auto' ? 'Autosaved' : 'Saved'} ${formatTime(new Date(record.savedAt))}` : 'Autosave on'}
              </span>
              <span className="text-[13px] text-sh-text-2">
                {outstanding > 0
                  ? `${outstanding} drafted ${outstanding === 1 ? 'section needs' : 'sections need'} a decision`
                  : written < SUMMARY_SECTIONS.length
                    ? `${written} of ${SUMMARY_SECTIONS.length} sections written`
                    : problems.length > 0
                      ? `${problems.length} outstanding`
                      : 'Ready to attest'}
              </span>
              <Pill
                variant="primary"
                size="lg"
                icon={maySign ? Signature : FileSignature}
                className={cn('ml-auto', !canSign && 'opacity-40')}
                aria-disabled={!canSign}
                title={canSign ? undefined : 'All six sections, a decision on every draft, and the attestation are needed'}
                onClick={askToSign}
              >
                {maySign ? 'Attest and sign' : 'Save for co-sign'}
              </Pill>
            </>
          )
        }
      >
        {locked && <LockedBanner by={signedLine} at={signedAt} reason="signed" />}
        {!locked && record.status === 'draft' && record.returned && (
          <Alert tone="warn" icon={Undo2} title={`Returned by ${record.returned.by}`}>
            &ldquo;{record.returned.comment}&rdquo; · {formatDateTime(new Date(record.returned.at))}
          </Alert>
        )}
        {/* Discharge now, sign later: the discharge has happened; the summary is what is owed. */}
        {!locked && discharged && (
          <Alert tone="info" title={`${p.name} was discharged at ${formatTime(new Date(discharged.at))} by ${discharged.by}`}>
            The discharge stands. This summary is what is still owed —{' '}
            {maySign ? 'sign it here and it goes to the patient and the referring doctor.' : 'save it for co-sign; once a consultant co-signs it, it goes to the patient and the referring doctor.'}
          </Alert>
        )}
        {!maySign && !locked && (
          <Alert tone="warn" title="You may write this summary but not sign it">
            A consultant signs it. Your summary is saved as <strong className="font-semibold text-sh-text">Co-sign pending</strong> and appears in their queue.
          </Alert>
        )}
        {!locked && (showValidation || forced === 'VALIDATION') && problems.length > 0 && <ValidationSummary problems={problems} />}

        <Card titleSize="sm" title="Summary" headerClassName="mb-[4px]">
          <p className="mb-[12px] text-[12px] text-sh-text-3">Six sections, all required · dictate or type{drafts && aiActive ? ', or Draft with AI' : ''}</p>
          <div className="flex flex-col gap-[20px]">{SUMMARY_SECTIONS.map(section)}</div>
        </Card>

        <Card titleSize="sm" title="Attestation" headerClassName="mb-[4px]">
          <p className="mb-[8px] text-[12px] text-sh-text-3">Fixed wording, required at G3 — it is not editable and it is stamped with your registration number</p>
          <CheckboxRow
            checked={attested || (locked && record.status === 'signed')}
            disabled={locked}
            onChange={(v) => setAttestedOver(v ? snapshot : null)}
            className="-mx-[10px] w-[calc(100%+20px)]"
          >
            I have reviewed this content and it is accurate.
            <span className="block text-[12px] tabular-nums text-sh-text-3">
              {me.name} · {me.identifierKind} {me.identifier} · will stamp {formatDate(NOW)}
            </span>
          </CheckboxRow>
          {staleAttestation && !locked && (
            <p role="status" className="mt-[6px] text-[12px] font-medium text-sh-warn-fg">
              The summary changed after you ticked this. Review it and tick it again.
            </p>
          )}
          <Why label="Why attest rather than confirm" className="mt-[8px]">
            <p>
              A discharge summary enters the legal medical record and is published to ABDM, so AI-106 sits at G3. Accepting the drafted sections is not enough: the primary
              action requires a signature and this fixed-wording attestation that you have reviewed the content.
            </p>
          </Why>
        </Card>
      </ScreenFrame>

      <ConfirmDialog
        open={confirming}
        title={maySign ? 'Attest and sign this discharge summary?' : 'Save this discharge summary for co-sign?'}
        consequence={
          maySign
            ? `Attesting is irreversible. The summary is committed to the legal record with your name and registration number, printed${language === 'EN' ? '' : ' in English only'}, published to ABDM, pushed to the patient app and copied to the referring doctor. After this it can only be amended.`
            : 'It goes to the consultant’s queue as Co-sign pending. It is not published, printed or sent until a consultant co-signs it.'
        }
        confirmLabel={maySign ? 'Attest and sign' : 'Save for co-sign'}
        onConfirm={sign}
        onCancel={() => setConfirming(false)}
      />

      <PrintPreview
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="Discharge summary"
        patient={p}
        meta={`${enc.encounterNo} · signed by ${signedLine} · ${signedAt} · English${language === 'EN' ? '' : ' only'}`}
        sections={[
          ...SUMMARY_SECTIONS.map((s) => ({ heading: s.label, body: valueOf(s.key) })),
          ...(language === 'EN' ? [] : [{ heading: 'Language', body: SUMMARY_ENGLISH_ONLY }]),
        ]}
      />
    </>
  )
}
