/**
 * S-18-17 · Thrombolysis — `/stroke/case/:id/thrombolysis` (`src/screens/
 * m18/S1817.tsx`): "Eligibility, dose, consent and cost — with cost never
 * blocking."
 *
 * Its drawing notes, implemented rather than illustrated: every item
 * answerable UNKNOWN with its consequence shown; the BP gate with its
 * treat-to-target sub-flow, unblocking ONLY when BP is documented below
 * threshold; the cost panel "treat now, authorise in parallel", display only;
 * the independent second dose check mandatory EVEN WHEN THE AI IS OFF, because
 * it is a rule, not a model output. The gate itself is `logic/thrombolysis.ts`.
 *
 * Where the old screen fell short, each fixed toward safety: "Answer unknown"
 * lifted the BP block and the DOAC contraindication (an unknown is now the
 * answer, and the item still blocks); "Override with reason" took no reason
 * and recorded a family confirmation that never happened (it now asks for the
 * reason and records it as an override); the "second qualified person" could
 * be the billing desk (now a doctor or a nurse, never the prescriber); the
 * check's time was the time of viewing; the needle could be "given" again
 * after it was stamped. Another case than the one this checklist was drawn for
 * sees its own rule-based eligibility and nothing to give (`NotLvo`).
 */

import { Activity, Ban, Check, PhoneCall, Scale, Send, ShieldAlert, Syringe, Users } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatRupees, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { THROMBOLYSIS_COST, THROMBOLYSIS_CRITERIA, THROMBOLYSIS_DOSE, type StrokeCase } from '@/data/stroke'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock, useLiveIntervals } from '../logic/caseClock'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { bpBelowThreshold, criterionNow, isBlocking, mayGive, outstanding, secondCheckers } from '../logic/thrombolysis'
import { useAiActive } from '../state/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Select, TextArea, TextInput } from '../ui/forms'
import { KeyValue } from '../ui/KeyValue'
import { Card, Diamond, Icon, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { Checklist, type ChecklistItem } from './Checklist'
import { NoCase, NotRecordedHere } from './NotLvo'

const FAMILY_CONFIRMED = 'Family confirmed the last dose was more than 48 hours ago'

export function ThrombolysisPage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-17" id={id} />
  if (!isIndexCase(c)) return <NotRecordedHere key={c.id} c={c} screenId="S-18-17" heading="Thrombolysis" pathwayKey="thrombolysis" />
  return <Eligibility key={c.id} c={c} />
}

