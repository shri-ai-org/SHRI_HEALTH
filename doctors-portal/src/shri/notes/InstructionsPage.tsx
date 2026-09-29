/**
 * S-06-08 · Patient instructions — `/encounter/:id/instructions`
 * (`src/screens/m06/S0608.tsx`): "What the patient is told, in the language
 * they read."
 *
 * AI-111's guardrail shapes the layout: "THE CLINICIAN'S OWN WORDING IS
 * RETAINED ALONGSIDE." So it is two columns — what you wrote, and what the
 * patient will read — rather than a rewrite that overwrites you. CMP-DPDP-02
 * requires the patient's language, not the user's, so the language is bound
 * to the patient and kept with them.
 *
 * Where the old screen fell short, this one keeps the rules it states: the
 * rewrite is offered only to the patient it was written for, and needs a
 * decision before it is issued (G2); Edit opens it for editing; the
 * translation is printed only beside the text it translates; and Issue is a
 * real act — kept on the encounter, on the audit trail, and recorded as sent
 * on the patient's channels, the SMS a pointer only.
 */

import { Globe, Printer, Send, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import type { Encounter } from '@/data/clinical'
import { NOW, formatDateTime, formatTime } from '@/data/format'
import { LANGUAGES, patient } from '@/data/kit'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical, type InstructionChannel } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { CHANNEL_WORD, DEFAULT_LANGUAGE, ENGLISH_ONLY, issuedDetail, rewriteFor, translationFor } from '../logic/instructions'
import { useAiActive, useForcedState } from '../state/ai'
import { useNotifications } from '../state/notifications'
import { AIActionBar } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Select } from '../ui/forms'
import { Card, Diamond, Pill, PillTag } from '../ui/primitives'
import { PrintPreview } from '../ui/PrintPreview'
import { ValidationSummary } from '../ui/states'
import { VoiceField } from '../ui/VoiceField'

import { NoSuchEncounter } from './ConsultationPage'

const CHANNELS: { key: InstructionChannel; label: string }[] = [
  { key: 'print', label: 'Printed A5, bilingual' },
  { key: 'app', label: 'Patient app, in their language' },
  { key: 'sms', label: 'SMS notification' },
]

export function InstructionsPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-06-08" />
  return <Instructions key={enc.id} enc={enc} />
}

