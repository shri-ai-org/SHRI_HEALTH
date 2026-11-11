import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, IdCard, IndianRupee, Loader2, LogOut, Printer, UserRound } from 'lucide-react'
import { FlowSheet } from '../../components/flow/FlowSheet'
import { AckCard } from '../../components/flow/AckCard'
import { Quadrant } from '../../components/flow/Quadrant'
import { PatientSearch } from '../../components/patient/PatientSearch'
import { Alert } from '../../components/ui/Alert'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { WardIcon } from '../../components/ui/WardIcon'
import { useStoreValue } from '../../hooks/useStore'
import { useNow } from '../../hooks/useNow'
import { getActiveGuestPasses, getPatientById, getPaymentById } from '../../domain/selectors'
import { getAdmissionById, previewDischargeBill } from '../../domain/admissionSelectors'
import { getCurrentAdmissionForPatient } from '../../domain/patientSelectors'
import { dischargeAdmission, repriceAdmissionBill } from '../../domain/admissionActions'
import { armAutoDischarge, isAutoDischargeArmed } from '../../domain/autoDischarge'
import { getState } from '../../domain/store'
import { printBill } from '../../utils/printBill'
import { todayKey } from '../../domain/time'
import { BILL_STATUS_LABEL, BILL_STATUS_TONE, billNumberFor, billServicesSummary, formatRupees } from '../../utils/billing'
import { formatClock } from '../../utils/format'
import { formatDateKey } from '../../utils/dates'
import { cn } from '../../utils/cn'
import { DISCHARGE_TYPES } from '../../types/admission'
import type { Admission, DischargeType } from '../../types/admission'
import type { Patient } from '../../types/patient'
import type { FlowProps } from '../registry'
import { inputClass } from '../../utils/formClasses'

const TYPE_LABEL: Record<DischargeType, string> = {
  'Normal Discharge': 'Normal',
  'Discharge Against Medical Advice': 'Against advice',
  Transfer: 'Transfer',
  Death: 'Death',
}


function isCritical(ward: string | null): boolean {
  return ward === 'ICU' || ward === 'Emergency'
}

function payerOf(admission: Admission): string {
  if (admission.paymentType === 'Self Pay') return 'Self pay'
  return [admission.insuranceProvider ?? admission.paymentType, admission.policyNumber].filter(Boolean).join(' · ')
}

/** The stay on its way out, and what the confirmation says about it. */
interface Leaving {
  admissionId: string
  days: number
  passIds: string[]
}

/**
 * Discharge, on one page: the patient and their stay with how they are leaving
 * on the left, the final bill on the right, and a tracker across the top —
 * Final bill printed → Paid at the billing counter → Discharged. Printing the
 * final bill is the desk's last step: the discharge then finishes by itself the
 * moment the counter records the payment (see domain/autoDischarge), even if
 * this screen is closed. A stay with nothing due is discharged straight away.
 */
