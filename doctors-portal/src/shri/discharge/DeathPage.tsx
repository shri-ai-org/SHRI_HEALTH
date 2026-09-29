/**
 * S-13-06 · Death, MCCD and body handover — `/encounter/:id/death`
 * (`src/screens/m13/S1306.tsx`): "Death certification, and the handover that
 * follows it."
 *
 * Four steps, because the statutory order matters: CMP-STAT-03's MCCD records
 * cause of death as a SEQUENCE, not a list, and CMP-STAT-01 means a
 * medico-legal case is intimated to the police and acknowledged BEFORE the
 * body is released. Calm here means fewer words beside the form, not fewer
 * steps; AI-810 speaks only when the sequence does not read as a chain.
 *
 * Where the old wizard fell short: it fell back to Joseph Mathew's encounter
 * at an unknown address — here an unknown encounter says so. Its police
 * station and docket were "required" but never read — here the handover waits
 * for them. It kept nothing: the certificate, the family, the identification
 * and the belongings went with the screen, and certifying wrote no record —
 * here the MCCD is kept once per death, the admission closes as a death, the
 * front office is told, and it is on the audit trail. A time of death after
 * the present is refused.
 *
 * One conflict kept as the old build had it, and flagged: Part I's guidance
 * says to leave (b) empty when there is no antecedent cause, while (b) is
 * required to continue. The requirement is the rule and stands.
 */

import { Check, ChevronLeft, ChevronRight, FileCheck2, Gavel, Signature } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import type { Encounter } from '@/data/clinical'
import { NOW, formatDateTime } from '@/data/format'
import { DIAGNOSES, patient } from '@/data/kit'
import { useClinical, type DeathRecord } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { DEATH_STEPS, FAMILY_INFORMED, IDENTIFICATION, NOW_LOCAL, chainRepeats, chainText, useCertifyDeath } from '../logic/death'
import { maybeEncounter } from '../logic/encounter'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { useAiActive, useForcedState } from '../state/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select, TextArea, TextInput } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { ValidationSummary } from '../ui/states'

export function DeathPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-13-06" />
  return <Death key={enc.id} enc={enc} />
}

function Death({ enc }: { enc: Encounter }) {
  const p = patient(enc.patientId)
  const certified = useClinical((s) => s.deaths[p.id])
  return certified ? <Certified record={certified} /> : <Wizard enc={enc} />
}

function MlcChip() {
  return (
    <PillTag tone="warn" size="sm" icon={Gavel} className="font-semibold" title="Medico-legal case — police intimation required">
      MLC
    </PillTag>
  )
}