function Instructions({ enc }: { enc: Encounter }) {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const p = patient(enc.patientId)

  const instructionsFor = useClinical((s) => s.instructionsFor)
  // Subscribing to this encounter's record re-renders on every change to it.
  useClinical((s) => s.instructions[enc.id])
  const setInstructions = useClinical((s) => s.setInstructions)
  const issueInstructions = useClinical((s) => s.issueInstructions)
  const setPatientLanguage = useClinical((s) => s.setPatientLanguage)
  const language = useClinical((s) => s.patientLanguages[p.id]) ?? DEFAULT_LANGUAGE
  const rec = instructionsFor(enc.id)

  const touchpointId = `${enc.id}:instructions`
  const disposition = useAI((s) => s.dispositions[touchpointId])
  const clearDisposition = useAI((s) => s.clearDisposition)
  const rewrite = rewriteFor(p.id)
  const [showValidation, setShowValidation] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)

  const locked = forced === 'LOCKED'
  const decided = disposition !== undefined && disposition.disposition !== 'Deferred'
  const rejected = disposition?.disposition === 'Rejected'
  const aiDraft = rec.patientSource === 'ai'
  /** An undecided rewrite is the AI's draft: with the AI off it is withheld, never shown as if it were yours. */
  const patientText = aiDraft && !decided && !aiActive ? '' : rec.patient
  const hasPatient = patientText.trim() !== ''
  const undecided = aiActive && aiDraft && !decided
  const translation = hasPatient ? translationFor(p.id, patientText, language, aiActive) : undefined
  const languageLabel = LANGUAGES.find((l) => l.code === language)?.label ?? language
  const channels = CHANNELS.map((c) => c.key).filter((c) => rec.channels[c])
  const last = rec.issued[rec.issued.length - 1]
  const unchanged = last !== undefined && last.text === patientText && last.language === language && last.channels.join() === channels.join()

  /** Every rule that holds Issue back. Empty ⇒ it may go. */
  const problems: { field: string; message: string; target: string }[] = []
  if (rec.clinician.trim() === '') problems.push({ field: 'Your wording', message: 'Dictate or type your instructions first', target: 'clinician-text' })
  if (!hasPatient) problems.push({ field: 'What the patient reads', message: 'Draft the patient version to issue', target: 'patient-version' })
  if (undecided) problems.push({ field: 'What the patient reads', message: '1 AI draft needs a decision', target: 'patient-version' })
  if (channels.length === 0) problems.push({ field: 'Channels', message: 'Choose at least one channel', target: 'patient-version' })
  if (unchanged) problems.push({ field: 'Issue', message: 'Already issued, and nothing has changed since', target: 'patient-version' })
  const canIssue = !locked && problems.length === 0

  const printWord = language === 'EN' ? 'english' : translation ? 'bilingual' : 'english-only'

  function issue() {
    if (!canIssue) {
      setShowValidation(true)
      return
    }
    const at = new Date().toISOString()
    issueInstructions(enc.id, { at, by: me.name, channels, language, translated: translation !== undefined, text: patientText })
    const languages = language === 'EN' ? 'English' : translation ? `English and ${languageLabel}` : 'English only'
    audit({
      event: 'INSTRUCTIONS.ISSUED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      // §4.7 — an AI-assisted entry carries the model and the gate it passed.
      ...(aiDraft ? { model: 'plain-lang v2.2.0', gate: 'G2' as const } : {}),
      detail: `${channels.map((c) => CHANNEL_WORD[c]).join(', ')} · ${languages} · ${encounterLabel(enc)}`,
    })
    // What leaves the building on the patient's own channels is kept as sent. The SMS carries a pointer only.
    if (rec.channels.app || rec.channels.sms) {
      send({
        severity: 'routine',
        kind: 'instructions',
        title: `Instructions sent to ${p.name}`,
        detail: [rec.channels.app && `Patient app, in ${languageLabel}`, rec.channels.sms && 'SMS pointer, no content'].filter(Boolean).join(' · '),
        to: `/encounter/${enc.id}/instructions`,
        recipient: 'patient',
      })
    }
    setShowValidation(false)
    toast({ tone: 'success', title: 'Instructions issued', detail: issuedDetail(channels, printWord) })
  }

  function draft() {
    if (!rewrite) return
    clearDisposition(touchpointId)
    setInstructions(enc.id, { patient: rewrite.english, patientSource: 'ai' })
  }

  const handField = (hint?: string) => (
    <VoiceField
      id="plain-text"
      label="Patient instructions"
      rows={8}
      value={patientText}
      disabled={locked}
      onChange={(v) => setInstructions(enc.id, { patient: v, patientSource: v.trim() === '' ? undefined : 'typed' })}
      placeholder="Write the patient version in plain language…"
      hint={hint}
    />
  )

  const explain = {
    touchpointId,
    capabilityId: 'AI-111',
    claim: 'Your instructions, rewritten at roughly a grade-6 reading level, with the reason for each step made explicit.',
    confidence: 0.89,
    band: 'HIGH' as const,
    computedAt: formatTime(NOW),
    inputs: [
      { label: 'Your clinical instructions', source: encounterLabel(enc) },
      { label: 'Active medication list', source: 'Prescription record' },
    ],
    evidence: ['Expanded "OD" to "once every day" and "TFT in 6/12" to a dated action.', 'Added why the four-hour gap matters, which the original assumed.'],
    model: 'plain-lang v2.2.0',
    limits: [
      'Rewrites for readability. It does not add clinical content or change the plan.',
      'Your own wording is retained alongside and is the clinical record.',
      'Translation quality varies by script; a human check is offered before issue.',
    ],
  }

  let patientColumn
  if (aiActive && rewrite && aiDraft) {
    patientColumn = (
      <>
        {disposition?.disposition === 'Accepted with edits' ? (
          <VoiceField
            id="plain-text"
            label="Patient instructions"
            rows={8}
            value={rec.patient}
            disabled={locked}
            onChange={(v) => setInstructions(enc.id, { patient: v })}
            hint="Edited from the AI-111 rewrite — the translation follows only the rewrite as drafted."
          />
        ) : (
          <div
            role="region"
            aria-label={`AI-111 rewrite — ${decided ? disposition?.disposition : 'awaiting a decision'}`}
            className={cn('rounded-[16px] border-l-[3px] border-sh-ai bg-sh-inner px-[14px] py-[12px] text-[14px]/[1.6] text-sh-text', !decided && 'opacity-85')}
          >
            <p className="mb-[8px] flex items-center gap-[8px] text-[12px] font-semibold text-sh-text-2">
              <Diamond />
              AI-111 rewrite
            </p>
            {/* One paragraph each: this is the document the patient receives, so it is marked up as prose. */}
            <div className="flex flex-col gap-[8px]">
              {rec.patient.split(/\n{2,}/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          </div>
        )}
        <AIActionBar
          className="mt-[10px]"
          touchpointId={touchpointId}
          capabilityId="AI-111"
          gate="G2"
          band="HIGH"
          score={0.89}
          locked={locked}
          explain={explain}
          // A rejected rewrite must not be issuable: it leaves the screen and Issue holds.
          onReject={() => setInstructions(enc.id, { patient: '', patientSource: undefined })}
          onUndo={() => setInstructions(enc.id, { patient: rewrite.english, patientSource: 'ai' })}
        />
      </>
    )
  } else if (aiActive && rewrite && rejected && !hasPatient) {
    // The rewrite was rejected: the patient version is yours to write, and the AI can try again.
    patientColumn = (
      <div className="flex flex-col gap-[8px]">
        {handField('Rewrite rejected — write the patient version yourself, or ask the AI to draft again.')}
        <Pill variant="ghost" size="md" icon={Sparkles} className="self-start" disabled={locked} onClick={draft}>
          Draft again with AI
        </Pill>
      </div>
    )
  } else if (aiActive && rewrite && !hasPatient) {
    // Nothing is rewritten until you ask, and not before you have written something to rewrite.
    patientColumn = (
      <div className="flex flex-col items-start gap-[12px] rounded-[16px] border border-dashed border-sh-line-strong bg-sh-inner px-[16px] py-[18px]">
        <p className="text-[13px]/[1.55] text-sh-text-2">
          The plain-language version is drafted from your instructions, at roughly a grade-6 reading level, then translated into the patient&rsquo;s language.
        </p>
        <Pill
          variant="accent"
          size="lg"
          icon={Sparkles}
          disabled={locked || rec.clinician.trim() === ''}
          title={rec.clinician.trim() === '' ? 'Write or dictate your instructions first' : undefined}
          className="disabled:opacity-40"
          onClick={draft}
        >
          Draft with AI
        </Pill>
      </div>
    )
  } else {
    patientColumn = handField()
  }

  return (
    <>
      <ScreenFrame
        screenId="S-06-08"
        patient={p}
        chips={
          <PillTag tone="neu" size="sm" icon={Globe}>
            {languageLabel}
          </PillTag>
        }
        rail={
          <div className="flex flex-col gap-[12px]">
            <Card titleSize="sm" title="Channels">
              <div className="-mx-[10px] flex flex-col">
                {CHANNELS.map((c) => (
                  <CheckboxRow
                    key={c.key}
                    checked={rec.channels[c.key]}
                    disabled={locked}
                    onChange={(v) => setInstructions(enc.id, { channels: { ...rec.channels, [c.key]: v } })}
                  >
                    {c.label}
                  </CheckboxRow>
                ))}
              </div>
              {rec.channels.sms && (
                <Alert tone="warn" title="The SMS carries no PHI" className="mt-[8px]">
                  It will say only that instructions are available. It never carries the reason for the visit, a diagnosis or a result.
                </Alert>
              )}
            </Card>
            <Card titleSize="sm" title="Patient's language">
              <Select value={language} disabled={locked} onChange={(e) => setPatientLanguage(p.id, e.target.value)} aria-label="Patient's preferred language">
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
              {/* The rail rationale, one line by default. */}
              <p className="mt-[8px] text-[12px] text-sh-text-3">Follows the patient&rsquo;s preference, not yours.</p>
            </Card>
          </div>
        }
        railTitle="Delivery"
        actionBar={
          <>
            <Pill
              variant="control"
              size="lg"
              icon={Printer}
              disabled={!hasPatient}
              title={hasPatient ? undefined : 'Nothing to print yet'}
              className="disabled:opacity-40"
              onClick={() => setPrintOpen(true)}
            >
              Preview the A5 print
            </Pill>
            {!hasPatient ? (
              <span className="text-[13px] text-sh-text-2">{rec.clinician.trim() === '' ? 'Dictate or type your instructions first' : 'Draft the patient version to issue'}</span>
            ) : (
              last && (
                <span className="text-[12px] tabular-nums text-sh-text-2">
                  Issued {formatDateTime(new Date(last.at))} by {last.by} · {last.channels.map((c) => CHANNEL_WORD[c]).join(', ')}
                </span>
              )
            )}
            <div className="ml-auto flex flex-wrap items-center gap-[12px]">
              {undecided && <span className="text-[13px] font-medium text-sh-warn-fg">1 AI draft needs a decision</span>}
              <Pill
                variant="primary"
                size="lg"
                icon={Send}
                aria-disabled={!canIssue}
                className={cn(!canIssue && 'opacity-40')}
                onClick={issue}
              >
                {last ? 'Issue again' : 'Issue to the patient'}
              </Pill>
            </div>
          </>
        }
      >
        {!locked && (showValidation || forced === 'VALIDATION') && problems.length > 0 && (
          <ValidationSummary problems={problems} onFocusFirst={() => document.getElementById(problems[0].target)?.scrollIntoView({ block: 'center' })} />
        )}

        <Why label="Why two versions">
          <p>
            The rewrite does not replace what you wrote. Your wording stays in the record; the plain-language version is what the patient receives — AI-111&rsquo;s guardrail.
          </p>
        </Why>

        <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-2 lg:items-start">
          <Card titleSize="sm" title="Your wording" headerClassName="mb-[4px]" id="clinician-text-card">
            <p className="mb-[12px] text-[12px] text-sh-text-3">Stays in the clinical record exactly as you say or write it</p>
            <VoiceField
              id="clinician-text"
              label="Clinical instructions"
              required
              rows={8}
              value={rec.clinician}
              disabled={locked}
              onChange={(v) => setInstructions(enc.id, { clinician: v })}
            />
            <Why label="Abbreviations" className="mt-[4px]">
              <p>Abbreviations are fine here — this version is read by clinicians. The patient version expands them.</p>
            </Why>
          </Card>

          <Card titleSize="sm" title="What the patient reads" headerClassName="mb-[4px]" id="patient-version">
            <p className="mb-[12px] text-[12px] text-sh-text-3">AI-111 · plain language, then translated</p>
            {patientColumn}
          </Card>
        </div>

        {hasPatient && (
          <Card titleSize="sm" title={`Translation — ${languageLabel}`} headerClassName="mb-[4px]">
            <p className="mb-[12px] text-[12px] text-sh-text-3">AI-110 · English-only is the fallback, with the limitation stated</p>
            {language === 'EN' ? (
              <p className="rounded-[14px] bg-sh-inner px-[16px] py-[12px] text-[13px] text-sh-text-2">
                The patient reads English, so no translation is needed. The print is single-language.
              </p>
            ) : translation ? (
              <>
                {/* Line height raised over Latin, as the type rules require for Indic scripts. */}
                <div lang={language.toLowerCase()} className="flex flex-col gap-[8px] rounded-[14px] bg-sh-inner px-[16px] py-[12px] text-[15px]/[1.9] text-sh-text">
                  {translation.split(/\n{2,}/).map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
                <Why label="Script and fallback" className="mt-[4px]">
                  <p>
                    Line height is raised 15% over Latin, as the type rules require for Indic scripts. If translation is unavailable the document prints in English with that
                    limitation stated on it — it never prints a partial translation.
                  </p>
                </Why>
              </>
            ) : (
              <p className="rounded-[14px] bg-sh-warn-bg px-[16px] py-[12px] text-[13px]/[1.55] text-sh-text-2">
                No translation into {languageLabel} is available for this text, so the document prints in English with that limitation stated on it — it never prints a partial
                translation.
              </p>
            )}
          </Card>
        )}
      </ScreenFrame>

      <PrintPreview
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="Patient instructions"
        patient={p}
        paper="A5"
        meta={`${encounterLabel(enc)} · English${language === 'EN' ? '' : translation ? ` and ${languageLabel}` : ' only'}`}
        sections={[
          { heading: 'Your instructions', body: patientText },
          ...(language === 'EN' ? [] : translation ? [{ heading: languageLabel, body: translation, lang: language.toLowerCase() }] : [{ heading: 'Language', body: ENGLISH_ONLY }]),
        ]}
      />
    </>
  )
}
