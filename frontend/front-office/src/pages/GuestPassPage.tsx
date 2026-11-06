import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { IdCard, Printer, ShieldCheck, Stethoscope, Users, Wrench } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Alert } from '../components/ui/Alert'
import { MobileInput } from '../components/ui/MobileInput'
import { PatientPickField } from '../components/patient/PatientPickField'
import { useStoreValue } from '../hooks/useStore'
import { useToast } from '../hooks/useToast'
import { useCurrentUser } from '../hooks/useCurrentUser'
import { getDepartments, getPatientById, getProviders } from '../domain/selectors'
import { getCurrentAdmissionForPatient } from '../domain/patientSelectors'
import { issueGuestPass } from '../domain/actions'
import { isValidMobile } from '../utils/phone'
import { mobileEarlyError, mobileError, nameError, nextNameInput } from '../utils/validation'
import { revealFirstInvalid } from '../utils/revealInvalid'
import { FieldError } from '../components/patient/AgeConfirm'
import { cn } from '../utils/cn'
import { GUEST_PASS_TYPES } from '../types/frontDesk'
import type { GuestPassType } from '../types/frontDesk'
import { errorClass, errorWithinClass, inputClass } from '../utils/formClasses'

const RELATIONSHIPS = ['Spouse', 'Son', 'Daughter', 'Parent', 'Sibling', 'Other relative', 'Friend']
const STAFF_ROLES = ['Staff without ID card', 'Trainee', 'Vendor', 'Contractor']
const SERVICE_AREAS = ['Administration', 'Pharmacy', 'Laboratory', 'Radiology', 'Biomedical engineering', 'Housekeeping', 'Maintenance']
const ID_TYPES = ['Aadhaar', 'Driving licence', 'Voter ID', 'PAN', 'Passport', 'Medical council ID', 'Company ID']

const TYPE_ICON: Record<GuestPassType, typeof Users> = {
  'Patient visitor': Users,
  'Visiting doctor': Stethoscope,
  'Staff / service': Wrench,
}


/**
 * Guest Pass — nobody moves about the hospital without a hospital ID or a
 * pass. A pass is printed only after the desk has seen the holder's ID and
 * confirmed the visit: with the patient or attendant for a visitor, with the
 * host doctor for a visiting doctor, with whoever authorised staff and
 * service people. Every pass is returned when its holder leaves.
 */