function Wizard({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const aiActive = useAiActive()
  const forced = useForcedState()
  const certify = useCertifyDeath()
  const p = patient(enc.patientId)

  const [step, setStep] = useState(0)
  const [diedAt, setDiedAt] = useState('')
  const [familyInformed, setFamilyInformed] = useState<string>(FAMILY_INFORMED[0])
  const [immediate, setImmediate] = useState('')
  const [antecedent1, setAntecedent1] = useState('')
  const [antecedent2, setAntecedent2] = useState('')
  const [contributing, setContributing] = useState('')
  const [isMlc, setIsMlc] = useState(p.mlc ?? false)
  const [stationDocket, setStationDocket] = useState('')
  const [policeAck, setPoliceAck] = useState(false)
  const [releasedTo, setReleasedTo] = useState('')
  const [identification, setIdentification] = useState<string>(IDENTIFICATION[0])
  const [belongings, setBelongings] = useState('')
  const [showValidation, setShowValidation] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const locked = forced === 'LOCKED'

  /** What each step still needs, in the order the form asks. */
  const stepProblems: { field: string; message: string }[][] = [
    !diedAt.trim()
      ? [{ field: 'Time of death', message: 'required — as it was observed' }]
      : diedAt > NOW_LOCAL
        ? [{ field: 'Time of death', message: `cannot be later than now (${formatDateTime(NOW)})` }]
        : [],
    [
      ...(immediate.trim() ? [] : [{ field: '(a) Immediate cause', message: 'required' }]),
      ...(antecedent1.trim() ? [] : [{ field: '(b) Due to, or as a consequence of', message: 'required' }]),
    ],
    isMlc
      ? [
          ...(stationDocket.trim() ? [] : [{ field: 'Police station and docket', message: 'required for a medico-legal case' }]),
          ...(policeAck ? [] : [{ field: 'Acknowledgement', message: 'the body is not released until it is recorded' }]),
        ]
      : [],
    releasedTo.trim() ? [] : [{ field: 'Released to', message: 'name and relationship' }],
  ]
  const stepValid = stepProblems.map((x) => x.length === 0)
  const canComplete = stepValid.every(Boolean) && !locked
  const problems = step < DEATH_STEPS.length - 1 ? stepProblems[step] : stepProblems.flat()
  const repeated = chainRepeats(immediate, antecedent1, antecedent2)

  function go(next: number) {
    setShowValidation(false)
    setStep(next)
  }

  function onContinue() {
    if (!stepValid[step]) {
      setShowValidation(true)
      return
    }
    go(step + 1)
  }

  function onCertify() {
    if (!canComplete) {
      setShowValidation(true)
      return
    }
    setConfirming(true)
  }

  function certifyNow() {
    setConfirming(false)
    const record: Omit<DeathRecord, 'verifiedBy' | 'registrationNo' | 'certifiedAt'> = {
      patientId: p.id,
      encounterId: enc.id,
      diedAt,
      familyInformed,
      causes: { a: immediate.trim(), b: antecedent1.trim(), c: antecedent2.trim() },
      contributing: contributing.trim(),
      mlc: isMlc,
      police: isMlc ? { stationDocket: stationDocket.trim(), acknowledged: policeAck } : undefined,
      handover: { releasedTo: releasedTo.trim(), identification, belongings: belongings.trim() },
    }
    if (certify(record) && may('/ip/patients')) navigate('/ip/patients')
  }

  return (
    <>
      <ScreenFrame
        screenId="S-13-06"
        patient={p}
        sub={`MCCD Form 4 · ${DEATH_STEPS[step]}`}
        // The banner already says MLC for a patient recorded as one; the chip marks a case made medico-legal here.
        chips={isMlc && !p.mlc && <MlcChip />}
        actionBar={
          <>
            {step > 0 && (
              <Pill variant="control" size="lg" icon={ChevronLeft} onClick={() => go(step - 1)}>
                Back
              </Pill>
            )}
            <span className="text-[13px] tabular-nums text-sh-text-2">
              Step {step + 1} of {DEATH_STEPS.length}
            </span>
            {step < DEATH_STEPS.length - 1 ? (
              <Pill
                variant="primary"
                size="lg"
                className={cn('ml-auto', !stepValid[step] && 'opacity-40')}
                aria-disabled={!stepValid[step]}
                onClick={onContinue}
              >
                Continue
                <Icon icon={ChevronRight} size={16} />
              </Pill>
            ) : (
              <Pill
                variant="primary"
                size="lg"
                icon={Signature}
                className={cn('ml-auto', !canComplete && 'opacity-40')}
                aria-disabled={!canComplete}
                onClick={onCertify}
              >
                Certify and release
              </Pill>
            )}
          </>
        }
      >
        <ol aria-label="Steps" className="flex flex-wrap gap-x-[8px] gap-y-[8px]">
          {DEATH_STEPS.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'inline-flex min-h-[36px] items-center gap-[8px] rounded-full px-[14px] text-[13px] font-medium',
                i === step ? 'bg-sh-primary text-sh-on-primary' : i < step ? 'bg-sh-card text-sh-text' : 'bg-sh-card text-sh-text-3',
              )}
            >
              <span className="tabular-nums">{i < step ? <Icon icon={Check} size={13} /> : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {(showValidation || forced === 'VALIDATION') && problems.length > 0 && <ValidationSummary problems={problems} />}

        {step === 0 && (
          <Card titleSize="sm" title="Verification of death" headerClassName="mb-[4px]">
            <p className="mb-[12px] text-[12px] text-sh-text-3">Recorded by the clinician who verified it, with the time</p>
            <div className="flex max-w-[560px] flex-col gap-[14px]">
              <Field label="Time of death" required htmlFor="dod-time" hint="24-hour clock, as it was observed">
                <TextInput id="dod-time" type="datetime-local" max={NOW_LOCAL} value={diedAt} disabled={locked} onChange={(e) => setDiedAt(e.target.value)} />
              </Field>
              <Field label="Verified by" htmlFor="dod-by">
                <TextInput id="dod-by" value={`${me.name} · ${me.identifierKind} ${me.identifier}`} readOnly />
              </Field>
              <Field label="Family informed" htmlFor="dod-family">
                <Select id="dod-family" value={familyInformed} disabled={locked} onChange={(e) => setFamilyInformed(e.target.value)}>
                  {FAMILY_INFORMED.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>
        )}

        {step === 1 && (
          <>
            {/* The operative rule for Part I — a sequence, not a list. One sentence. */}
            <Alert tone="info" title="Part I is a chain, read downwards">
              Each line is caused by the line below it; with no antecedent cause, leave (b) and (c) empty rather than repeating (a).
            </Alert>
            <Card titleSize="sm" title="Part I · the causal sequence">
              <div className="flex max-w-[640px] flex-col gap-[14px]">
                <Field label="(a) Immediate cause" required htmlFor="cod-a">
                  <TextInput id="cod-a" list="dx-list" value={immediate} disabled={locked} onChange={(e) => setImmediate(e.target.value)} placeholder="The condition directly leading to death" />
                </Field>
                <Field label="(b) Due to, or as a consequence of" required htmlFor="cod-b">
                  <TextInput id="cod-b" list="dx-list" value={antecedent1} disabled={locked} onChange={(e) => setAntecedent1(e.target.value)} placeholder="The antecedent cause" />
                </Field>
                <Field label="(c) Due to, or as a consequence of" htmlFor="cod-c">
                  <TextInput id="cod-c" list="dx-list" value={antecedent2} disabled={locked} onChange={(e) => setAntecedent2(e.target.value)} placeholder="The underlying cause, if there is one" />
                </Field>
                <datalist id="dx-list">
                  {DIAGNOSES.map((d) => (
                    <option key={d.icd10} value={`${d.label} (${d.icd10})`} />
                  ))}
                </datalist>
              </div>
            </Card>
            <Card titleSize="sm" title="Part II · other significant conditions" headerClassName="mb-[4px]">
              <p className="mb-[12px] text-[12px] text-sh-text-3">Contributed to death but were not part of the sequence above</p>
              <Field label="Contributing conditions" htmlFor="cod-ii" className="max-w-[640px]">
                <TextArea id="cod-ii" rows={3} value={contributing} disabled={locked} onChange={(e) => setContributing(e.target.value)} placeholder="Type 2 diabetes, chronic kidney disease…" />
              </Field>
            </Card>

            {/* AI-810 speaks only when it disagrees. A coherent chain earns silence. */}
            {aiActive && repeated && (
              <Alert tone="warn" role="alert" title="The sequence repeats itself">
                A line in Part I repeats another. Each line should be a distinct condition that caused the one above it; a repeated line will not code and the registration is
                rejected. Flagged by AI-810; it never fills the cause in for you.
              </Alert>
            )}

            <Why label="Why a sequence, not a list">
              <p>
                Part I records a causal chain, read downwards: (a) is caused by (b), which is caused by (c). Part II is for conditions that contributed without being in that
                chain. Recorded as a list instead, the certificate cannot be coded and the registration is rejected.
              </p>
              <p className="mt-[8px] text-sh-text-3">
                CMP-STAT-03 · Form 4 for an institutional death.
                {aiActive && ' AI-810 checks that the sequence is causally coherent and that the medico-legal steps are present. It flags; it never fills the cause of death in for you.'}
              </p>
            </Why>
          </>
        )}

        {step === 2 && (
          <Card titleSize="sm" title="Medico-legal status">
            <div className="flex max-w-[640px] flex-col gap-[12px]">
              <CheckboxRow checked={isMlc} disabled={locked} onChange={setIsMlc} className="-mx-[10px] w-[calc(100%+20px)]">
                This is a medico-legal case
                <span className="block text-[12px] text-sh-text-3">Unnatural death, injury, poisoning, custody, or a death within 24 hours of admission without a clear cause.</span>
              </CheckboxRow>
              {isMlc ? (
                <>
                  {/* The gate itself — operative, so it stays an alert. */}
                  <Alert tone="warn" title="Police intimation is required, and must be acknowledged">
                    The body is not released until the acknowledgement is recorded. Sending the intimation is not the gate; receiving the acknowledgement is.
                  </Alert>
                  <Field label="Police station and docket" required htmlFor="mlc-station">
                    <TextInput id="mlc-station" value={stationDocket} disabled={locked} onChange={(e) => setStationDocket(e.target.value)} placeholder="Peelamedu PS · docket number" />
                  </Field>
                  <CheckboxRow checked={policeAck} disabled={locked} onChange={setPoliceAck} className="-mx-[10px] w-[calc(100%+20px)]">
                    Acknowledgement received and filed
                    <span className="block text-[12px] text-sh-text-3">Records who acknowledged it and when. This unblocks the handover step.</span>
                  </CheckboxRow>
                  <Why label="Why the acknowledgement is the gate">
                    <p>
                      CMP-STAT-01 · intimation with acknowledgement. A medico-legal death is intimated to the police and the acknowledgement is filed before the body is released;
                      the intimation alone leaves the release unlawful and the record unable to show who was told.
                    </p>
                  </Why>
                </>
              ) : (
                <p className="text-[13px] text-sh-text-2">
                  A natural death with a clear cause proceeds to handover; if in doubt, mark it medico-legal — reversible before certification, not after.
                </p>
              )}
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card titleSize="sm" title="Body handover" headerClassName="mb-[4px]">
            <p className="mb-[12px] text-[12px] text-sh-text-3">Who is receiving, and their relationship to the deceased</p>
            <div className="flex max-w-[640px] flex-col gap-[14px]">
              <Field label="Released to" required htmlFor="handover-to">
                <TextInput id="handover-to" value={releasedTo} disabled={locked} onChange={(e) => setReleasedTo(e.target.value)} placeholder="Name and relationship" />
              </Field>
              <Field label="Identification produced" htmlFor="handover-id">
                <Select id="handover-id" value={identification} disabled={locked} onChange={(e) => setIdentification(e.target.value)}>
                  {IDENTIFICATION.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Belongings returned" htmlFor="handover-belongings">
                <TextArea id="handover-belongings" rows={2} value={belongings} disabled={locked} onChange={(e) => setBelongings(e.target.value)} placeholder="Itemised, and countersigned by the receiver" />
              </Field>
              {isMlc && !stepValid[2] && (
                <Alert tone="crit" role="alert" title="Handover is blocked">
                  This is a medico-legal case and the police acknowledgement has not been recorded. Go back to the medico-legal step.
                </Alert>
              )}
            </div>
          </Card>
        )}
      </ScreenFrame>

      <ConfirmDialog
        open={confirming}
        title="Certify the cause of death and release the body?"
        consequence={`This issues the MCCD under your name and ${me.identifierKind} ${me.identifier}, registers the death with the civil registration system, and records the handover. It cannot be undone — a correction is a formal amendment to the certificate.`}
        confirmLabel="Certify and release"
        onConfirm={certifyNow}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}

/** A certified death, read back: the certificate as it was issued. Nothing on it is editable. */
function Certified({ record }: { record: DeathRecord }) {
  const p = patient(record.patientId)
  const rows: [string, string][] = [
    ['Time of death', formatDateTime(new Date(record.diedAt))],
    ['Verified by', `${record.verifiedBy} · ${record.registrationNo}`],
    ['Family informed', record.familyInformed],
    ['Part I', chainText(record.causes)],
    ['Part II', record.contributing || '—'],
    ['Medico-legal', record.mlc ? `Yes · ${record.police?.stationDocket} · acknowledgement filed` : 'No'],
    ['Released to', record.handover.releasedTo],
    ['Identification produced', record.handover.identification],
    ['Belongings returned', record.handover.belongings || '—'],
  ]
  return (
    <ScreenFrame screenId="S-13-06" patient={p} sub="MCCD Form 4 · Certified" chips={record.mlc && !p.mlc && <MlcChip />}>
      <Alert tone="info" icon={FileCheck2} title="Certified">
        Form 4 was certified by {record.verifiedBy} at {formatDateTime(new Date(record.certifiedAt))}. Registration queued; handover recorded. A correction is a formal amendment
        to the certificate.
      </Alert>
      <Card titleSize="sm" title="Medical certificate of cause of death">
        <dl className="grid grid-cols-1 gap-x-[24px] gap-y-[12px] sm:grid-cols-[200px_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[13px] text-sh-text-2">{k}</dt>
              <dd className="text-[14px] text-sh-text">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </ScreenFrame>
  )
}