export function DischargeFlow({ params, onClose }: FlowProps) {
  const navigate = useNavigate()
  const now = useNow(30000)
  const opened = useStoreValue(getAdmissionById, params.admission ?? '')
  const [patientId, setPatientId] = useState(params.uhid ?? opened?.patientId ?? '')
  const [picking, setPicking] = useState(false)
  const patient = useStoreValue(getPatientById, patientId)
  const current = useStoreValue(getCurrentAdmissionForPatient, patientId)
  const admission = current?.status === 'Admitted' ? current : null
  const preview = useStoreValue(previewDischargeBill, admission?.admissionId ?? '', now)
  const passes = useStoreValue(getActiveGuestPasses, patientId)

  const [dischargeType, setDischargeType] = useState<DischargeType>('Normal Discharge')
  const [remarks, setRemarks] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The stay being discharged once its bill is printed (or discharged at once),
  // with what the confirmation shows — kept, as the stay leaves the patient's record.
  // Reopened while a printed bill is still being paid: pick the wait up again.
  const [leaving, setLeaving] = useState<Leaving | null>(() => {
    const state = getState()
    const waitingStay = getCurrentAdmissionForPatient(state, params.uhid ?? opened?.patientId ?? '')
    if (!waitingStay || !isAutoDischargeArmed(waitingStay.admissionId)) return null
    return {
      admissionId: waitingStay.admissionId,
      days: previewDischargeBill(state, waitingStay.admissionId, Date.now())?.days ?? 0,
      passIds: getActiveGuestPasses(state, waitingStay.patientId).map((pass) => pass.passId),
    }
  })
  const stay = useStoreValue(getAdmissionById, leaving?.admissionId ?? '')
  const finished = stay?.status === 'Discharged' ? stay : null
  const finalBill = useStoreValue(getPaymentById, finished?.paymentId ?? '')

  const showPatientSearch = !patient || picking
  const printed = Boolean(leaving && admission && leaving.admissionId === admission.admissionId)
  const nothingDue = Boolean(preview?.canDischarge)

  function choosePatient(next: Patient) {
    setPatientId(next.patientId)
    setPicking(false)
    setDischargeType('Normal Discharge')
    setRemarks('')
    setError(null)
    setLeaving(null)
  }

  // How the patient is leaving can still change while the bill is being paid.
  function changeDetails(next: { dischargeType?: DischargeType; remarks?: string }) {
    const details = { dischargeType: next.dischargeType ?? dischargeType, remarks: next.remarks ?? remarks }
    if (next.dischargeType) setDischargeType(next.dischargeType)
    if (next.remarks !== undefined) setRemarks(next.remarks)
    if (printed && admission) armAutoDischarge(admission.admissionId, details)
  }

  // The stay is re-priced to this moment and its final bill printed for the
  // billing counter — Care Entry takes no money. From here the discharge waits
  // for the payment and completes on its own.
  function printFinalBill() {
    if (!admission || !preview) return
    setError(null)
    const bill = repriceAdmissionBill(admission.admissionId, now)
    armAutoDischarge(admission.admissionId, { dischargeType, remarks })
    printBill(bill.paymentId)
    setLeaving({ admissionId: admission.admissionId, days: preview.days, passIds: passes.map((pass) => pass.passId) })
  }

  // Nothing due (paid already, or nothing charged): no bill to wait for.
  function dischargeNow() {
    if (!admission || !preview) return
    setError(null)
    setLeaving({ admissionId: admission.admissionId, days: preview.days, passIds: passes.map((pass) => pass.passId) })
    try {
      dischargeAdmission(admission.admissionId, { dischargeType, remarks })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const subtitle = patient
    ? `${patient.name} · ${patient.uhid}${patient.age ? ` · ${patient.age} ${patient.sex.charAt(0)}` : ''}`
    : 'Choose the patient'

  const steps: TrackerStep[] = [
    { label: 'Bill printed', state: finished || printed || nothingDue ? 'done' : admission ? 'current' : 'todo' },
    {
      label: 'Paid at the billing counter',
      state: finished || nothingDue ? 'done' : printed ? 'waiting' : 'todo',
    },
    { label: 'Discharged', state: finished ? 'done' : nothingDue ? 'current' : 'todo' },
  ]

  return (
    <FlowSheet title="Discharge" subtitle={subtitle} icon={LogOut} iconTone="info" onClose={onClose} size="full">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        {admission || finished ? <Tracker steps={steps} /> : null}

        {finished && leaving ? (
          // The end of the page's story: the bed is free.
          <div className="flex justify-center py-4">
            <div className="w-full max-w-xl rounded-2xl border border-border bg-surface-1 px-6 shadow-card">
              <AckCard
                title="Discharging Patient"
                icon={LogOut}
                // Longer than usual: it arrives on its own when the payment is recorded, not after a click.
                durationMs={6000}
                onDone={onClose}
                action={
                  finalBill ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigate(`/payments/${finalBill.paymentId}/receipt`, { replace: true, state: { autoPrint: true } })}
                    >
                      <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Print receipt
                    </Button>
                  ) : undefined
                }
              >
                <p className="text-base font-semibold text-ink">
                  {finished.wardLabel} · {finished.bedNumber} is now available
                </p>
                <p>
                  {finished.admissionNumber} · Day {leaving.days} · {TYPE_LABEL[finished.dischargeType ?? 'Normal Discharge']}
                </p>
                {finalBill ? <p>Bill {formatRupees(finalBill.totalAmount)} · paid</p> : null}
                {leaving.passIds.length > 0 ? <p>Guest pass {leaving.passIds.join(', ')} returned</p> : null}
              </AckCard>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {/* Left · the patient, their stay, and how they are leaving */}
            <Quadrant step={1} title="Patient & stay" icon={UserRound} hue="blue" done={Boolean(admission)} allowOverflow scrollFrom="xl">
              <div className="flex flex-col gap-4">
                {showPatientSearch ? (
                  <div className="flex flex-col gap-2">
                    <PatientSearch mode="pick" scope="inpatients" onPick={choosePatient} autoFocus placeholder="Search for an admitted patient by name, mobile, UHID or ABHA" />
                    {patient ? (
                      <button type="button" onClick={() => setPicking(false)} className="self-start text-xs font-semibold text-primary-text hover:underline">
                        Keep {patient.name}
                      </button>
                    ) : null}
                  </div>
                ) : patient ? (
                  <div className="flex items-start justify-between gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 dark:border-primary-500/35">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-ink">{patient.name}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {patient.uhid}
                        {patient.age ? ` · ${patient.age} ${patient.sex}` : ''}
                        {patient.mobile ? ` · ${patient.mobile}` : ''}
                      </p>
                    </div>
                  </div>
                ) : null}

                {patient && !showPatientSearch && !admission ? (
                  <Alert tone="warning">
                    {current
                      ? `${patient.name}’s admission is still waiting for a bed — there is nothing to discharge.`
                      : `${patient.name} is not admitted — there is nothing to discharge.`}
                  </Alert>
                ) : null}
                {admission && preview ? <StaySummary admission={admission} days={preview.days} /> : null}

                {admission && preview ? (
                  <div className="flex flex-col gap-2.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">How the patient is leaving</p>
                    <div role="radiogroup" aria-label="Discharge type" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {DISCHARGE_TYPES.map((type) => (
                        <button
                          key={type}
                          type="button"
                          role="radio"
                          aria-checked={dischargeType === type}
                          title={type}
                          onClick={() => changeDetails({ dischargeType: type })}
                          className={cn(
                            'focus-ring min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                            dischargeType === type ? 'border-primary-600 bg-primary-600 text-on-primary' : 'border-border bg-surface-1 text-ink-muted hover:bg-surface-2',
                          )}
                        >
                          {TYPE_LABEL[type]}
                        </button>
                      ))}
                    </div>
                    <input
                      value={remarks}
                      onChange={(event) => changeDetails({ remarks: event.target.value })}
                      placeholder="Remarks (optional)"
                      aria-label="Discharge remarks"
                      className={inputClass}
                    />
                    {passes.length > 0 ? (
                      <p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-muted">
                        <IdCard className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                        Collect guest pass {passes.map((pass) => pass.passId).join(', ')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Quadrant>

            {/* Right · the final bill, and the one action left */}
            <Quadrant
              step={2}
              title="Bill"
              icon={IndianRupee}
              hue="green"
              done={nothingDue}
              scrollFrom="xl"
            >
              {!admission || !preview ? null : (
                <div className="flex flex-col gap-4">
                  <div className="divide-y divide-border-soft rounded-xl border border-border">
                    {preview.items.map((item) => (
                      <BillLine key={item.code} label={item.description} value={formatRupees(item.amount)} />
                    ))}
                    <BillLine label="Total" value={formatRupees(preview.total)} strong />
                    {preview.paid > 0 ? <BillLine label="Paid so far" value={`− ${formatRupees(preview.paid)}`} /> : null}
                    <BillLine label={nothingDue ? 'Nothing due' : 'Still due'} value={formatRupees(preview.balance)} strong />
                  </div>

                  {nothingDue ? (
                    <div className="flex flex-col gap-3 rounded-xl border border-success-fg/25 bg-success-bg/50 px-4 py-3">
                      <p className="text-sm font-medium text-success-fg">Payment received</p>
                      <Button size="lg" onClick={dischargeNow}>
                        <LogOut className="h-4 w-4" strokeWidth={1.75} />
                        Discharge now
                      </Button>
                    </div>
                  ) : printed ? (
                    <div className="flex flex-col gap-2 rounded-xl border border-warning-fg/25 bg-warning-bg/40 px-4 py-3" role="status">
                      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <Loader2 className="h-4 w-4 animate-spin text-warning-fg" strokeWidth={2} aria-hidden="true" />
                        Payment pending
                      </p>
                      <Button size="sm" variant="ghost" onClick={printFinalBill} className="self-start">
                        <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Print again
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 rounded-xl border border-border-soft bg-surface-2/50 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge tone={BILL_STATUS_TONE[preview.billStatus]}>{BILL_STATUS_LABEL[preview.billStatus]}</Badge>
                      </div>
                      <Button size="lg" onClick={printFinalBill}>
                        <Printer className="h-4 w-4" strokeWidth={1.75} />
                        Print bill
                      </Button>
                    </div>
                  )}

                  {preview.otherDues.length > 0 ? (
                    <div className="rounded-xl bg-surface-2 px-4 py-3">
                      <p className="text-xs font-semibold text-ink-muted">Other bills due</p>
                      <ul className="mt-1.5 space-y-1 text-sm">
                        {preview.otherDues.map((bill) => (
                          <li key={bill.paymentId} className="flex justify-between gap-3">
                            <span className="min-w-0 truncate text-ink">
                              {billNumberFor(bill)} · {billServicesSummary(bill)}
                            </span>
                            <span className="shrink-0 tabular-nums text-ink">{formatRupees(bill.balance)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {error ? <Alert tone="critical">{error}</Alert> : null}
                </div>
              )}
            </Quadrant>
          </div>
        )}
      </div>
    </FlowSheet>
  )
}

type TrackerState = 'todo' | 'current' | 'waiting' | 'done'
interface TrackerStep {
  label: string
  state: TrackerState
}

/** Where the discharge has got to, across the top of the page. */
function Tracker({ steps }: { steps: TrackerStep[] }) {
  return (
    <ol className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-surface-1 px-4 py-3 shadow-card-sm sm:flex-row sm:items-center sm:gap-0">
      {steps.map((step, index) => (
        <li key={step.label} className="flex flex-1 items-center gap-2.5">
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
              step.state === 'done' && 'bg-success-fg text-white',
              step.state === 'waiting' && 'bg-warning-bg text-warning-fg ring-2 ring-warning-fg/30',
              step.state === 'current' && 'bg-primary-600 text-on-primary',
              step.state === 'todo' && 'bg-surface-2 text-ink-subtle',
            )}
          >
            {step.state === 'done' ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" /> : step.state === 'waiting' ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} aria-hidden="true" /> : index + 1}
          </span>
          <span className={cn('text-sm font-medium', step.state === 'todo' ? 'text-ink-subtle' : 'text-ink')}>
            {step.label}
            <span className="sr-only"> — {step.state === 'done' ? 'done' : step.state === 'waiting' ? 'waiting' : step.state === 'current' ? 'current step' : 'to do'}</span>
          </span>
          {index < steps.length - 1 ? <span aria-hidden="true" className={cn('mx-3 hidden h-px flex-1 sm:block', step.state === 'done' ? 'bg-success-fg/50' : 'bg-border')} /> : null}
        </li>
      ))}
    </ol>
  )
}

/** Where the patient is, since when, under whom and who pays. */
function StaySummary({ admission, days }: { admission: Admission; days: number }) {
  const since = admission.admittedAt ?? admission.createdAt
  return (
    <section aria-label="Stay" className="rounded-xl border border-border-soft bg-surface-2 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <WardIcon ward={admission.wardLabel} className={cn('h-4 w-4', isCritical(admission.wardLabel) ? 'text-critical-fg' : 'text-primary-text')} />
        {admission.wardLabel} · {admission.bedNumber}
        <span className="font-normal text-ink-muted">· Day {days}</span>
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        <Fact label="IP no." value={admission.admissionNumber} />
        <Fact label="Admitted" value={`${formatDateKey(todayKey(new Date(since)))} · ${formatClock(since)}`} />
        <Fact label="Doctor" value={`${admission.doctorName} · ${admission.department}`} />
        <Fact label="Payer" value={payerOf(admission)} />
      </dl>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-16 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  )
}

function BillLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-4 py-2.5 text-sm', strong && 'font-semibold')}>
      <span className="text-ink">{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </div>
  )
}
