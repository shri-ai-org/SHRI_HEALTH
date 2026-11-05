import { useState } from 'react'
import type { CSSProperties } from 'react'
import { BedDouble, ClipboardList, ShieldCheck, Stethoscope } from 'lucide-react'
import { FlowSheet } from '../../components/flow/FlowSheet'
import { Quadrant, SummaryItem } from '../../components/flow/Quadrant'
import { useToast } from '../../hooks/useToast'
import { PatientSearch } from '../../components/patient/PatientSearch'
import { MobileInput } from '../../components/ui/MobileInput'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { WardIcon } from '../../components/ui/WardIcon'
import { useStoreValue } from '../../hooks/useStore'
import { getState } from '../../domain/store'
import { getDepartments, getPatientById, getProviders } from '../../domain/selectors'
import { getBedsForWard, getFirstFreeBed, getWardSummaries } from '../../domain/admissionSelectors'
import { getCurrentAdmissionForPatient } from '../../domain/patientSelectors'
import { admitPatient } from '../../domain/admissionActions'
import { DAILY_BED_CHARGE, admissionBillItems, formatRupees } from '../../utils/billing'
import { isValidMobile } from '../../utils/phone'
import { mobileEarlyError, mobileError } from '../../utils/validation'
import { revealFirstInvalid } from '../../utils/revealInvalid'
import { FieldError } from '../../components/patient/AgeConfirm'
import { cn } from '../../utils/cn'
import { ATTENDANT_RELATIONSHIPS, REFERRAL_SOURCES } from '../../types/admission'
import { departmentIcon, departmentTone } from '../../utils/departments'
import { TONE_HEX } from '../../utils/toneHex'
import type { AdmissionType, AttendantRelationship, PaymentType, ReferralSource, Ward } from '../../types/admission'
import type { Patient } from '../../types/patient'
import type { FlowProps } from '../registry'
import { errorClass, inputClass } from '../../utils/formClasses'


interface Details {
  doctorId: string
  admissionType: AdmissionType
  reason: string
  referralSource: ReferralSource
  attendantName: string
  attendantRelationship: AttendantRelationship
  attendantPhone: string
  paymentType: PaymentType
  insuranceProvider: string
  policyNumber: string
}

/** Details start from what the desk already knows: a request waiting for a
 *  bed, or the doctor the patient saw today. */
function startingDetails(patientId: string): Details {
  const state = getState()
  const waiting = getCurrentAdmissionForPatient(state, patientId)
  return {
    // A waiting request keeps its doctor; otherwise the desk picks one in Emergency, where Admit opens.
    doctorId: waiting?.doctorId ?? '',
    admissionType: waiting?.admissionType ?? 'Elective',
    reason: waiting?.reason ?? '',
    referralSource: waiting?.referralSource ?? 'Outpatient',
    attendantName: waiting?.attendant.name ?? '',
    attendantRelationship: waiting?.attendant.relationship ?? 'Spouse',
    attendantPhone: waiting?.attendant.phone.replace(/[^0-9]/g, '').slice(-10) ?? '',
    paymentType: waiting?.paymentType ?? 'Self Pay',
    insuranceProvider: waiting?.insuranceProvider ?? '',
    policyNumber: waiting?.policyNumber ?? '',
  }
}

/** The ward and bed Admit opens on: the page's own when it named one, else the first ward with a free bed. */
function startingBed(ward: Ward | undefined, bedId: string | undefined): { ward: Ward | null; bedId: string | null } {
  if (ward) return { ward, bedId: bedId ?? getFirstFreeBed(getState(), ward)?.bedId ?? null }
  for (const candidate of ['General Ward', 'Semi-Private Ward', 'Private Ward', 'ICU'] as Ward[]) {
    const free = getFirstFreeBed(getState(), candidate)
    if (free) return { ward: candidate, bedId: free.bedId }
  }
  return { ward: null, bedId: null }
}

/** Admit opens in Emergency — most admissions come through it. */
const ADMIT_DEPARTMENT = 'Emergency'

/** The department of a doctor, by id — where the department picker starts. */
function departmentOf(doctorId: string): string | null {
  return getState().providers.find((p) => p.providerId === doctorId)?.department ?? null
}

