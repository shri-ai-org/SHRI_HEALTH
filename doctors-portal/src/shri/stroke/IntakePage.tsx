/**
 * S-18-05 · Intake — `/stroke/case/:id/intake` (`src/screens/m18/S1805.tsx`):
 * "The six things that actually change the decision."
 *
 * The hub's counterpart to the spoke console: the same six questions, plus
 * the rest the hub can afford to collect while the imaging runs. AI-112
 * extracts structure from the free text already written at triage, so the
 * same fact is not typed twice; the note is rendered once, in the rail; the
 * exclusions fold behind one line; nothing here blocks the clock.
 *
 * Where the old screen fell short: "confirmed" counted any decision, so a
 * dismissed extraction read as confirmed (only an accepted one counts); the
 * index case's triage note and extractions ("No warfarin") were offered on
 * every case, 0142 — on warfarin — included (another case has no note, its
 * fields are typed); the mRS, living situation, exclusions and next of kin
 * were never read, and the exclusions line always said "None recorded"; Save
 * kept nothing although it said "you can come back to it" (the intake is
 * kept for the session and audited); an unknown case id threw.
 */

import { ArrowRight, Check, Save, Syringe } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import type { StrokeCase } from '@/data/stroke'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { useCaseClock } from '../logic/caseClock'
import { EXCLUSIONS, EXCLUSION_ANSWERS, LIVES, MRS, exclusionsLine, triageFor } from '../logic/strokeIntake'
import { useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive, useForcedState } from '../state/ai'
import { FieldChip } from '../ui/ai'
import { Disclosure, Why } from '../ui/Disclosure'
import { Field, Select, TextInput } from '../ui/forms'
import { Card, Pill, PillTag } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

import { CaseClockStrip } from './CaseClockStrip'
import { NoSuchCase } from './StrokeBits'
import { useStrokeLocal } from './strokeLocal'

/** The six, as labels — for a case with no triage note, typed by hand. */
const SIX = [
  { key: 'lkw', label: 'Last known well' },
  { key: 'deficit', label: 'Deficit' },
  { key: 'bp', label: 'Blood pressure' },
  { key: 'glucose', label: 'Capillary glucose' },
  { key: 'anticoag', label: 'Anticoagulation' },
]

export function IntakePage() {
  const { id, strokeCase } = useStrokeCaseParam()
  if (!strokeCase) return <NoSuchCase screenId="S-18-05" id={id} />
  return <Intake key={strokeCase.id} c={strokeCase} />
}