export function GuestPassPage() {
  const navigate = useNavigate()
  const { notify } = useToast()
  const user = useCurrentUser()
  const providers = useStoreValue(getProviders)
  const departments = useStoreValue(getDepartments)

  const [type, setType] = useState<GuestPassType>('Patient visitor')
  const [patientId, setPatientId] = useState('')
  const patient = useStoreValue(getPatientById, patientId)
  const stay = useStoreValue(getCurrentAdmissionForPatient, patientId)
  const [hostProviderId, setHostProviderId] = useState('')
  const [area, setArea] = useState('')
  const [relationship, setRelationship] = useState('')
  const [holderName, setHolderName] = useState('')
  const [holderMobile, setHolderMobile] = useState('')
  const [idType, setIdType] = useState('')
  const [idLast4, setIdLast4] = useState('')
  const [purpose, setPurpose] = useState('')
  const [verifiedWith, setVerifiedWith] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Print stays clickable: tried with something missing or wrong, it marks each such field.
  const [attempted, setAttempted] = useState(false)

  const host = providers.find((p) => p.providerId === hostProviderId) ?? null

  // Who confirms the visit, as the checkbox says it.
  const confirmer =
    type === 'Visiting doctor' ? (host?.name ?? 'the host doctor') : verifiedWith.trim() || (type === 'Patient visitor' ? 'the patient or attendant' : 'the authorising staff member')

  const ready =
    !nameError(holderName) &&
    isValidMobile(holderMobile) &&
    Boolean(idType) &&
    /^[A-Za-z0-9]{4}$/.test(idLast4) &&
    confirmed &&
    (type === 'Patient visitor'
      ? Boolean(patient && stay?.status === 'Admitted' && relationship && verifiedWith.trim())
      : type === 'Visiting doctor'
        ? Boolean(host && purpose.trim())
        : Boolean(area && relationship && purpose.trim() && verifiedWith.trim()))

  const visitor = type === 'Patient visitor'
  const doctorVisit = type === 'Visiting doctor'
  const problem = {
    patient: visitor && !(patient && stay?.status === 'Admitted') ? (patient ? 'This patient is not admitted — choose an admitted patient.' : 'Choose the admitted patient being visited.') : null,
    relationship: !doctorVisit && !relationship ? (visitor ? 'Choose the relationship to the patient.' : 'Choose the role.') : null,
    host: doctorVisit && !host ? 'Choose the hospital doctor they are visiting.' : null,
    area: !visitor && !doctorVisit && !area ? 'Choose the department or area.' : null,
    purpose: !visitor && !purpose.trim() ? 'Enter the purpose of the visit.' : null,
    name: holderName.trim() ? nameError(holderName) : type === 'Visiting doctor' ? 'Enter the visiting doctor’s name.' : 'Enter the pass holder’s name.',
    mobile: mobileError(holderMobile),
    id: !idType ? 'Choose the kind of ID seen.' : !/^[A-Za-z0-9]{4}$/.test(idLast4) ? 'Enter the last 4 characters of the ID.' : null,
    verifiedWith: !doctorVisit && !verifiedWith.trim() ? (visitor ? 'Enter who confirmed the visit.' : 'Enter who authorised the visit.') : null,
    confirmed: confirmed ? null : 'Tick to confirm you have seen the ID and confirmed the visit.',
  }
  const shown = (key: keyof typeof problem) => (attempted ? problem[key] : null)
  // A mobile starting 0–5 is wrong already, so it is flagged while still being typed.
  const mobileShown = shown('mobile') ?? mobileEarlyError(holderMobile)

  function reset(nextType: GuestPassType) {
    setType(nextType)
    setPatientId('')
    setHostProviderId('')
    setArea('')
    setRelationship('')
    setPurpose('')
    setVerifiedWith('')
    setConfirmed(false)
    setError(null)
    setAttempted(false)
  }

  function handlePrint(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!ready) {
      setAttempted(true)
      revealFirstInvalid()
      return
    }
    try {
      const pass = issueGuestPass({
        type,
        holderName,
        holderMobile,
        idType,
        idLast4,
        patientId: patient?.patientId,
        hostProviderId: hostProviderId || undefined,
        area: area || undefined,
        relationship,
        purpose,
        verifiedWith,
        confirmed,
        issuedBy: user.name,
      })
      notify('Guest pass printed', { detail: `${pass.passId} · ${pass.holderName}` })
      setHolderName('')
      setHolderMobile('')
      setIdType('')
      setIdLast4('')
      reset(type)
      navigate(`/services/guest-pass/print?pass=${encodeURIComponent(pass.passId)}`, { state: { autoPrint: true } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Could not print the pass', { tone: 'error', detail: message })
    }
  }

  return (
    <div>
      <PageHeader title="Guest Pass" />

      <div className="mt-5 sm:mt-6">
        <Card accentTone="brand" className="min-w-0 max-w-2xl">
          <CardHeader icon={IdCard} iconTone="brand" title="Print a pass" />
          <CardBody>
            <form onSubmit={handlePrint} className="flex flex-col gap-4" noValidate>
              {error ? <Alert tone="critical">{error}</Alert> : null}

              <div role="radiogroup" aria-label="Pass for" className="grid grid-cols-3 gap-1.5">
                {GUEST_PASS_TYPES.map((option) => {
                  const Icon = TYPE_ICON[option]
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={type === option}
                      onClick={() => reset(option)}
                      className={cn(
                        'focus-ring flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-2.5 text-center text-xs font-semibold break-words transition-colors',
                        type === option ? 'border-primary-600 bg-primary-50 text-primary-text' : 'border-border bg-surface-1 text-ink-muted hover:bg-surface-2',
                      )}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      {option}
                    </button>
                  )
                })}
              </div>

              {/* Who or what the visit is for */}
              {type === 'Patient visitor' ? (
                <>
                  <Field label="Visiting the inpatient" required error={shown('patient')}>
                    <PatientPickField
                      patient={patient}
                      onChange={(next) => {
                        setPatientId(next.patientId)
                        setError(null)
                      }}
                      scope="inpatients"
                      placeholder="Search for an admitted patient by name, mobile, UHID or ABHA"
                      detail={stay?.wardLabel ? `${stay.wardLabel} · ${stay.bedNumber}` : undefined}
                    />
                  </Field>
                  <Field label="Relationship to the patient" required error={shown('relationship')}>
                    <Chips options={RELATIONSHIPS} value={relationship} onChange={setRelationship} />
                  </Field>
                </>
              ) : type === 'Visiting doctor' ? (
                <>
                  <Field label="Hospital doctor they are visiting" required error={shown('host')}>
                    <select value={hostProviderId} onChange={(e) => setHostProviderId(e.target.value)} className={inputClass} aria-label="Hospital doctor they are visiting">
                      <option value="">Choose the hospital doctor</option>
                      {providers
                        .filter((p) => p.status === 'Active')
                        .map((p) => (
                          <option key={p.providerId} value={p.providerId}>
                            {p.name} · {p.department}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Purpose of the visit" required error={shown('purpose')}>
                    <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={80} placeholder="e.g. Joint review of a patient" className={inputClass} aria-label="Purpose of the visit" />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Department or area" required error={shown('area')}>
                    <select value={area} onChange={(e) => setArea(e.target.value)} className={inputClass} aria-label="Department or area">
                      <option value="">Choose where they need to go</option>
                      {[...departments, ...SERVICE_AREAS].map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Role" required error={shown('relationship')}>
                    <Chips options={STAFF_ROLES} value={relationship} onChange={setRelationship} />
                  </Field>
                  <Field label="Purpose of the visit" required error={shown('purpose')}>
                    <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={80} placeholder="e.g. Service the MRI chiller" className={inputClass} aria-label="Purpose of the visit" />
                  </Field>
                </>
              )}

              {/* The holder and their ID */}
              <Field label={type === 'Visiting doctor' ? 'Visiting doctor’s name' : 'Pass holder’s name'} required error={shown('name')}>
                <input value={holderName} onChange={(e) => setHolderName(nextNameInput(e.target.value))} maxLength={60} placeholder="As on their ID" className={inputClass} aria-label="Pass holder's name" />
              </Field>
              <Field label="Mobile" required error={mobileShown}>
                <MobileInput value={holderMobile} onValueChange={setHolderMobile} placeholder="10-digit mobile" className={inputClass} aria-label="Pass holder's mobile" />
              </Field>
              <Field label="ID proof seen" required error={shown('id')}>
                <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
                  <select value={idType} onChange={(e) => setIdType(e.target.value)} className={inputClass} aria-label="Kind of ID proof">
                    <option value="">Kind of ID</option>
                    {ID_TYPES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <input
                    value={idLast4}
                    onChange={(e) => setIdLast4(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4))}
                    placeholder="Last 4"
                    className={inputClass}
                    aria-label="Last four characters of the ID"
                  />
                </div>
              </Field>

              {/* Verification — nothing is printed unchecked */}
              <div className="flex flex-col gap-2 rounded-xl border border-warning-fg/25 bg-warning-bg/40 px-3.5 py-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                  <ShieldCheck className="h-4 w-4 text-warning-fg" strokeWidth={1.75} aria-hidden="true" />
                  Verification
                </p>
                {type === 'Visiting doctor' ? null : (
                  <input
                    aria-invalid={Boolean(shown('verifiedWith'))}
                    value={verifiedWith}
                    onChange={(e) => setVerifiedWith(e.target.value)}
                    maxLength={60}
                    placeholder={type === 'Patient visitor' ? 'Confirmed with — the patient or attendant’s name' : 'Authorised by — staff name and role'}
                    className={cn(inputClass, shown('verifiedWith') && errorClass)}
                    aria-label={type === 'Patient visitor' ? 'Confirmed with the patient or attendant' : 'Authorised by'}
                  />
                )}
                {type === 'Visiting doctor' ? null : <FieldError message={shown('verifiedWith')} />}
                <label className="flex items-start gap-2 text-xs text-ink">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} aria-invalid={Boolean(shown('confirmed'))} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-primary-600)]" />
                  <span>
                    I have seen the ID and confirmed this visit with <strong>{confirmer}</strong>
                    {type === 'Patient visitor' ? ' — they know about this visitor and agree to the visit.' : ' — they expect this person.'}
                  </span>
                </label>
                <FieldError message={shown('confirmed')} />
              </div>

              <Button type="submit">
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                Print pass
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function Field({ label, required, error = null, children }: { label: string; required?: boolean; error?: string | null; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-ink-muted">
        {label} {required ? <span className="text-critical-fg">*</span> : null}
      </p>
      {/* Marked: its controls take the error edge, and a submit's reveal lands here. */}
      <div data-invalid={error ? 'true' : undefined} className={cn(error && errorWithinClass)}>
        {children}
      </div>
      <FieldError message={error} />
    </div>
  )
}

function Chips({ options, value, onChange }: { options: string[]; value: string; onChange: (next: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'focus-ring min-h-11 rounded-full border px-3.5 text-sm font-medium transition-colors',
            value === option ? 'border-primary-600 bg-primary-600 text-on-primary' : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
          )}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