function Eligibility({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const intervals = useLiveIntervals()
  const { criteria, answerCriterion, bpTreated, treatBp, secondCheckBy, setSecondCheck, stamp, isStamped } = useStroke()
  const p = patient(c.patientId)

  const [bpSystolic, setBpSystolic] = useState('')
  const [bpDiastolic, setBpDiastolic] = useState('')
  const [treating, setTreating] = useState(false)
  const [checker, setChecker] = useState('')
  const [consent, setConsent] = useState(false)
  const [confirmGive, setConfirmGive] = useState(false)
  const [doacResolution, setDoacResolution] = useState<string | undefined>()
  const [overriding, setOverriding] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  /** When the second check was recorded here; the store keeps only who. */
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)

  /** The BP item unblocks only when a reading below threshold is DOCUMENTED. */
  const bpResolved = bpBelowThreshold(bpTreated)
  const needleGiven = isStamped('needle')

  const items: ChecklistItem[] = THROMBOLYSIS_CRITERIA.map((crit) => {
    const resolution =
      crit.key === 'bp' && bpResolved && bpTreated ? `${bpTreated.systolic}/${bpTreated.diastolic} after treatment, documented ${formatTime(bpTreated.at)}` : crit.key === 'doac' ? doacResolution : undefined
    const { state, answer } = criterionNow(crit, criteria[crit.key], resolution)

    return {
      key: crit.key,
      label: crit.label,
      answer: <span className="tabular-nums">{answer}</span>,
      consequence: crit.consequence,
      state,
      subFlow:
        crit.key === 'bp' && !bpResolved ? (
          <div className="rounded-[14px] bg-sh-warn-bg px-[14px] py-[12px]">
            <p className="flex items-center gap-[8px] text-[14px] font-semibold text-sh-warn-fg">
              <Icon icon={Syringe} size={15} />
              {crit.subFlow?.label}
            </p>
            <p className="mt-[4px] text-[13px] text-sh-text-2">{crit.subFlow?.detail}</p>
            {!treating ? (
              <Pill variant="primary" size="lg" className="mt-[10px]" onClick={() => setTreating(true)}>
                Start treat-to-target
              </Pill>
            ) : (
              <div className="mt-[12px] flex flex-wrap items-end gap-[8px]">
                <label className="flex flex-col gap-[4px] text-[13px] font-medium text-sh-text-2">
                  Systolic
                  <TextInput value={bpSystolic} inputMode="numeric" onChange={(e) => setBpSystolic(e.target.value.replace(/\D/g, '').slice(0, 3))} className="h-[44px] w-[96px] bg-sh-card" placeholder="172" />
                </label>
                <label className="flex flex-col gap-[4px] text-[13px] font-medium text-sh-text-2">
                  Diastolic
                  <TextInput value={bpDiastolic} inputMode="numeric" onChange={(e) => setBpDiastolic(e.target.value.replace(/\D/g, '').slice(0, 3))} className="h-[44px] w-[96px] bg-sh-card" placeholder="94" />
                </label>
                <Pill
                  variant="primary"
                  size="lg"
                  icon={Check}
                  className="h-[44px]"
                  disabled={!bpSystolic || !bpDiastolic}
                  onClick={() => {
                    const s = Number(bpSystolic)
                    const d = Number(bpDiastolic)
                    treatBp(s, d, me.name)
                    if (s >= 185 || d >= 110) {
                      toast({ tone: 'caution', title: 'Still above threshold', detail: `${s}/${d} is recorded, and the item stays blocked. Repeat the labetalol and re-measure.` })
                    } else {
                      toast({ tone: 'success', title: 'BP documented below threshold', detail: `${s}/${d} at ${formatTime(caseNow)}. The item is unblocked.` })
                    }
                  }}
                >
                  Document this reading
                </Pill>
                {bpTreated && !bpResolved && (
                  <p className="w-full text-[13px] font-medium text-sh-crit-fg">
                    {bpTreated.systolic}/{bpTreated.diastolic} recorded at {formatTime(bpTreated.at)} — still above 185/110, so the item remains blocked. Documenting a reading is not the
                    same as reaching the target.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : undefined,
      actions:
        state === 'resolved' ? undefined : (
          <>
            {crit.actions?.map((a) =>
              a === 'Override with reason' ? (
                <Pill key={a} variant="crit" size="lg" icon={ShieldAlert} onClick={() => setOverriding(true)}>
                  {a}
                </Pill>
              ) : a === 'Family call' ? (
                <Pill
                  key={a}
                  variant="control"
                  size="lg"
                  icon={PhoneCall}
                  onClick={() => {
                    setDoacResolution(FAMILY_CONFIRMED)
                    toast({ tone: 'info', title: 'Family reached', detail: 'Last DOAC dose confirmed as more than 48 hours ago. Recorded against the case.' })
                  }}
                >
                  {a}
                </Pill>
              ) : (
                <Pill key={a} variant="control" size="lg" icon={Send} onClick={() => toast({ tone: 'info', title: a, detail: `Sent for ${crit.label.toLowerCase()} · logged against the case.` })}>
                  {a}
                </Pill>
              ),
            )}
            {/* Every item is answerable unknown — and an unknown never lifts a block. */}
            {crit.state !== 'unknown' && !criteria[crit.key] && (
              <Pill variant="ghost" size="lg" onClick={() => answerCriterion(crit.key, 'Unknown')}>
                Answer unknown
              </Pill>
            )}
          </>
        ),
    }
  })

  const blocking = items.filter((i) => isBlocking(i.state))
  const left = outstanding(blocking.length, secondCheckBy, consent)
  const canGive = mayGive(blocking.length, secondCheckBy, consent) && !needleGiven
  const dtn = intervals.find((i) => i.key === 'dtn')
  const to = { nihss: `/stroke/case/${c.id}/nihss`, clock: `/stroke/case/${c.id}/clock`, transfer: `/stroke/case/${c.id}/transfer` }

  return (
    <ScreenFrame
      screenId="S-18-17"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Thrombolysis"
      sub={`${items.length - blocking.length} of ${items.length} criteria clear · ${
        needleGiven ? 'given' : left === 'blocking' ? `${blocking.length} blocking` : left === 'second check' ? 'second check outstanding' : left === 'consent' ? 'consent outstanding' : 'ready to give'
      }`}
      chips={
        dtn && (
          <PillTag tone={dtn.state === 'BREACH' ? 'crit' : dtn.state === 'DONE' ? 'norm' : 'warn'} size="sm" className="tabular-nums">
            DTN {dtn.elapsed}/{dtn.targetMin} min
          </PillTag>
        )
      }
      actions={
        may(to.nihss) && (
          <Pill variant="card" size="xl" icon={Activity} iconSize={17} onClick={() => navigate(to.nihss)}>
            NIHSS {c.nihss}
          </Pill>
        )
      }
      railTitle="Alongside"
      rail={
        <div className="flex flex-col gap-[12px]">
          {/* Cost. Display only — said once, as the marker on the panel. */}
          <Card
            titleSize="sm"
            title="Cost & coverage"
            right={
              <PillTag tone="norm" size="sm" icon={Check}>
                display only
              </PillTag>
            }
          >
            <dl className="flex flex-col divide-y divide-sh-line">
              <KeyValue label="Tenecteplase">
                <span className="font-semibold tabular-nums">{formatRupees(THROMBOLYSIS_COST.drugCost)}</span>
              </KeyValue>
              <KeyValue label="PM-JAY">
                <PillTag tone="warn" size="xs">
                  {THROMBOLYSIS_COST.pmjay}
                </PillTag>
              </KeyValue>
              <KeyValue label="TPA">
                <PillTag tone="warn" size="xs">
                  {THROMBOLYSIS_COST.tpa}
                </PillTag>
              </KeyValue>
            </dl>
            <p className="mt-[10px] text-[13px] text-sh-text-3">{THROMBOLYSIS_COST.note}</p>
            <Pill
              variant="control"
              size="lg"
              icon={Send}
              className="mt-[10px] w-full"
              onClick={() => toast({ tone: 'info', title: 'Pre-authorisation raised in parallel', detail: 'The TPA desk has it. It is not on the critical path.' })}
            >
              Authorise in parallel
            </Pill>
          </Card>
          <Why label="Why unknown is allowed">
            <p>
              A checklist that only accepts yes or no forces a guess at 02:00. Every item here takes “unknown”, and each unknown shows what follows from it — which is the difference
              between a usable checklist and a form.
            </p>
          </Why>
        </div>
      }
      actionBar={
        <>
          {may(to.clock) && (
            <Pill variant="control" size="bar" icon={Ban} onClick={() => navigate(to.clock)}>
              Not eligible
            </Pill>
          )}
          <span className="text-[13px] text-sh-text-3">
            {needleGiven
              ? 'The needle is stamped'
              : left === 'blocking'
                ? `${blocking.length} item${blocking.length === 1 ? '' : 's'} blocking`
                : left === 'second check'
                  ? 'The second dose check is outstanding'
                  : left === 'consent'
                    ? 'Consent is outstanding'
                    : 'Ready'}
          </span>
          <Pill variant="primary" size="bar" icon={Syringe} className="ml-auto" disabled={!canGive} onClick={() => setConfirmGive(true)}>
            {needleGiven ? 'Needle stamped' : 'Administer & stamp the needle'}
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {blocking.length > 0 && (
          <Alert tone="crit" role="alert" title={`${blocking.length} item${blocking.length === 1 ? '' : 's'} blocking thrombolysis`}>
            Each one names what would unblock it. A blocked item is not a refusal — it is a step you have not taken yet.
          </Alert>
        )}

        {/* The items that need a decision come first; the satisfied ones fold. */}
        <section className="flex flex-col gap-[10px]" aria-labelledby="eligibility-h">
          <div className="flex flex-wrap items-baseline gap-x-[10px]">
            <h2 id="eligibility-h" className="text-[17px] font-medium text-sh-text">
              Eligibility
            </h2>
            <span className="text-[13px] tabular-nums text-sh-text-3">
              {items.length - blocking.length} of {items.length} clear
            </span>
          </div>
          <Checklist items={items} label="Thrombolysis eligibility" />
        </section>

        {/* The dose. Weight-based, so the weight and its capture time are shown. */}
        <Card titleSize="sm" title="Dose">
          <div className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[4px]">
            <span className="text-[18px] font-semibold text-sh-text">{THROMBOLYSIS_DOSE.drug}</span>
            <span className="tabular-nums text-sh-text-2">
              {THROMBOLYSIS_DOSE.perKg} {THROMBOLYSIS_DOSE.unit} × {THROMBOLYSIS_DOSE.weightKg} kg
            </span>
            <span className="text-[24px] font-bold tabular-nums text-sh-pend-fg">= {THROMBOLYSIS_DOSE.totalMg} mg</span>
            <span className="text-[14px] text-sh-text-3">{THROMBOLYSIS_DOSE.administration}</span>
          </div>
          <p className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[13px] tabular-nums text-sh-text-3">
            <Icon icon={Scale} size={13} />
            Weight taken {formatTime(THROMBOLYSIS_DOSE.weightCapturedAt)} · {THROMBOLYSIS_DOSE.weightSource}
          </p>
          {/* AI-305, in one line where the dose is. */}
          {aiActive && (
            <p className="mt-[6px] flex flex-wrap items-center gap-[8px] text-[13px] text-sh-text-2">
              <Diamond />
              Within the licensed range for {THROMBOLYSIS_DOSE.weightKg} kg and below the 25 mg single-bolus ceiling — the static dose table gives the same answer with the model off.
            </p>
          )}

          {/* Mandatory even when the AI is off — it is a rule, not a model. */}
          <div className={cn('mt-[16px] rounded-[14px] px-[16px] py-[14px]', secondCheckBy ? 'bg-sh-norm-bg' : 'bg-sh-warn-bg')}>
            <p className={cn('flex items-center gap-[8px] text-[14px] font-semibold', secondCheckBy ? 'text-sh-norm-fg' : 'text-sh-warn-fg')}>
              <Icon icon={secondCheckBy ? Check : Users} size={16} />
              Independent second check — mandatory
            </p>
            {secondCheckBy ? (
              <p className="mt-[4px] text-[14px] text-sh-text-2">
                Checked by {secondCheckBy}
                {checkedAt && ` at ${formatTime(checkedAt)}`}. Both identities are recorded against the administration.
              </p>
            ) : (
              <>
                <p className="mt-[4px] text-[14px] text-sh-text-2">
                  A second qualified person recomputes the dose from the weight independently. This is a rule, not an AI output —{' '}
                  {aiActive ? 'it is required with the model on and with it off.' : 'the AI is off and it is still required.'}
                </p>
                <div className="mt-[10px] flex flex-wrap items-end gap-[8px]">
                  <label className="flex min-w-[224px] flex-1 flex-col gap-[4px] text-[13px] font-medium text-sh-text-2">
                    Who checked it
                    <Select value={checker} onChange={(e) => setChecker(e.target.value)} aria-label="Second checker" className="h-[48px] bg-sh-card">
                      <option value="">Select…</option>
                      {secondCheckers(me).map((s) => (
                        <option key={s.id} value={s.name}>
                          {s.name} · {s.personaLabel}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <Pill
                    variant="primary"
                    size="lg"
                    icon={Check}
                    className="h-[48px]"
                    disabled={!checker}
                    onClick={() => {
                      setSecondCheck(checker)
                      setCheckedAt(caseNow)
                      toast({ tone: 'success', title: 'Second check recorded', detail: `${checker} · ${THROMBOLYSIS_DOSE.totalMg} mg` })
                    }}
                  >
                    Record the second check
                  </Pill>
                </div>
              </>
            )}
          </div>

          <CheckboxRow checked={consent} onChange={setConsent} className="mt-[12px]">
            Consent discussed and taken — risks, benefits and the alternative of not treating.
            <span className="block text-[13px] text-sh-text-3">
              Where the patient cannot consent, the discussion with the family is recorded instead. A thumb impression with a witness is a first-class signature mode here.
            </span>
          </CheckboxRow>
        </Card>
      </div>

      <ConfirmDialog
        open={overriding}
        title="Override the DOAC contraindication?"
        consequence="Thrombolysis within 48 hours of a DOAC dose risks a bleed. The override is recorded against the case with your name and your reason, and the item then counts as resolved."
        confirmLabel="Override"
        tone="destructive"
        confirmDisabled={overrideReason.trim().length < 10}
        onConfirm={() => {
          const reason = overrideReason.trim()
          setDoacResolution(`Overridden by ${me.name} — “${reason}”`)
          setOverriding(false)
          setOverrideReason('')
          toast({ tone: 'caution', title: 'Contraindication overridden', detail: `${me.name} · recorded against case ${c.caseNo}.` })
        }}
        onCancel={() => {
          setOverriding(false)
          setOverrideReason('')
        }}
      >
        <TextArea
          rows={3}
          aria-label="Reason for the override"
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          placeholder="Why thrombolysis goes ahead despite the DOAC — at least ten characters…"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmGive}
        title="Administer tenecteplase and stamp the needle?"
        consequence={`${THROMBOLYSIS_DOSE.totalMg} mg as a single IV bolus. Stamping the needle closes the door-to-needle interval at the server time and cannot be undone — a correction is an audited amendment on the reconciliation screen.`}
        confirmLabel="Administer and stamp"
        onConfirm={() => {
          if (!canGive) return
          stamp('needle', 'Needle', me.name)
          setConfirmGive(false)
          toast({
            tone: 'success',
            title: `Needle stamped · DTN ${dtn?.elapsed ?? 0} min`,
            detail: `${THROMBOLYSIS_DOSE.totalMg} mg given by ${me.name}, checked by ${secondCheckBy}. Target was 60 minutes.`,
          })
          if (may(to.transfer)) navigate(to.transfer)
        }}
        onCancel={() => setConfirmGive(false)}
      >
        <dl className="flex flex-col divide-y divide-sh-line">
          <KeyValue label="Drug">{THROMBOLYSIS_DOSE.drug}</KeyValue>
          <KeyValue label="Dose">
            <span className="font-semibold tabular-nums">{THROMBOLYSIS_DOSE.totalMg} mg</span>
          </KeyValue>
          <KeyValue label="Second check">{secondCheckBy}</KeyValue>
          <KeyValue label="Prescriber">{me.name}</KeyValue>
          <KeyValue label="Server time">
            <span className="tabular-nums">{formatTime(caseNow)}</span>
          </KeyValue>
        </dl>
      </ConfirmDialog>
    </ScreenFrame>
  )
}