function Intake({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const dispositions = useAI((s) => s.dispositions)
  const caseNow = useCaseClock()
  const answerCriterion = useStroke((s) => s.answerCriterion)
  const saved = useStrokeLocal((s) => s.intakes[c.id])
  const saveIntake = useStrokeLocal((s) => s.saveIntake)

  const p = patient(c.patientId)
  const triage = triageFor(c)
  const extracted = triage?.extracted ?? []
  const [fields, setFields] = useState<Record<string, string>>(saved?.fields ?? {})
  const [mrs, setMrs] = useState(saved?.mrs ?? MRS[0])
  const [lives, setLives] = useState(saved?.lives ?? LIVES[0])
  const [exclusions, setExclusions] = useState<Record<string, string>>(saved?.exclusions ?? {})
  const [nextOfKin, setNextOfKin] = useState(saved?.nextOfKin ?? '')
  const [consent, setConsent] = useState(saved?.consent ?? '')

  const extracting = aiActive && extracted.length > 0
  const isAccepted = (key: string) => {
    const d = dispositions[`intake:${key}`]?.disposition
    return d === 'Accepted' || d === 'Accepted with edits'
  }
  const accepted = extracted.filter((e) => isAccepted(e.key)).length
  const lowBand = extracted.filter((e) => e.band === 'LOW').length
  const eligibility = `/stroke/case/${c.id}/thrombolysis`
  const set = (key: string, v: string) => setFields((f) => ({ ...f, [key]: v }))

  function save() {
    const filled = [...SIX.map((s) => s.key), 'weight'].filter((k) => (fields[k] ?? '').trim()).length
    saveIntake(c.id, { fields, mrs, lives, exclusions, nextOfKin, consent, savedAt: caseNow, by: me.name })
    audit({
      event: 'STROKE.INTAKE_SAVED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      at: caseNow.toISOString(),
      detail: `${c.caseNo} · ${filled} of 6 fields${extracting ? ` · ${accepted} extracted and accepted` : ''} · pre-stroke mRS ${mrs.split(' ')[0]} · exclusions: ${exclusionsLine(exclusions)}`,
      ...(forced === 'OFFLINE' ? { queued: true } : {}),
    })
  }

  return (
    <ScreenFrame
      screenId="S-18-05"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Intake"
      sub={
        extracting
          ? `${accepted} of ${extracted.length} extracted fields confirmed${lowBand > 0 ? ` · ${lowBand} at low confidence` : ''}`
          : triage || !aiActive
            ? 'Six fields, entered by hand · the AI is off'
            : `Six fields, entered by hand · no triage note is on file for ${c.caseNo}`
      }
      chips={
        extracting && accepted === extracted.length ? (
          <PillTag tone="norm" size="sm" icon={Check}>
            all confirmed
          </PillTag>
        ) : undefined
      }
      actions={
        may(eligibility) && (
          <Pill variant="card" size="xl" icon={Syringe} iconSize={17} onClick={() => navigate(eligibility)}>
            Eligibility
          </Pill>
        )
      }
      railTitle="Source"
      rail={
        <div className="flex flex-col gap-[12px]">
          {/* The source text, once. It opens folded; the field chips quote it in their drawers. */}
          <Card titleSize="sm" title="Triage note, as written">
            {triage ? (
              <Disclosure label="the note">
                <p className="rounded-[14px] bg-sh-inner px-[12px] py-[10px] text-[14px]/[1.55] text-sh-text-2">{triage.text}</p>
              </Disclosure>
            ) : (
              <p className="text-[14px] text-sh-text-2">No triage note is on file for {c.caseNo}. The six fields are typed.</p>
            )}
          </Card>
          {extracting && (
            <Why label="Why one field arrives at low confidence">
              <p>&ldquo;Something for his heart&rdquo; is genuinely uncertain, and the honest output is a low band with the quote attached, not a guess. The free text is the source; extraction saves retyping and does not replace the note.</p>
            </Why>
          )}
        </div>
      }
      actionBar={
        <>
          <Pill
            variant="control"
            size="bar"
            icon={Save}
            onClick={() => {
              save()
              toast({ tone: 'info', title: 'Intake saved', detail: 'Saved as it stands. You can come back to it; the case clock is unaffected.' })
            }}
          >
            Save
          </Pill>
          <span className="text-[13px] text-sh-text-2">Nothing here blocks the clock</span>
          <Pill
            variant="primary"
            size="bar"
            icon={ArrowRight}
            className="ml-auto"
            onClick={() => {
              save()
              toast({ tone: 'success', title: 'Intake saved', detail: 'The hub has the full picture.' })
              navigate(`/stroke/case/${c.id}/clock`)
            }}
          >
            Save and return to the clock
          </Pill>
        </>
      }
    >
      <div className="grid gap-[16px] lg:grid-cols-2">
        <Card titleSize="sm" title="The six that change the decision" className="lg:col-span-2">
          <div className="grid gap-[16px] lg:grid-cols-2">
            {SIX.map((s) => {
              const e = extracting ? extracted.find((x) => x.key === s.key) : undefined
              return (
                <Field
                  key={s.key}
                  label={s.label}
                  required
                  htmlFor={`intake-${s.key}`}
                  aside={
                    e && (
                      <FieldChip
                        touchpointId={`intake:${e.key}`}
                        capabilityId="AI-112"
                        suggestion={e.value}
                        band={e.band}
                        score={e.confidence}
                        gate="G2"
                        onAccept={() => {
                          set(e.key, e.value)
                          answerCriterion(e.key, e.value)
                        }}
                        // Undoing an acceptance takes back the words it put in the field, if nobody has changed them since.
                        onUndo={() => setFields((f) => (f[e.key] === e.value ? { ...f, [e.key]: '' } : f))}
                        explain={{
                          touchpointId: `intake:${e.key}`,
                          capabilityId: 'AI-112',
                          claim: `"${e.value}" was extracted from the triage note for ${e.label.toLowerCase()}.`,
                          confidence: e.confidence,
                          band: e.band,
                          computedAt: formatTime(caseNow),
                          inputs: [{ label: 'Triage free text', source: 'ED triage assessment' }],
                          evidence: [triage!.text],
                          model: 'extract v4.1.0',
                          limits: [
                            'Extracts from what was written. It cannot ask the wife a follow-up question.',
                            'A hedged phrase extracts as a low-confidence value rather than a guess.',
                            'Manual structured entry is the fallback and is always available.',
                          ],
                        }}
                      />
                    )
                  }
                >
                  <TextInput id={`intake-${s.key}`} value={fields[s.key] ?? ''} onChange={(ev) => set(s.key, ev.target.value)} placeholder={e ? 'Type it, or accept the extraction' : 'Type it'} />
                </Field>
              )
            })}
            <Field label="Weight, measured or estimated" required htmlFor="intake-weight">
              <TextInput id="intake-weight" value={fields.weight ?? ''} onChange={(ev) => set('weight', ev.target.value)} placeholder="78 kg" />
            </Field>
          </div>
        </Card>

        <Card titleSize="sm" title="Pre-stroke function">
          <div className="flex flex-col gap-[16px]">
            <Field label="Pre-stroke modified Rankin Scale" htmlFor="intake-mrs">
              <Select id="intake-mrs" value={mrs} onChange={(e) => setMrs(e.target.value)}>
                {MRS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            </Field>
            <Field label="Lives" htmlFor="intake-lives">
              <Select id="intake-lives" value={lives} onChange={(e) => setLives(e.target.value)}>
                {LIVES.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        {/* Four selects that all read "No" tonight. One line until one of them does not. */}
        <Card titleSize="sm" title="Exclusions">
          <p className="text-[14px] text-sh-text-2">{exclusionsLine(exclusions)}</p>
          <Disclosure label="exclusions" count={EXCLUSIONS.length} className="mt-[4px]">
            <div className="flex flex-col gap-[16px] pt-[4px]">
              {EXCLUSIONS.map((x, i) => (
                <Field key={x} label={x} htmlFor={`intake-ex-${i}`}>
                  <Select id={`intake-ex-${i}`} value={exclusions[x] ?? 'No'} onChange={(e) => setExclusions((m) => ({ ...m, [x]: e.target.value }))}>
                    {EXCLUSION_ANSWERS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </Disclosure>
        </Card>

        <Card titleSize="sm" title="Next of kin and consent" className="lg:col-span-2">
          <div className="grid gap-[16px] lg:grid-cols-2">
            <Field label="Present at the bedside" htmlFor="intake-nok">
              <TextInput id="intake-nok" value={nextOfKin} onChange={(e) => setNextOfKin(e.target.value)} placeholder="Wife — name and contact" />
            </Field>
            <VoiceField id="intake-consent" label="Consent discussion" rows={3} value={consent} onChange={setConsent} placeholder="Who it was discussed with, and what was said…" />
          </div>
          <Why label="How consent is taken at 02:00" className="mt-[8px]">
            <p>A thumb impression with a witness is a first-class signature mode here, not a fallback — it is how most consent at 02:00 is actually taken.</p>
            <p className="text-sh-text-3">The spoke console asks six questions. Here those six arrive pre-filled from the triage note and the rest is collected while the imaging runs, so the extra detail costs no clock time.</p>
          </Why>
        </Card>
      </div>
    </ScreenFrame>
  )
}