/** An attendant's mobile is optional — but a valid one when typed. */
function attendantPhoneOk(d: Details): boolean {
  return !d.attendantPhone.trim() || isValidMobile(d.attendantPhone)
}

/** The details card's own required field is the reason; the attendant is optional. */
function detailsFilled(d: Details): boolean {
  return d.reason.trim().length > 0 && attendantPhoneOk(d)
}

function detailsComplete(d: Details): boolean {
  return (
    Boolean(d.doctorId) &&
    d.reason.trim().length > 0 &&
    attendantPhoneOk(d) &&
    (d.paymentType === 'Self Pay' || d.paymentType === 'Corporate' || d.insuranceProvider.trim().length > 0)
  )
}

/**
 * Admit, over the page it was opened from, laid out like Schedule Appointment:
 * one full-screen page — patient top-left, ward & bed top-right, the admission
 * details bottom-left, the first-day bill bottom-right — each editable at any
 * time, with the confirmation along the bottom. A self-pay patient's bill
 * is printed for them to pay at the billing counter; then "Patient Admitted". The profile shows the
 * inpatient tag the moment it closes.
 */
export function AdmitFlow({ params, onClose }: FlowProps) {
  const [patientId, setPatientId] = useState(params.uhid ?? '')
  const patient = useStoreValue(getPatientById, patientId)
  const current = useStoreValue(getCurrentAdmissionForPatient, patientId)
  const alreadyAdmitted = current?.status === 'Admitted' ? current : null

  const wards = useStoreValue(getWardSummaries)
  const providers = useStoreValue(getProviders)
  // A ward and its first free bed are chosen from the start (General Ward first), so the bed and the
  // bill show at once; tapping another ward or bed changes it.
  const [start] = useState(() => startingBed(params.ward as Ward | undefined, params.bed))
  const [ward, setWard] = useState<Ward | null>(start.ward)
  const [bedId, setBedId] = useState<string | null>(start.bedId)
  const beds = useStoreValue(getBedsForWard, ward ?? 'General Ward')
  const bed = beds.find((b) => b.bedId === bedId) ?? null

  const [details, setDetails] = useState<Details>(() => startingDetails(params.uhid ?? ''))
  // Emergency first on Admit, then the usual order.
  const allDepartments = useStoreValue(getDepartments)
  const departments = [ADMIT_DEPARTMENT, ...allDepartments.filter((d) => d !== ADMIT_DEPARTMENT)]
  // The department narrows the doctors to choose from; it starts at the known doctor's.
  const [department, setDepartment] = useState<string | null>(() => departmentOf(details.doctorId) ?? ADMIT_DEPARTMENT)
  const { notify } = useToast()
  const [error, setError] = useState<string | null>(null)

  const doctor = providers.find((p) => p.providerId === details.doctorId) ?? null
  const selfPay = details.paymentType === 'Self Pay'
  const billItems = bed ? admissionBillItems(bed.roomType, 1) : []

  const wardDone = !alreadyAdmitted && Boolean(bed && bed.status === 'Available')
  const ready = Boolean(patient) && wardDone && detailsComplete(details)
  // Admit stays clickable: tried with something missing or wrong, it marks each such field.
  const [attempted, setAttempted] = useState(false)
  const problem = {
    doctor: details.doctorId ? null : department ? 'Choose the admitting doctor.' : 'Choose a department, then the admitting doctor.',
    reason: details.reason.trim() ? null : 'Enter the reason for admission.',
    attendantPhone: details.attendantPhone.trim() ? mobileError(details.attendantPhone) : null,
    bed: patient && !alreadyAdmitted && !wardDone ? 'Choose a ward and an available bed.' : null,
  }
  const shown = (key: keyof typeof problem) => (attempted ? problem[key] : null)
  // The one thing still to do, named in the bar at the bottom and lit on its section.
  const next = !patient
    ? 'choose the patient'
    : alreadyAdmitted
      ? null
      : !doctor
        ? 'choose the admitting doctor'
        : !wardDone
          ? 'choose a ward and an available bed'
          : !details.reason.trim()
            ? 'enter the reason for admission'
            : problem.attendantPhone
              ? 'check the attendant’s mobile number'
              : null
  // A mobile starting 0–5 is wrong already, so it is flagged while still being typed.
  const phoneShown = shown('attendantPhone') ?? mobileEarlyError(details.attendantPhone)

  function choosePatient(next: Patient) {
    setPatientId(next.patientId)
    const started = startingDetails(next.patientId)
    setDetails(started)
    setDepartment(departmentOf(started.doctorId) ?? ADMIT_DEPARTMENT)
  }

  function chooseDepartment(next: string) {
    if (next === department) return
    setDepartment(next)
    // A doctor from another department no longer fits.
    if (doctor && doctor.department !== next) update({ doctorId: '' })
  }

  function chooseWard(next: Ward) {
    setWard(next)
    setBedId(getFirstFreeBed(getState(), next)?.bedId ?? null)
    // An ICU admission is an emergency.
    if ((next === 'ICU' || next === 'Emergency') && details.admissionType === 'Elective') {
      setDetails((d) => ({ ...d, admissionType: 'Emergency' }))
    }
  }

  function update(patch: Partial<Details>) {
    setDetails((d) => ({ ...d, ...patch }))
  }

  function admit() {
    if (!patient || !bed || !ready) {
      setAttempted(true)
      revealFirstInvalid()
      return
    }
    setError(null)
    try {
      const result = admitPatient({
        patientId: patient.patientId,
        doctorId: details.doctorId,
        admissionType: details.admissionType,
        reason: details.reason,
        referralSource: details.referralSource,
        bedId: bed.bedId,
        attendant: {
          name: details.attendantName.trim(),
          relationship: details.attendantRelationship,
          phone: details.attendantPhone,
          address: null,
        },
        paymentType: details.paymentType,
        insuranceProvider: details.insuranceProvider,
        policyNumber: details.policyNumber,
      })
      // Admitted: straight back to the patient's profile. The first-day bill is
      // printed from its Payment History for the patient to pay at the billing counter.
      notify('Patient admitted', { detail: `${result.admission.admissionNumber} · ${result.admission.wardLabel} · ${result.admission.bedNumber}` })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const subtitle = patient
    ? `${patient.name} · ${patient.uhid}${patient.age ? ` · ${patient.age} ${patient.sex.charAt(0)}` : ''}`
    : 'Choose the patient'


  const billTotal = billItems.reduce((sum, item) => sum + item.amount, 0)

  const confirmBar = (
    <div className="flex flex-col gap-4 py-2">
      {error ? <Alert tone="critical">{error}</Alert> : null}
      <div className="grid grid-cols-1 items-center gap-4 xl:grid-cols-[minmax(0,1fr)_auto]">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-base sm:grid-cols-3">
          <SummaryItem label="Ward & bed" value={bed && wardDone ? `${bed.ward} · ${bed.bedNumber}` : null} />
          <SummaryItem label="Doctor" value={doctor ? doctor.name : null} />
          <SummaryItem label="Payer" value={selfPay ? 'Self pay' : details.insuranceProvider || details.paymentType} />
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-3 xl:justify-end">
          <div className="text-right">
            <p className="text-sm text-ink-muted">First-day bill</p>
            <p className="text-2xl font-bold tabular-nums text-ink">{billItems.length ? formatRupees(billTotal) : '—'}</p>
            {billItems.length ? (
              <p className="text-xs text-ink-muted">{billItems.map((item) => `${item.description} ${formatRupees(item.amount)}`).join(' · ')}</p>
            ) : null}
          </div>
          <Button size="lg" onClick={admit}>
            {selfPay ? <BedDouble className="h-4 w-4" strokeWidth={1.75} /> : <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}
            {selfPay ? 'Admit' : `Admit — bill ${details.insuranceProvider || details.paymentType}`}
          </Button>
        </div>
      </div>
      {!ready && (alreadyAdmitted || next) ? (
        <p className="text-sm text-ink-muted">
          {alreadyAdmitted ? `${patient?.name ?? 'The patient'} is already admitted.` : next ? <span className="font-semibold text-ink">{next.charAt(0).toUpperCase() + next.slice(1)}</span> : null}
        </p>
      ) : null}
    </div>
  )

  return (
    <FlowSheet title="Admit" subtitle={subtitle} icon={BedDouble} iconTone="info" onClose={onClose} size="full" footer={confirmBar}>
      <div className="flex flex-col gap-4">
        {/* The patient is known — Admit opens from their profile or a patient list.
            Only a flow opened with no patient asks for one. */}
        {!patient ? (
          <Quadrant step={1} title="Patient" done={false} allowOverflow>
            <PatientSearch mode="pick" onPick={choosePatient} autoFocus placeholder="Search for the patient by name, mobile, UHID or ABHA" />
          </Quadrant>
        ) : alreadyAdmitted ? (
          <Alert tone="warning">
            <strong>{patient.name} is already admitted</strong> — {alreadyAdmitted.wardLabel} · {alreadyAdmitted.bedNumber} ({alreadyAdmitted.admissionNumber}).
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-stretch">
          {/* Left: who admits the patient. Right: where they go, then the admission's details. */}
            <Quadrant
              step={patient ? 1 : 2}
              numbered
              current={next === 'choose the admitting doctor'}
              title="Department & doctor"
              className="lg:row-span-2"
              icon={Stethoscope}
              hue="violet"
              done={Boolean(doctor)}
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Department">
                  {departments.map((dep) => {
                    const Icon = departmentIcon(dep)
                    const tone = TONE_HEX[departmentTone(dep)]
                    const chosen = dep === department
                    return (
                      <button
                        key={dep}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => chooseDepartment(dep)}
                        style={{ '--tone': tone } as CSSProperties}
                        className={cn(
                          'focus-ring inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm font-semibold transition-colors',
                          chosen
                            ? 'border-[var(--tone)] bg-[color-mix(in_oklab,var(--tone)_14%,var(--color-surface-1))] text-ink shadow-card-sm'
                            : 'border-border-soft bg-surface-1 text-ink hover:border-[color-mix(in_oklab,var(--tone)_45%,var(--color-border))]',
                        )}
                      >
                        <Icon size={15} strokeWidth={2} aria-hidden="true" className="text-[var(--tone)]" />
                        {dep}
                      </button>
                    )
                  })}
                </div>
                {department ? (
                  <div>
                    <p className="mb-2 text-xs font-medium text-ink-muted">
                      Admitting doctor <RequiredStar />
                    </p>
                    <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label="Admitting doctor">
                      {providers
                        .filter((p) => p.status === 'Active' && p.department === department)
                        .map((p) => {
                          const chosen = p.providerId === details.doctorId
                          return (
                            <button
                              key={p.providerId}
                              type="button"
                              role="radio"
                              aria-checked={chosen}
                              onClick={() => update({ doctorId: p.providerId })}
                              className={cn(
                                'focus-ring flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                                chosen ? 'border-primary-600 bg-primary-50 shadow-card-sm' : 'border-border-soft bg-surface-1 hover:bg-surface-2',
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-semibold text-ink">{p.name}</span>
                                <span className="block truncate text-xs text-ink-muted">{p.specialty}</span>
                              </span>
                              {p.room ? <span className="shrink-0 text-xs text-ink-muted">{p.room}</span> : null}
                            </button>
                          )
                        })}
                    </div>
                  </div>
                ) : null}
                {shown('doctor') ? (
                  <p data-invalid="true" tabIndex={-1} role="alert" className="text-xs font-medium text-critical-fg outline-none">
                    {shown('doctor')}
                  </p>
                ) : null}
              </div>
            </Quadrant>


            <Quadrant step={patient ? 2 : 3} numbered current={next === 'choose a ward and an available bed'} className="lg:col-start-2" title="Ward & bed" icon={BedDouble} hue="teal" done={wardDone}>
              {!patient || alreadyAdmitted ? null : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {wards
                      .filter((w) => w.ward !== 'Emergency')
                      .map((w) => {
                        const roomType = w.beds[0]?.roomType ?? 'General'
                        const full = w.available === 0
                        return (
                          <button
                            key={w.ward}
                            type="button"
                            disabled={full}
                            aria-pressed={w.ward === ward}
                            onClick={() => chooseWard(w.ward)}
                            className={cn(
                              'focus-ring flex flex-col items-start gap-1 rounded-xl border px-3 py-3 text-left transition-all',
                              w.ward === ward ? 'border-primary-600 bg-primary-50 shadow-card-sm' : 'border-border-soft bg-surface-1 hover:bg-surface-2',
                              full && 'cursor-not-allowed opacity-50',
                            )}
                          >
                            <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                              <WardIcon ward={w.ward} className={cn('h-4.5 w-4.5', w.ward === 'ICU' ? 'text-critical-fg' : 'text-primary-text')} />
                              {w.ward}
                            </span>
                            {/* Only a full ward says so; otherwise the beds below show what is free. */}
                            {full ? <span className="text-xs font-semibold text-critical-fg">Full</span> : null}
                            <span className="text-xs text-ink-muted">{formatRupees(DAILY_BED_CHARGE[roomType])}/day</span>
                          </button>
                        )
                      })}
                  </div>
                  {ward ? (
                    <div className="mt-3">
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Bed">
                        {beds.map((b) => {
                          const free = b.status === 'Available'
                          return (
                            <button
                              key={b.bedId}
                              type="button"
                              disabled={!free}
                              aria-pressed={b.bedId === bedId}
                              onClick={() => setBedId(b.bedId)}
                              title={`${b.bedNumber} · ${free ? 'Available' : 'Occupied'}`}
                              aria-label={`${b.bedNumber}, ${free ? 'available' : 'occupied'}`}
                              className={cn(
                                'rounded-lg border px-2.5 py-1.5 text-xs font-semibold tabular-nums transition-colors',
                                b.bedId === bedId
                                  ? 'border-primary-600 bg-primary-600 text-on-primary shadow-card-sm'
                                  : free
                                    ? 'border-success-fg/50 bg-success-bg text-success-fg hover:border-primary-600 hover:text-primary-text'
                                    : 'cursor-not-allowed border-border bg-surface-2 text-ink-subtle line-through',
                              )}
                            >
                              {b.bedNumber}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
                  {shown('bed') ? (
                    <p data-invalid="true" tabIndex={-1} role="alert" className="mt-3 text-xs font-medium text-critical-fg outline-none">
                      {shown('bed')}
                    </p>
                  ) : null}
                </>
              )}
            </Quadrant>


            <Quadrant
              step={patient ? 3 : 4}
              numbered
              current={next === 'enter the reason for admission' || next === 'check the attendant’s mobile number'}
              title="Details"
              className="lg:col-start-2"
              icon={ClipboardList}
              hue="blue"
              done={detailsFilled(details)}
            >
              {/* Two short rows, each field sized to what it holds — the reason gets the room. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-6 sm:items-start">
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted sm:col-span-2">
                  Referred from
                  <select value={details.referralSource} onChange={(e) => update({ referralSource: e.target.value as ReferralSource })} className={inputClass}>
                    {/* Walk-in is not a choice here; an older request that has it keeps it. */}
                    {REFERRAL_SOURCES.filter((option) => option !== 'Walk-in' || details.referralSource === 'Walk-in').map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted sm:col-span-4">
                  <span>
                    Reason for admission <RequiredStar />
                  </span>
                  <input
                    value={details.reason}
                    onChange={(e) => update({ reason: e.target.value })}
                    placeholder="e.g. Fever with low platelets — observation"
                    aria-required="true"
                    aria-invalid={Boolean(shown('reason'))}
                    className={cn(inputClass, 'text-ink', shown('reason') && errorClass)}
                  />
                  <FieldError message={shown('reason')} />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted sm:col-span-2">
                  Attendant name
                  <input
                    value={details.attendantName}
                    onChange={(e) => update({ attendantName: e.target.value })}
                    placeholder="Optional"
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted sm:col-span-2">
                  Relationship
                  <select
                    value={details.attendantRelationship}
                    onChange={(e) => update({ attendantRelationship: e.target.value as AttendantRelationship })}
                    className={inputClass}
                  >
                    {ATTENDANT_RELATIONSHIPS.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted sm:col-span-2">
                  Attendant mobile
                  <MobileInput
                    value={details.attendantPhone}
                    onValueChange={(value) => update({ attendantPhone: value })}
                    placeholder="Optional"
                    aria-invalid={Boolean(phoneShown)}
                    className={cn(inputClass, phoneShown && errorClass)}
                  />
                  <FieldError message={phoneShown} />
                </label>
              </div>
            </Quadrant>
        </div>
      </div>
    </FlowSheet>
  )
}

/** The red star that marks a field the admission cannot go ahead without. */
function RequiredStar() {
  return (
    <span aria-hidden="true" className="font-semibold text-critical-fg">
      *
    </span>
  )
}

