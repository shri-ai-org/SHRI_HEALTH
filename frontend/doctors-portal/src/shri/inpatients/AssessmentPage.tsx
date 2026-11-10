/**
 * S-08-07 · Admission assessment — `/ip/encounter/:id/assessment`
 * (`src/screens/m08/S0807.tsx`): "The admission assessment the 24-hour NABH
 * clock is counting down to."
 *
 * CMP-NABH-01 requires an initial assessment within 24 hours of admission, so
 * the clock is the screen's organising idea rather than a footnote. AI-211
 * pre-scores fall, pressure-ulcer and VTE risk at G1 — it notices, and the
 * manual assessment scales remain the fallback and the authority. Everything
 * the form holds is kept on the record under its own key, so a reload keeps
 * the work and signing locks it.
 *
 * Where the old form fell short: its pre-scores and the admission note it
 * carried forward were R. Lakshmanan's, on anyone's assessment — here they are
 * his, and anyone else is scored on the manual scales; the nutrition and
 * functional screens opened already answered ("At risk", "Needs assistance")
 * and would have been signed that way untouched — here they open unanswered
 * and are required; and signing needed no capability — here a registrar saves
 * it for co-sign, and either act is on the audit trail.
 */

import { ArrowRight, Clock, Info, Lock, PenLine, Save, Signature, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { canSignNotes } from '@/atlas/personas'
import type { Encounter } from '@/data/clinical'
import { NOW, formatDateTime, formatElapsed, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { FUNCTION, NUTRITION, admissionNoteFor, nabhClock, scalesFor, type RiskScale } from '../logic/assessment'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { useAiActive, useForcedState } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { LockedBanner, ValidationSummary } from '../ui/states'
import { VoiceField } from '../ui/VoiceField'

export function AssessmentPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-08-07" />
  return <Assessment key={enc.id} enc={enc} />
}

function Assessment({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const persona = useSession((s) => s.persona)
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const dispositions = useAI((s) => s.dispositions)

  const note = useClinical((s) => s.note)
  const setSectionText = useClinical((s) => s.setSectionText)
  const saveDraft = useClinical((s) => s.saveDraft)
  const signNote = useClinical((s) => s.signNote)
  const noteId = `${enc.id}:assessment`
  // Subscribing to this assessment's record re-renders on every change to it.
  useClinical((s) => s.notes[noteId])
  const record = note(noteId)
  const [showValidation, setShowValidation] = useState(false)

  const p = patient(enc.patientId)
  const scales = scalesFor(p.id)
  const carriedNote = admissionNoteFor(p.id)
  const history = record.text.history ?? ''
  const carried = record.provenance.history === 'carried'
  const nutrition = record.text.nutrition ?? ''
  const functional = record.text.function ?? ''
  const complete = record.text.complete === 'yes'
  // As on S-06-03: a registrar's entry saved for co-sign stays theirs to change until a consultant signs it.
  const locked = record.status === 'signed' || forced === 'LOCKED'
  const maySign = canSignNotes(persona)
  const progress = `/ip/encounter/${enc.id}/note`

  // ARC-15: autosave every 20 s with a visible timestamp. Silent.
  useEffect(() => {
    if (locked) return
    const t = window.setInterval(() => saveDraft(noteId, 'auto'), 20_000)
    return () => window.clearInterval(t)
  }, [noteId, locked, saveDraft])

  /** A scale is confirmed by an AI decision that is not a rejection, or by the manual checkbox. */
  const confirmedBy = (key: string) => {
    const d = dispositions[`${enc.id}:scale:${key}`]
    return (d !== undefined && d.disposition !== 'Deferred' && d.disposition !== 'Rejected') || record.text[`scale:${key}`] === 'confirmed'
  }
  const confirmedCount = scales.filter((sc) => confirmedBy(sc.key)).length

  const problems: { field: string; message: string }[] = []
  if (history.trim().length < 10) problems.push({ field: 'History', message: 'dictate, type or carry forward at least 10 characters' })
  if (!nutrition) problems.push({ field: 'Nutrition risk', message: 'choose one' })
  if (!functional) problems.push({ field: 'Functional status', message: 'choose one' })
  if (confirmedCount < scales.length) problems.push({ field: 'Risk scales', message: `${confirmedCount} of ${scales.length} confirmed` })
  if (!complete) problems.push({ field: 'Declaration', message: 'tick it once the assessment is complete' })
  const canSign = !locked && problems.length === 0

  const clock = nabhClock(enc)
  const late = clock.overdue ? formatElapsed((clock.hoursSince - 24) * 60) : ''

  function sign() {
    if (!canSign) {
      setShowValidation(true)
      return
    }
    const status = signNote({ encounterId: noteId, by: me.name, registrationNo: me.identifier, canSign: maySign })
    if (status === 'signed') {
      audit({ event: 'NOTE.SIGNED', actor: me.name, actorId: me.id, subject: p.id, detail: `Admission assessment signed · ${encounterLabel(enc)} · NABH clock closed${clock.overdue ? `, ${late} late` : ''}` })
      toast({
        tone: 'success',
        title: 'Admission assessment signed',
        detail: `Stamped ${me.name} · ${me.identifier}. The NABH clock is closed${clock.overdue ? ', with the delay recorded' : ''}.`,
      })
    } else {
      audit({ event: 'NOTE.COSIGN_QUEUED', actor: me.name, actorId: me.id, subject: p.id, detail: `Admission assessment saved for co-sign · ${encounterLabel(enc)}` })
      toast({ tone: 'caution', title: 'Saved for co-sign', detail: "You hold note.write but not note.sign for this class. It is now in the consultant's queue." })
    }
  }

  const scale = (sc: RiskScale) => {
    const touchpointId = `${enc.id}:scale:${sc.key}`
    const prescored = sc.score !== undefined
    const rejected = dispositions[touchpointId]?.disposition === 'Rejected'
    const band = (sc.confidence ?? 0) >= 0.85 ? ('HIGH' as const) : ('MED' as const)
    return (
      <Card key={sc.key} as="article" aria-label={sc.name} className="bg-sh-inner">
        <div className="flex flex-wrap items-start justify-between gap-[8px]">
          <div className="min-w-0">
            <h4 className="text-[15px] font-semibold text-sh-text">{sc.name}</h4>
            <p className="text-[13px] tabular-nums text-sh-text-2">{prescored && aiActive ? `Score ${sc.score} · ${sc.band} risk` : 'Score it on the manual scale.'}</p>
          </div>
          {prescored && aiActive && (
            <PillTag tone={sc.band === 'High' ? 'crit' : 'warn'} size="sm" icon={TriangleAlert}>
              {sc.band}
            </PillTag>
          )}
        </div>

        {prescored && aiActive && (
          <>
            {/* Only the criteria that are MET — a driver that did not fire is not evidence. */}
            <ul className="mt-[10px] flex flex-wrap gap-[6px]">
              {sc.drivers
                .filter((d) => !d.toLowerCase().includes('not met'))
                .map((d) => (
                  <li key={d}>
                    <PillTag tone="neu" size="sm">
                      {d}
                    </PillTag>
                  </li>
                ))}
            </ul>
            <p className="mt-[10px] rounded-[12px] bg-sh-card px-[12px] py-[8px] text-[13px] text-sh-text-2">
              <strong className="font-semibold text-sh-text">Required action.</strong> {sc.action}
            </p>
            <AIActionBar
              className="mt-[12px]"
              touchpointId={touchpointId}
              capabilityId="AI-211"
              gate="G1"
              band={band}
              score={sc.confidence}
              locked={locked}
              explain={{
                touchpointId,
                capabilityId: 'AI-211',
                claim: `${sc.name} scores ${sc.score}, which is ${sc.band?.toLowerCase()} risk.`,
                confidence: sc.confidence ?? 0,
                band,
                computedAt: formatTime(NOW),
                inputs: sc.drivers.map((d) => ({ label: d, source: 'Admission record and flowsheet' })),
                evidence: [sc.action ?? ''],
                model: 'risk-scales v2.4.0',
                limits: [
                  'Scores from what is charted. An unrecorded fall at home does not reach it.',
                  'The manual scale remains the fallback and the authority.',
                  'Scales are validated for adult inpatients only.',
                ],
              }}
            />
          </>
        )}
        {/* The manual scale is the fallback and the authority — with the AI off, without a pre-score, or after its score is rejected. */}
        {(!aiActive || !prescored || rejected) && (
          <CheckboxRow
            className="-mx-[10px] mt-[6px] w-[calc(100%+20px)]"
            checked={record.text[`scale:${sc.key}`] === 'confirmed'}
            disabled={locked}
            onChange={(v) => setSectionText(noteId, `scale:${sc.key}`, v ? 'confirmed' : '')}
          >
            Scored manually and confirmed
          </CheckboxRow>
        )}
      </Card>
    )
  }

  return (
    <ScreenFrame
      screenId="S-08-07"
      patient={p}
      heading="Admission assessment"
      sub={`CMP-NABH-01 · admitted ${formatDateTime(enc.startedAt)}`}
      chips={
        <>
          <span title="Initial assessment due within 24 hours of admission">
            <PillTag tone={clock.overdue ? 'crit' : 'warn'} size="sm" icon={Clock}>
              {clock.overdue ? `${late} overdue` : `${formatElapsed(clock.remaining * 60)} remaining`}
            </PillTag>
          </span>
          {record.status === 'cosign-pending' && (
            <PillTag tone="pend" size="sm" icon={PenLine}>
              Co-sign pending
            </PillTag>
          )}
        </>
      }
      actions={
        may(progress) && (
          <Pill variant="card" size="xl" icon={PenLine} iconSize={17} onClick={() => navigate(progress)}>
            Progress note
          </Pill>
        )
      }
      actionBar={
        locked ? (
          <>
            <span className="flex items-center gap-[8px] text-[13px] tabular-nums text-sh-text-2">
              <Icon icon={Lock} size={14} />
              Signed by {record.signedBy ?? me.name}
              {record.coSignedBy ? `, co-signed by ${record.coSignedBy}` : ''} ·{' '}
              {formatDateTime(record.signedAt ? new Date(record.signedAt) : NOW)}
            </span>
            {may(progress) && (
              <Pill variant="primary" size="lg" icon={ArrowRight} className="ml-auto" onClick={() => navigate(progress)}>
                Progress note
              </Pill>
            )}
          </>
        ) : (
          <>
            <Pill
              variant="control"
              size="lg"
              icon={Save}
              onClick={() => {
                saveDraft(noteId, 'manual')
                toast({ tone: 'info', title: 'Draft saved', detail: 'Nothing is signed. The NABH clock keeps running until you sign.' })
              }}
            >
              Save draft
            </Pill>
            <span className="text-[12px] tabular-nums text-sh-text-2">
              {record.savedAt ? `${record.savedHow === 'auto' ? 'Autosaved' : 'Saved'} ${formatTime(new Date(record.savedAt))}` : 'Autosave on'}
            </span>
            <span className="text-[13px] text-sh-text-2">
              {confirmedCount} of {scales.length} scales confirmed
              {history.trim().length < 10 && ' · history needed'}
              {!complete && confirmedCount === scales.length && history.trim().length >= 10 && ' · tick the declaration'}
            </span>
            <Pill
              variant="primary"
              size="lg"
              icon={Signature}
              className={cn('ml-auto', !canSign && 'opacity-40')}
              aria-disabled={!canSign}
              title={canSign ? undefined : 'History, both screens, all three scales and the declaration are needed'}
              onClick={sign}
            >
              {maySign ? 'Sign assessment' : 'Save for co-sign'}
            </Pill>
          </>
        )
      }
    >
      {locked && (
        <LockedBanner
          by={`${record.signedBy ?? me.name}${record.coSignedBy ? `, co-signed by ${record.coSignedBy}` : ''}`}
          at={formatDateTime(record.signedAt ? new Date(record.signedAt) : NOW)}
          reason="signed"
        />
      )}
      {clock.overdue && !locked && (
        <Alert tone="warn" role="alert" icon={TriangleAlert} title="This assessment is past its 24-hour window">
          Completing it now is still the right thing to do. The delay is recorded rather than hidden — an accreditation record that quietly back-dates itself is worse than
          one that shows a miss.
        </Alert>
      )}
      {!maySign && !locked && (
        <Alert tone="warn" title="You may write this assessment but not sign it">
          A consultant signs it. Your entry is saved as <strong className="font-semibold text-sh-text">Co-sign pending</strong> and appears in their queue.
        </Alert>
      )}
      {!locked && (showValidation || forced === 'VALIDATION') && problems.length > 0 && <ValidationSummary problems={problems} />}

      <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-2 lg:items-start">
        <Card titleSize="sm" title="History and presenting problem" headerClassName="mb-[4px]">
          <p className="mb-[12px] text-[12px] text-sh-text-3">
            Dictate or type.{carriedNote ? ' The admission note can be carried forward, and is marked as such.' : ''}
          </p>
          <VoiceField
            id="ass-history"
            label="History"
            required
            rows={7}
            value={history}
            disabled={locked}
            onChange={(v) => setSectionText(noteId, 'history', v, carried && v.trim() !== '' ? 'carried' : undefined)}
            onDictated={(meta) => setSectionText(noteId, 'history', meta.text, 'dictated')}
            labelExtra={
              carried && (
                <PillTag tone="neu" size="xs" icon={ArrowRight}>
                  carried forward
                </PillTag>
              )
            }
          />
          {carriedNote && history.trim() === '' && !locked && (
            <Pill variant="ghost" size="md" icon={ArrowRight} className="mt-[6px] self-start" onClick={() => setSectionText(noteId, 'history', carriedNote, 'carried')}>
              Carry forward from the admission note
            </Pill>
          )}
          {carriedNote && (
            <p className="mt-[8px] flex items-start gap-[8px] text-[12px] text-sh-text-3">
              <Icon icon={Info} size={13} className="mt-[2px] shrink-0" />
              Carried-forward text is marked as carried forward, so a reviewer can tell it from something newly assessed today.
            </p>
          )}
        </Card>

        <Card titleSize="sm" title="Nutrition and functional screening">
          <div className="flex flex-col gap-[12px]">
            <Field label="Nutrition risk" required htmlFor="ass-nutrition">
              <Select id="ass-nutrition" value={nutrition} disabled={locked} onChange={(e) => setSectionText(noteId, 'nutrition', e.target.value)}>
                <option value="">Choose…</option>
                {NUTRITION.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Functional status on admission" required htmlFor="ass-function">
              <Select id="ass-function" value={functional} disabled={locked} onChange={(e) => setSectionText(noteId, 'function', e.target.value)}>
                <option value="">Choose…</option>
                {FUNCTION.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      </div>

      <Card titleSize="sm" title="Risk assessment scales" headerClassName="mb-[4px]">
        <p className="mb-[8px] text-[12px] text-sh-text-3">{scales.some((s) => s.score !== undefined) && aiActive ? 'Pre-scored · each needs a disposition' : 'Scored manually · each needs confirming'}</p>
        <Why label="How these scales are pre-scored" className="mb-[8px]">
          <p>Three scales are pre-scored from the record. Each still needs your disposition, and the manual scale is the fallback — the score is a starting point, not the assessment.</p>
        </Why>
        <div className="flex flex-col gap-[12px]">{scales.map(scale)}</div>
      </Card>

      <Card>
        <CheckboxRow checked={complete} disabled={locked} onChange={(v) => setSectionText(noteId, 'complete', v ? 'yes' : '')} className="-mx-[10px] w-[calc(100%+20px)]">
          I have completed the initial assessment, including the risk scales and the actions they require.
          <span className="block text-[12px] text-sh-text-3">Fixed wording. It is stamped with your name, registration number and the time on completion.</span>
        </CheckboxRow>
      </Card>
    </ScreenFrame>
  )
}
