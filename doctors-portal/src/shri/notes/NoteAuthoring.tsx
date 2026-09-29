/**
 * The clinical note authoring surface, shared by S-06-03 (outpatient
 * consultation) and S-08-04 (inpatient progress note) — the old build's
 * (`src/screens/shared/NoteAuthoring.tsx`) rules, in this build's look:
 *
 *   · Sign stays disabled until every section has text, EVERY AI-DRAFTED BLOCK
 *     HAS A DECISION, a leaf ICD-10 code is chosen, and the banned-abbreviation
 *     check has cleared (checked on leaving a field, never on a keystroke).
 *   · CMP-NABH-10 — a signed note is never edited: LOCKED plus Addendum, and
 *     amend is a capability separate from write.
 *   · A resident holds note.write but not note.sign, so the primary action is
 *     "Save for co-sign".
 *
 * ONE TRUTH: `notes[enc].text[key]` in the clinical store is what will be
 * signed. The note opens empty; each section is a `VoiceField`. Dictated or
 * typed text is the clinician's own and needs no decision; only the sections
 * the ambient scribe drafted are AI touchpoints, shown as ghost text awaiting
 * Accept, Edit or Reject — and they gate Sign. Autosave runs every 20 s,
 * silently. Signing, sending for co-sign and appending an addendum are on the
 * audit trail (the old build recorded none of the three).
 */

import { Check, Lock, PenLine, Printer, Save, Signature, Sparkles, Stethoscope, Undo2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { can, canSignNotes } from '@/atlas/personas'
import { bannedIn } from '@/data/abbreviations'
import { CODE_SUGGESTIONS, type Encounter, type NoteSectionSeed, type SectionKey } from '@/data/clinical'
import { NOW, formatDateTime, formatTime } from '@/data/format'
import { DIAGNOSES, type Patient } from '@/data/kit'
import { useScribeDrafts, type ScribeDraft } from '@/data/scribe'
import { useAI, useOutstanding } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical, type SectionProvenance } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel } from '../logic/encounter'
import { useProblemsFor } from '../logic/record'
import { useAiActive, useForcedState } from '../state/ai'
import { FieldChip, GhostSection } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { TextInput } from '../ui/forms'
import { Card, Chip, Icon, Pill, PillTag, RoundButton } from '../ui/primitives'
import { PrintPreview } from '../ui/PrintPreview'
import { LockedBanner, ValidationSummary } from '../ui/states'
import { VoiceField, type DictatedMeta } from '../ui/VoiceField'

export interface NoteAuthoringProps {
  screenId: string
  encounter: Encounter
  patient: Patient
  seeds: NoteSectionSeed[]
  /** Model name for the explainability drawer, per scribe capability. */
  scribeModel: string
  /** Opens the scribe overlay — the one emphasised header action. */
  onDraftAll?: () => void
  /** Extra header actions — Prescribe, Order, Admit. */
  headerActions?: ReactNode
  rail?: ReactNode
  railTitle?: string
  railBadge?: number
  /** Rendered above the fields — the record's doors, a risk banner. */
  banner?: ReactNode
  /** Extra field groups below the standard ones. */
  extraGroups?: ReactNode
  /** Where Sign returns to. */
  onSigned?: () => void
  showCoding?: boolean
  bannerExtra?: ReactNode
}

interface CodeOption {
  icd10: string
  label: string
  leaf: boolean
}

export function NoteAuthoring({
  screenId,
  encounter: enc,
  patient: p,
  seeds,
  scribeModel,
  onDraftAll,
  headerActions,
  rail,
  railTitle = 'Suggestions',
  railBadge,
  banner,
  extraGroups,
  onSigned,
  showCoding = true,
  bannerExtra,
}: NoteAuthoringProps) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const persona = useSession((s) => s.persona)
  const toast = useUI((s) => s.toast)
  const forced = useForcedState()
  const aiActive = useAiActive()
  const audit = useAudit((s) => s.record)

  const note = useClinical((s) => s.note)
  const setSectionText = useClinical((s) => s.setSectionText)
  const setNoteCode = useClinical((s) => s.setNoteCode)
  const saveDraft = useClinical((s) => s.saveDraft)
  const signNote = useClinical((s) => s.signNote)
  const addendum = useClinical((s) => s.addendum)
  // Subscribing to the notes map re-renders on every change to this encounter's record.
  useClinical((s) => s.notes[enc.id])
  const record = note(enc.id)
  /** What the ambient scribe heard and routed, for this encounter. */
  const scribeDraft = useScribeDrafts((s) => s.drafts[enc.id])
  const aimScribe = useScribeDrafts((s) => s.aim)
  const draftFor = (key: SectionKey): string | undefined => scribeDraft?.sections[key]
  const patientProblems = useProblemsFor(p.id)

  const [codeQuery, setCodeQuery] = useState('')
  const [blurred, setBlurred] = useState<Record<string, boolean>>({})
  const [confirmSign, setConfirmSign] = useState(false)
  const [addendumOpen, setAddendumOpen] = useState(false)
  const [addendumText, setAddendumText] = useState('')
  const [showValidation, setShowValidation] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)

  const locked = record.status === 'signed' || forced === 'LOCKED'
  const mayAmend = can(persona, 'op.note.amend') || can(persona, 'ip.note.amend')
  const maySign = canSignNotes(persona)

  /** Only sections the SCRIBE drafted are AI touchpoints. Dictated and typed text is the clinician's. */
  const scribed = useMemo(
    () => seeds.filter((s) => record.provenance[s.key] === 'scribe' && scribeDraft?.sections[s.key] !== undefined),
    [seeds, record.provenance, scribeDraft],
  )
  const outstanding = useOutstanding(scribed.map((s) => `${enc.id}:${s.key}`))

  // ARC-15: autosave every 20 s with a visible timestamp. Silent — no toast, no audit row.
  useEffect(() => {
    if (locked) return
    const t = window.setInterval(() => saveDraft(enc.id, 'auto'), 20_000)
    return () => window.clearInterval(t)
  }, [enc.id, locked, saveDraft])

  const textFor = (key: SectionKey) => record.text[key] ?? ''

  /** The ICD-10 index this build can search: the AI's proposals, the patient's problems, the kit's diagnoses. */
  const codeIndex = useMemo<CodeOption[]>(() => {
    const seen = new Set<string>()
    const out: CodeOption[] = []
    const add = (o: CodeOption) => {
      if (seen.has(o.icd10)) return
      seen.add(o.icd10)
      out.push(o)
    }
    for (const s of CODE_SUGGESTIONS) add({ icd10: s.icd10, label: s.label, leaf: s.leaf })
    for (const pr of patientProblems) add({ icd10: pr.icd10, label: pr.label, leaf: pr.leaf })
    for (const d of DIAGNOSES) add({ icd10: d.icd10, label: d.label, leaf: true })
    return out
  }, [patientProblems])
  const codeMatches = useMemo(() => {
    const q = codeQuery.trim().toLowerCase()
    if (q.length < 2) return []
    return codeIndex.filter((o) => o.icd10.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)).slice(0, 6)
  }, [codeQuery, codeIndex])

  /** Validation on blur, never on keystroke. The stored text is the only text that counts. */
  const problems = useMemo(() => {
    const out: { field: string; message: string }[] = []
    for (const seed of seeds) {
      const value = record.text[seed.key] ?? ''
      if (value.trim().length < 10) {
        out.push({ field: seed.label, message: 'dictate or type at least 10 characters' })
      } else if (blurred[seed.key]) {
        for (const h of bannedIn(value)) {
          out.push({ field: seed.label, message: `"${h.found}" is not accepted — write "${h.write}", or use Tidy up with AI` })
        }
      }
    }
    if (showCoding && !record.code) {
      out.push({ field: 'Diagnosis and ICD-10', message: 'a leaf ICD-10 code is required — accept the proposed code, pick a problem, or search' })
    }
    if (outstanding > 0) {
      out.push({ field: 'AI drafts', message: `${outstanding} drafted ${outstanding === 1 ? 'section has' : 'sections have'} no decision yet` })
    }
    return out
  }, [seeds, blurred, record.text, record.code, outstanding, showCoding])

  /** Every rule lives in `problems`, so this is the whole gate. */
  const canSignNow = problems.length === 0 && !locked
  const written = seeds.filter((s) => textFor(s.key).trim().length >= 10).length
  const noteKind = enc.type === 'IP' ? 'Progress note' : 'Consultation note'

  function doSign() {
    const status = signNote({ encounterId: enc.id, by: me.name, registrationNo: me.identifier, canSign: maySign })
    setConfirmSign(false)
    if (status === 'signed') {
      audit({ event: 'NOTE.SIGNED', actor: me.name, actorId: me.id, subject: p.id, detail: `${noteKind} signed · ${encounterLabel(enc)}${record.code ? ` · ICD-10 ${record.code}` : ''}` })
      toast({
        tone: 'success',
        title: 'Note signed',
        detail: `Stamped ${me.name} · ${me.identifierKind} ${me.identifier} · ${formatTime(NOW)}. Queued to publish to ABDM.`,
      })
      onSigned?.()
    } else {
      audit({ event: 'NOTE.COSIGN_QUEUED', actor: me.name, actorId: me.id, subject: p.id, detail: `${noteKind} saved for co-sign · ${encounterLabel(enc)}` })
      toast({ tone: 'caution', title: 'Saved for co-sign', detail: "You hold note.write but not note.sign for this class. It is now in the consultant's queue." })
      // The queue it went to — where the persona may open it; otherwise back where Sign returns.
      if (may('/clinician/cosign')) navigate('/clinician/cosign')
      else onSigned?.()
    }
  }

  function doSaveDraft() {
    saveDraft(enc.id, 'manual')
    toast({ tone: 'info', title: 'Draft saved', detail: 'Nothing is signed. The draft stays on this device until you sign it.' })
  }

  function onDictated(seed: NoteSectionSeed, meta: DictatedMeta) {
    setSectionText(enc.id, seed.key, meta.text, 'dictated')
    // §4.7 — every AI-assisted entry carries the model and the gate.
    audit({
      event: 'AI.SCRIBE.TRANSCRIPT_CREATED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      model: meta.model,
      gate: 'G2',
      detail: `${seed.label} · ${meta.words} words · live recognition · ${meta.band}`,
    })
  }

  const section = (seed: NoteSectionSeed) => (
    <Section
      key={seed.key}
      seed={seed}
      encounterId={enc.id}
      scribeModel={scribeModel}
      value={textFor(seed.key)}
      provenance={record.provenance[seed.key]}
      draft={draftFor(seed.key)}
      draftMeta={scribeDraft}
      locked={locked}
      onChange={(v, prov) => setSectionText(enc.id, seed.key, v, prov)}
      onDictated={(meta) => onDictated(seed, meta)}
      onBlur={() => setBlurred((b) => ({ ...b, [seed.key]: true }))}
    />
  )

  const chosen = codeIndex.find((o) => o.icd10 === record.code)
  /**
   * AI-501's proposals are drawn from a pneumonia record. The old build offered them on every note;
   * here they are offered only where the patient's own problems share the code's category — a
   * patient without the charted evidence gets no suggestion, not somebody else's.
   */
  const categories = new Set(patientProblems.map((pr) => pr.icd10.slice(0, 3)))
  const codeSuggestions = CODE_SUGGESTIONS.filter((s) => categories.has(s.icd10.slice(0, 3))).slice(0, 2)

  return (
    <>
      <ScreenFrame
        screenId={screenId}
        patient={p}
        bannerExtra={bannerExtra}
        chips={
          <>
            <PillTag tone={locked ? 'neu' : 'warn'} size="sm" icon={locked ? Lock : PenLine}>
              {record.status === 'signed' ? 'Signed' : record.status === 'cosign-pending' ? 'Co-sign pending' : 'Draft'}
            </PillTag>
            <span title={encounterLabel(enc)}>
              <Chip word={enc.encounterNo} tone="neu" />
            </span>
            {/* Only once it has left the building — "not published" is the silent default. */}
            {record.publishStatus !== undefined && (
              <PillTag tone={record.publishStatus === 'failed' ? 'warn' : 'norm'} size="sm" icon={Upload}>
                ABDM {record.publishStatus}
              </PillTag>
            )}
          </>
        }
        actions={
          <>
            {/* One emphasised action: the scribe — an AI affordance, so absent with AI off (§1.5). */}
            {!locked && onDraftAll && aiActive && (
              <Pill
                variant="accent"
                size="xl"
                icon={Sparkles}
                iconSize={17}
                onClick={() => {
                  // The scribe hands its text back to THIS encounter.
                  aimScribe(enc.id, p.id)
                  onDraftAll()
                }}
              >
                Draft with AI
              </Pill>
            )}
            {headerActions}
          </>
        }
        rail={rail}
        railTitle={railTitle}
        railBadge={railBadge}
        actionBar={
          locked ? (
            <>
              <span className="flex items-center gap-[8px] text-[13px] text-sh-text-2">
                <Icon icon={Lock} size={14} />
                Signed by {record.signedBy ?? me.name}
                {record.signedAt && ` at ${formatDateTime(new Date(record.signedAt))}`}
                {record.coSignedBy && ` · co-signed by ${record.coSignedBy}`}
              </span>
              <div className="ml-auto flex flex-wrap gap-[8px]">
                <Pill variant="control" size="lg" icon={Printer} onClick={() => setPrintOpen(true)}>
                  Print
                </Pill>
                <Pill
                  variant="primary"
                  size="lg"
                  icon={PenLine}
                  disabled={!mayAmend}
                  title={mayAmend ? undefined : 'Requires the amend capability, which is separate from write'}
                  className="disabled:opacity-40"
                  onClick={() => setAddendumOpen(true)}
                >
                  Addendum
                </Pill>
              </div>
            </>
          ) : (
            <>
              <Pill variant="control" size="lg" icon={Save} onClick={doSaveDraft}>
                Save draft
              </Pill>
              {/* The bar is frosted, so its quiet lines use the stronger grey to stay AA over whatever scrolls beneath. */}
              <span className="text-[12px] tabular-nums text-sh-text-2">
                {record.savedAt ? `${record.savedHow === 'auto' ? 'Autosaved' : 'Saved'} ${formatTime(new Date(record.savedAt))}` : 'Autosave on'}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-[12px]">
                {canSignNow ? (
                  // CMP-NABH-11 — the attestation is stamped on sign, never typed. Stated once, when it is about to happen.
                  <span className="text-[12px] tabular-nums text-sh-text-2">
                    Signing will stamp {me.name} · {me.identifierKind} {me.identifier}
                  </span>
                ) : (
                  <span className="text-[13px] font-medium text-sh-warn-fg">
                    {outstanding > 0
                      ? `${outstanding} AI ${outstanding === 1 ? 'draft needs' : 'drafts need'} a decision`
                      : written < seeds.length
                        ? `${written} of ${seeds.length} sections written`
                        : showCoding && !record.code
                          ? 'ICD-10 code needed'
                          : `${problems.length} ${problems.length === 1 ? 'item' : 'items'} to fix`}
                  </span>
                )}
                <Pill
                  variant="primary"
                  size="lg"
                  icon={Signature}
                  // Disabled until the gate clears; pressed while disabled-looking it says why, so the reason is never hidden.
                  aria-disabled={!canSignNow}
                  title={canSignNow ? undefined : 'Every section needs text, every AI draft a decision, and a leaf ICD-10 code'}
                  className={cn(!canSignNow && 'opacity-40')}
                  onClick={() => {
                    if (!canSignNow) {
                      setShowValidation(true)
                      return
                    }
                    setConfirmSign(true)
                  }}
                >
                  {maySign ? 'Sign' : 'Save for co-sign'}
                </Pill>
              </div>
            </>
          )
        }
      >
        {locked && (
          <LockedBanner
            by={`${record.signedBy ?? me.name}${record.coSignedBy ? `, co-signed by ${record.coSignedBy}` : ''}`}
            at={record.signedAt ? formatDateTime(new Date(record.signedAt)) : formatTime(NOW)}
            reason="signed"
          />
        )}

        {/* S-06-09's return, where the author will see it: the entry is theirs again, with what needs changing. */}
        {!locked && record.status === 'draft' && record.returned && (
          <Alert tone="warn" icon={Undo2} title={`Returned by ${record.returned.by}`}>
            &ldquo;{record.returned.comment}&rdquo; · {formatDateTime(new Date(record.returned.at))}
          </Alert>
        )}

        {!maySign && !locked && (
          <Alert tone="warn" title="You may write this note but not sign it">
            A registrar can write a note of this class but a consultant has to sign it. Your entry will be saved as{' '}
            <strong className="font-semibold text-sh-text">Co-sign pending</strong> and appear in the consultant&rsquo;s queue.
          </Alert>
        )}

        {banner}

        {(showValidation || forced === 'VALIDATION') && problems.length > 0 && (
          <ValidationSummary
            problems={problems}
            onFocusFirst={() => {
              const first = seeds.find((s) => problems.some((pr) => pr.field === s.label))
              document.getElementById(`${enc.id}:${first?.key ?? seeds[0].key}`)?.scrollIntoView({ block: 'center' })
            }}
          />
        )}

        {/* S · O · A · P, then the code. The order a note is spoken in. */}
        <Card titleSize="sm" title="Subjective and objective">
          <div className="grid grid-cols-1 gap-[20px] lg:grid-cols-2">{seeds.filter((s) => s.key === 'subjective' || s.key === 'objective').map(section)}</div>
        </Card>
        <Card titleSize="sm" title="Assessment and plan">
          <div className="grid grid-cols-1 gap-[20px] lg:grid-cols-2">{seeds.filter((s) => s.key === 'assessment' || s.key === 'plan').map(section)}</div>
        </Card>

        {showCoding && (
          <Card titleSize="sm" title="Diagnosis and ICD-10" headerClassName="mb-[4px]">
            <p className="mb-[14px] text-[12px] text-sh-text-3">SNOMED plus ICD-10 — leaf codes only</p>
            <div className="flex flex-col gap-[10px]">
              <div className="flex flex-wrap items-center justify-between gap-[8px]">
                <label htmlFor={`${enc.id}-code-search`} className="text-[13px] font-medium text-sh-text-2">
                  ICD-10 code <span className="text-sh-crit-fg" aria-hidden="true">*</span>
                  <span className="sr-only"> (required)</span>
                </label>
                <span className="flex flex-wrap items-center gap-[6px]">
                  {codeSuggestions.map((s, i) => (
                    <FieldChip
                      key={s.icd10}
                      touchpointId={i === 0 ? `${enc.id}:code` : `${enc.id}:code-alt`}
                      capabilityId="AI-501"
                      suggestion={`${s.icd10} ${s.label}`}
                      band={s.confidence >= 0.85 ? 'HIGH' : s.confidence >= 0.6 ? 'MED' : 'LOW'}
                      score={s.confidence}
                      gate="G2"
                      locked={locked}
                      disabledReason={s.leaf ? undefined : 'Parent-only code. A category will not group for a claim or satisfy a coder audit.'}
                      onAccept={() => setNoteCode(enc.id, s.icd10)}
                      onUndo={() => {
                        if (record.code === s.icd10) setNoteCode(enc.id, undefined)
                      }}
                      explain={{
                        touchpointId: `${enc.id}:code`,
                        capabilityId: 'AI-501',
                        claim: `${s.icd10} — ${s.label} is the most specific code supported by the charted evidence.`,
                        confidence: s.confidence,
                        band: s.confidence >= 0.85 ? 'HIGH' : 'MED',
                        computedAt: formatTime(NOW),
                        inputs: patientProblems.map((pr) => ({ label: `${pr.label} (${pr.icd10})`, source: `Problem list · onset ${pr.onset}` })),
                        evidence: ['The assessment section names the condition explicitly.', 'Leaf codes only — parent categories are blocked at the field.'],
                        model: 'code-assist v3.2.0',
                        limits: [
                          'Proposes ICD-10 and SNOMED from the note text and the problem list.',
                          'Does not apply coding-for-reimbursement logic; that is the coder’s job downstream.',
                          'Picking a problem or searching the index is always available.',
                        ],
                      }}
                    />
                  ))}
                </span>
              </div>

              {/* The patient's own problems — one tap codes the note. */}
              <div className="flex flex-wrap gap-[8px]">
                {patientProblems.map((pr) => {
                  const on = pr.icd10 === record.code
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      disabled={locked || !pr.leaf}
                      title={pr.leaf ? `Code this note ${pr.icd10}` : 'Parent-only code — pick a more specific one'}
                      aria-pressed={on}
                      onClick={() => setNoteCode(enc.id, pr.icd10)}
                      className={cn(
                        'inline-flex min-h-[36px] items-center gap-[6px] rounded-full px-[12px] text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
                        on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-control text-sh-text hover:bg-sh-hover-strong',
                      )}
                    >
                      <Icon icon={Stethoscope} size={14} />
                      {pr.label} · {pr.icd10}
                    </button>
                  )
                })}
                {record.code && (
                  <span className="inline-flex items-center gap-[4px]">
                    <PillTag tone="norm" size="sm" icon={Check} className="h-[36px] px-[12px] text-[13px]">
                      Coded {record.code}
                      {chosen && ` · ${chosen.label}`}
                    </PillTag>
                    {!locked && <RoundButton icon={X} size={36} iconSize={14} variant="ghost" label="Clear the code" onClick={() => setNoteCode(enc.id, undefined)} />}
                  </span>
                )}
              </div>

              <p className="text-[12px] text-sh-text-3">
                {record.code
                  ? `Coded ${record.code}. Pick another problem, or search, to change it.`
                  : 'Accept the proposed code, pick one of the patient’s problems, or search the ICD-10 index. A parent-only code is blocked.'}
              </p>

              {/* The manual path the copy promises. Never hidden. */}
              {!locked && (
                <div className="relative max-w-[440px]">
                  <TextInput
                    id={`${enc.id}-code-search`}
                    value={codeQuery}
                    onChange={(e) => setCodeQuery(e.target.value)}
                    placeholder="Search ICD-10 by code or diagnosis…"
                    aria-label="Search ICD-10"
                    autoComplete="off"
                  />
                  {codeQuery.trim().length >= 2 && (
                    <ul role="listbox" aria-label="ICD-10 matches" className="sh-frosted absolute z-20 mt-[6px] w-full overflow-hidden rounded-[16px] py-[4px] shadow-sh-pop">
                      {codeMatches.length === 0 && <li className="px-[14px] py-[10px] text-[13px] text-sh-text-3">No match in this build&rsquo;s index.</li>}
                      {codeMatches.map((o) => (
                        <li key={o.icd10}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={o.icd10 === record.code}
                            disabled={!o.leaf}
                            title={o.leaf ? undefined : 'Parent-only code — a category cannot be signed'}
                            onClick={() => {
                              setNoteCode(enc.id, o.icd10)
                              setCodeQuery('')
                            }}
                            className="flex min-h-[44px] w-full items-center gap-[12px] px-[14px] text-left transition-colors duration-150 hover:bg-sh-hover disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="w-[64px] shrink-0 text-[13px] font-semibold tabular-nums text-sh-text">{o.icd10}</span>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-sh-text">{o.label}</span>
                            {!o.leaf && <Chip word="parent only" tone="warn" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}

        {extraGroups}

        {/* CMP-NABH-10 — original and addendum both visible, separately attributed. */}
        {record.addenda.length > 0 && (
          <Card titleSize="sm" title={`Addenda (${record.addenda.length})`}>
            <ul className="flex flex-col gap-[10px]">
              {record.addenda.map((a) => (
                <li key={a.id} className="rounded-[14px] border-l-[3px] border-sh-accent bg-sh-inner px-[16px] py-[12px]">
                  <p className="text-[14px]/[1.55] text-sh-text">{a.body}</p>
                  <p className="mt-[8px] text-[12px] tabular-nums text-sh-text-3">
                    {a.by} · {a.registrationNo} · {formatDateTime(new Date(a.at))}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-[12px] text-[12px] text-sh-text-3">The original entry above is unchanged. A signed record is amended, never edited.</p>
          </Card>
        )}
      </ScreenFrame>

      <ConfirmDialog
        open={confirmSign}
        title={maySign ? 'Sign this note?' : 'Save for co-sign?'}
        consequence={
          maySign
            ? 'Signing is irreversible. The note is committed to the legal record, stamped with your name, registration number and the time, and queued to publish to ABDM. After this it can only be amended, never edited.'
            : "The note will be saved and sent to the consultant's co-sign queue. You will not be able to change it after that without an addendum."
        }
        confirmLabel={maySign ? 'Sign' : 'Save for co-sign'}
        onConfirm={doSign}
        onCancel={() => setConfirmSign(false)}
      />

      <ConfirmDialog
        open={addendumOpen}
        title="Add an addendum"
        consequence="The original entry stays exactly as signed. Your addendum is appended, separately attributed to you with its own timestamp."
        confirmLabel="Append addendum"
        confirmDisabled={addendumText.trim().length < 5}
        onConfirm={() => {
          if (addendumText.trim().length < 5) return
          addendum({ encounterId: enc.id, body: addendumText.trim(), by: me.name, registrationNo: me.identifier })
          audit({ event: 'NOTE.ADDENDUM_APPENDED', actor: me.name, actorId: me.id, subject: p.id, detail: `${noteKind} · ${encounterLabel(enc)} · ${addendumText.trim().split(/\s+/).length} words` })
          setAddendumText('')
          setAddendumOpen(false)
          toast({ tone: 'success', title: 'Addendum appended', detail: 'Both entries remain visible and attributed.' })
        }}
        onCancel={() => {
          setAddendumOpen(false)
          setAddendumText('')
        }}
      >
        <VoiceField
          id={`${enc.id}:addendum`}
          label="Addendum"
          rows={4}
          value={addendumText}
          onChange={(v) => setAddendumText(v)}
          placeholder="What has changed, or what you are adding to the record…"
        />
      </ConfirmDialog>

      <PrintPreview
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title={noteKind}
        patient={p}
        meta={`${encounterLabel(enc)} · signed by ${record.signedBy ?? me.name}${record.signedAt ? ` · ${formatDateTime(new Date(record.signedAt))}` : ''}`}
        sections={[
          ...seeds.map((s) => ({ heading: s.label, body: textFor(s.key) })),
          ...(record.code ? [{ heading: 'Diagnosis and ICD-10', body: `${record.code}${chosen ? ` · ${chosen.label}` : ''}` }] : []),
          ...record.addenda.map((a) => ({ heading: `Addendum · ${a.by} · ${formatDateTime(new Date(a.at))}`, body: a.body })),
        ]}
        paper="A4"
      />
    </>
  )
}

/**
 * One section. The stored text is the truth; the ghost draft shows only while
 * the section is empty and undecided; the VoiceField is the surface in every
 * other state, mic and all. The ghost is the scribe's text for this section —
 * the sentences it heard and routed here — and nothing else.
 */
function Section({
  seed,
  encounterId,
  scribeModel,
  value,
  provenance,
  draft,
  draftMeta,
  locked,
  onChange,
  onDictated,
  onBlur,
}: {
  seed: NoteSectionSeed
  encounterId: string
  scribeModel: string
  value: string
  provenance: SectionProvenance | undefined
  draft: string | undefined
  draftMeta: ScribeDraft | undefined
  locked: boolean
  onChange: (v: string, provenance?: SectionProvenance) => void
  onDictated: (meta: DictatedMeta) => void
  onBlur: () => void
}) {
  const touchpointId = `${encounterId}:${seed.key}`
  const disposition = useAI((s) => s.dispositions[touchpointId])
  const accepted = disposition?.disposition === 'Accepted' || disposition?.disposition === 'Accepted with edits'
  const rejected = disposition?.disposition === 'Rejected'
  const isScribe = provenance === 'scribe' && draft !== undefined && draftMeta !== undefined
  /** Marked as a scribe draft, but the drafted text is gone: the clinician's field, and typing makes it theirs. */
  const orphan = provenance === 'scribe' && !isScribe

  /**
   * Provenance for a scribe section: accepted text stays the AI's (the decision
   * says "with edits"); words typed into an empty or rejected section are the
   * clinician's, which drops the section out of the AI touchpoints. While the
   * microphone is writing in, a scribe section keeps its provenance until Stop.
   */
  const provenanceFor = (v: string, source?: 'dictation'): SectionProvenance | undefined => {
    if (source === 'dictation') return isScribe ? 'scribe' : 'dictated'
    if (isScribe) return accepted || v.trim() === '' ? 'scribe' : 'typed'
    if (orphan) return v.trim() === '' ? undefined : 'typed'
    return undefined
  }

  const field = (
    <VoiceField
      id={touchpointId}
      label={seed.label}
      required
      value={value}
      onChange={(v, source) => onChange(v, provenanceFor(v, source))}
      onDictated={onDictated}
      onBlur={onBlur}
      disabled={locked}
      placeholder={rejected ? `Draft rejected. Dictate or type the ${seed.label.toLowerCase()}…` : undefined}
    />
  )

  if (!isScribe) return <div className="min-w-0">{field}</div>

  return (
    <div onBlur={onBlur} className="min-w-0">
      <GhostSection
        touchpointId={touchpointId}
        capabilityId={seed.ai}
        label={seed.label}
        draft={draft}
        band={draftMeta.band}
        // A recogniser that reported no score shows the band alone, never an invented percentage.
        score={draftMeta.scored ? draftMeta.confidence : undefined}
        gate={seed.gate}
        locked={locked}
        value={value}
        field={field}
        onAccept={() => onChange(draft, 'scribe')}
        onEdit={() => onChange(draft, 'scribe')}
        onReject={() => onChange('', 'scribe')}
        onUndo={() => onChange('', 'scribe')}
        explain={{
          touchpointId,
          capabilityId: seed.ai,
          claim: `The ${seed.label.toLowerCase()} section was drafted from what the scribe heard. You own the text once you accept it.`,
          confidence: draftMeta.confidence,
          band: draftMeta.band,
          computedAt: formatTime(new Date(draftMeta.at)),
          inputs: [
            { label: 'Live transcript, this session', source: draftMeta.model },
            { label: 'Sentences routed to this section', source: `${draft.split(/(?<=[.!?])\s+/).length} of the transcript` },
          ],
          // The draft IS the transcript span: sentences are routed, never reworded.
          evidence: [draft],
          model: scribeModel,
          limits: [
            'Sentences are placed in a section by the words used; nothing is reworded, added or inferred.',
            'It cannot tell who was speaking, and it does not examine the patient.',
            'The raw transcript is kept with the draft. Dictating or typing is always available.',
            ...(draftMeta.scored ? [] : ['The recogniser reported no confidence score for this take; the band is a neutral default.']),
          ],
        }}
      />
    </div>
  )
}
