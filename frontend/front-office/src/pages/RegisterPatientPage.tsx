import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { UserPlus, UserRoundCheck } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { AbhaScanButton } from '../components/patient/AbhaScanButton'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Alert } from '../components/ui/Alert'
import { MobileInput } from '../components/ui/MobileInput'
import { Avatar } from '../components/ui/Avatar'
import { AckCard } from '../components/flow/AckCard'
import { AgeConfirm, FieldError } from '../components/patient/AgeConfirm'
import { CreateAbhaLink } from '../components/patient/CreateAbhaLink'
import { useStoreValue } from '../hooks/useStore'
import { useToast } from '../hooks/useToast'
import { findAbhaHolder, findPossibleDuplicatesFor, getConnectivity, getPatientById } from '../domain/selectors'
import { getState } from '../domain/store'
import { registerPatient } from '../domain/actions'
import { initialsOf } from '../utils/format'
import { cn } from '../utils/cn'
import { nationalMobile } from '../utils/phone'
import { abhaError, addressError, ageError, ageNeedsConfirmation, mobileEarlyError, mobileError, nameError, nextAgeInput, nextNameInput, sexError } from '../utils/validation'
import type { Patient, Sex } from '../types/patient'
import { errorClass, inputClass } from '../utils/formClasses'
import { revealFirstInvalid } from '../utils/revealInvalid'
import { ABHA_REGISTERED_EVENT, ABHA_SCAN_EVENT } from '../utils/abhaQr'
import type { AbhaScan } from '../utils/abhaQr'

const SEXES: Sex[] = ['Male', 'Female', 'Other']

interface RegisterPatientLocationState {
  prefillName?: string
  /** An ABHA card scanned elsewhere that could not register on its own — the form, filled from it. */
  abhaScan?: AbhaScan
  /** A patient just registered from a scanned ABHA card — shown as the acknowledgement. */
  registeredId?: string
}

/** The form filled from a scanned ABHA card — the fields the card does not carry stay as they were. */
function fillFromScan(form: PatientFormState, scan: AbhaScan): PatientFormState {
  return {
    ...form,
    name: scan.name ? nextNameInput(scan.name).trim() : form.name,
    age: scan.age != null ? String(scan.age) : form.age,
    sex: scan.sex ?? form.sex,
    mobile: scan.mobile ?? form.mobile,
    abhaId: scan.abhaAddress ?? scan.abhaNumber ?? form.abhaId,
    address: scan.address ? scan.address.slice(0, 200) : form.address,
    ageConfirmed: scan.age != null ? false : form.ageConfirmed,
  }
}

/** What the desk typed into the search box before pressing Register Patient. */
function prefillFrom(search: string, state: RegisterPatientLocationState | null): { name: string; mobile: string } {
  const query = new URLSearchParams(search)
  return {
    name: nextNameInput(query.get('name')?.trim() ?? state?.prefillName ?? '').trim(),
    mobile: nationalMobile(query.get('mobile')).slice(0, 10),
  }
}

interface PatientFormState {
  name: string
  age: string
  sex: Sex | ''
  mobile: string
  abhaId: string
  address: string
  ageConfirmed: boolean
}

type FieldKey = 'name' | 'age' | 'sex' | 'mobile' | 'abhaId' | 'address'


export function RegisterPatientPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { notify } = useToast()
  const connectivity = useStoreValue(getConnectivity)
  const [form, setForm] = useState<PatientFormState>(() => {
    const state = location.state as RegisterPatientLocationState | null
    const prefill = prefillFrom(location.search, state)
    const blank: PatientFormState = { name: prefill.name, age: '', sex: '', mobile: prefill.mobile, abhaId: '', address: '', ageConfirmed: false }
    return state?.abhaScan ? fillFromScan(blank, state.abhaScan) : blank
  })

  // A field shows its message once it has been left (or a submit was tried) —
  // never while the desk is still typing its first character.
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [error, setError] = useState<string | null>(null)
  const [registered, setRegistered] = useState<Patient | null>(() => {
    const id = (location.state as RegisterPatientLocationState | null)?.registeredId
    return id ? getPatientById(getState(), id) : null
  })

  // An ABHA card scanned on this page fills the form; Register Patient is still the desk's click.
  useEffect(() => {
    function onScan(event: Event) {
      const scan = (event as CustomEvent<AbhaScan>).detail
      setForm((current) => fillFromScan(current, scan))
      // Anything the card left wrong or empty shows at once.
      setTouched({ name: true, age: true, sex: true, mobile: true, abhaId: true, address: true })
      setError(null)
    }
    // A card scanned here registered its holder: the acknowledgement, then the profile.
    function onRegistered(event: Event) {
      setRegistered((event as CustomEvent<Patient>).detail)
    }
    window.addEventListener(ABHA_SCAN_EVENT, onScan)
    window.addEventListener(ABHA_REGISTERED_EVENT, onRegistered)
    return () => {
      window.removeEventListener(ABHA_SCAN_EVENT, onScan)
      window.removeEventListener(ABHA_REGISTERED_EVENT, onRegistered)
    }
  }, [])

  const duplicateQuery = useMemo(() => ({ name: form.name, mobile: form.mobile, abhaId: form.abhaId }), [form.name, form.mobile, form.abhaId])
  const duplicates = useStoreValue(findPossibleDuplicatesFor, duplicateQuery)
  const abhaHolder = useStoreValue(findAbhaHolder, form.abhaId)

  const errors: Record<FieldKey, string | null> = {
    name: nameError(form.name),
    age: ageError(form.age),
    sex: sexError(form.sex),
    mobile: mobileError(form.mobile),
    abhaId: abhaError(form.abhaId) ?? (abhaHolder ? `Already linked to ${abhaHolder.name} (${abhaHolder.uhid}).` : null),
    address: addressError(form.address),
  }
  const needsAgeConfirm = ageNeedsConfirmation(form.age)
  const invalid = (Object.keys(errors) as FieldKey[]).filter((key) => errors[key])
  const ready = invalid.length === 0 && (!needsAgeConfirm || form.ageConfirmed)
  // A mobile starting 0–5 is wrong already, so it is flagged while still being typed.
  const shown = (key: FieldKey) => (touched[key] ? errors[key] : key === 'mobile' ? mobileEarlyError(form.mobile) : null)
  // A typed ABHA already on another record is flagged at once, not on blur.
  const abhaShown = form.abhaId.trim() ? (shown('abhaId') ?? (abhaHolder ? errors.abhaId : null)) : null

  function update<K extends keyof PatientFormState>(field: K, value: PatientFormState[K]) {
    setForm((current) => ({
      ...current,
      [field]: value,
      // A new age needs confirming again.
      ...(field === 'age' ? { ageConfirmed: false } : {}),
    }))
    setError(null)
  }

  const touch = (key: FieldKey) => () => setTouched((current) => ({ ...current, [key]: true }))

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setTouched({ name: true, age: true, sex: true, mobile: true, abhaId: true, address: true })
    if (!ready) {
      // Register stays clickable: it marks every missing or wrong field and goes to the first.
      revealFirstInvalid()
      return
    }
    try {
      // Registering is free — it only creates the record and its UHID.
      setRegistered(registerPatient(form))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Registration failed', { tone: 'error', detail: message })
    }
  }

  function openExistingPatient(patient: Patient) {
    navigate(`/patients/${patient.uhid}`, { replace: true })
  }

  if (registered) {
    // A plain acknowledgement, then the new patient's profile. `replace`
    // drops the filled-in form from history, so Back never lands on it again.
    return (
      <div className="flex min-h-[60dvh] items-center justify-center py-6">
        <Card accentTone="teal" className="w-full max-w-md">
          <AckCard
            title="Registering Patient"
            icon={UserRoundCheck}
            durationMs={7000}
            onDone={() => navigate(`/patients/${registered.uhid}`, { replace: true })}
          >
            <p className="text-base font-semibold text-ink">{registered.name}</p>
            <p className="text-2xl font-semibold tracking-wide tabular-nums text-primary-text">{registered.uhid}</p>
            <p>
              {registered.age} yrs · {registered.sex} · {registered.mobile}
            </p>
            {registered.abhaId ? <p>ABHA {registered.abhaId}</p> : null}
          </AckCard>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Register Patient" />

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,640px)_minmax(0,1fr)] mt-4 sm:mt-5">
        <Card accentTone="teal" className="min-w-0">
          <CardHeader icon={UserPlus} iconTone="teal" title="Patient details" />
          <CardBody>
            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
              {error ? <Alert tone="critical">{error}</Alert> : null}

              <Field label="Full name" required htmlFor="reg-name" error={shown('name')}>
                <input
                  id="reg-name"
                  value={form.name}
                  onChange={(event) => update('name', nextNameInput(event.target.value))}
                  onBlur={touch('name')}
                  placeholder="As written on the patient's ID"
                  maxLength={60}
                  autoComplete="off"
                  aria-invalid={Boolean(shown('name'))}
                  className={cn(inputClass, shown('name') && errorClass)}
                />
              </Field>

              <div className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-[6rem_minmax(0,1fr)]">
                <Field label="Age" required htmlFor="reg-age" error={shown('age')}>
                  <input
                    id="reg-age"
                    value={form.age}
                    onChange={(event) => update('age', nextAgeInput(event.target.value, form.age))}
                    onBlur={touch('age')}
                    inputMode="numeric"
                    maxLength={3}
                    aria-invalid={Boolean(shown('age')) || (needsAgeConfirm && !form.ageConfirmed)}
                    className={cn(inputClass, (shown('age') || needsAgeConfirm) && errorClass, needsAgeConfirm && 'font-semibold text-critical-fg')}
                  />
                </Field>
                <Field label="Sex" required error={shown('sex')}>
                  <div className="flex gap-1.5" role="radiogroup" aria-label="Sex">
                    {SEXES.map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={form.sex === option}
                        aria-invalid={option === SEXES[0] && Boolean(shown('sex'))}
                        onClick={() => {
                          update('sex', option)
                          touch('sex')()
                        }}
                        className={cn(
                          'focus-ring min-h-11 flex-1 rounded-lg border px-2 py-2 text-sm font-medium transition-colors',
                          form.sex === option
                            ? 'border-primary-600 bg-primary-600 text-on-primary'
                            : shown('sex')
                              ? 'border-critical-fg bg-surface-1 text-ink hover:bg-surface-2'
                              : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              {needsAgeConfirm ? (
                <AgeConfirm age={form.age} confirmed={form.ageConfirmed} onConfirm={(next) => setForm((current) => ({ ...current, ageConfirmed: next }))} />
              ) : null}

              <Field label="Mobile number" required htmlFor="reg-mobile" error={shown('mobile')}>
                <MobileInput
                  id="reg-mobile"
                  value={form.mobile}
                  onValueChange={(value) => update('mobile', value)}
                  onBlur={touch('mobile')}
                  placeholder="10-digit mobile number"
                  aria-invalid={Boolean(shown('mobile'))}
                  className={cn(inputClass, shown('mobile') && errorClass)}
                />
              </Field>

              <Field label="Address" htmlFor="reg-address" error={shown('address')}>
                <input
                  id="reg-address"
                  value={form.address}
                  onChange={(event) => update('address', event.target.value)}
                  onBlur={touch('address')}
                  placeholder="Optional"
                  maxLength={200}
                  autoComplete="off"
                  aria-invalid={Boolean(shown('address'))}
                  className={cn(inputClass, shown('address') && errorClass)}
                />
              </Field>

              <Field
                label="ABHA address or number"
                htmlFor="reg-abha"
                error={abhaShown}
                hint={connectivity.abha === 'unavailable' ? 'ABHA lookup is unavailable' : undefined}
              >
                {/* Kept short, so the Create ABHA popup has room to open on its right. */}
                <div className="flex max-w-md gap-2">
                  <input
                    id="reg-abha"
                    value={form.abhaId}
                    onChange={(event) => update('abhaId', event.target.value)}
                    onBlur={touch('abhaId')}
                    placeholder="name@abdm or 14-digit number"
                    autoComplete="off"
                    aria-invalid={Boolean(abhaShown)}
                    aria-describedby={abhaShown ? 'reg-abha-error' : connectivity.abha === 'unavailable' ? 'reg-abha-hint' : undefined}
                    className={cn(inputClass, abhaShown && errorClass)}
                  />
                  {/* No ABHA yet? The patient can create one with ABDM. */}
                  {form.abhaId.trim() ? null : <CreateAbhaLink />}
                </div>
              </Field>

              <div className="flex flex-col items-stretch gap-2 border-t border-border-soft pt-4 sm:flex-row sm:items-center sm:justify-end">
                <AbhaScanButton />
                <Button type="submit">
                  <UserPlus className="h-4 w-4" strokeWidth={1.75} />
                  Register Patient
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          {duplicates.length > 0 ? (
            <Card accentTone="warning" className="border-warning-fg/25 bg-warning-bg/40">
              <CardHeader title="Possible existing patient found" />
              <div className="divide-y divide-border-soft">
                {duplicates.map((candidate) => (
                  <div key={candidate.patientId} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={candidate.name} initials={initialsOf(candidate.name)} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{candidate.name}</p>
                        <p className="truncate text-xs text-ink-muted">
                          {candidate.uhid} · {candidate.age ?? '—'} yrs · {candidate.sex} · {candidate.mobile}
                          {candidate.abhaId ? ` · ABHA ${candidate.abhaId}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => openExistingPatient(candidate)}>
                        Use this patient
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}


function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string
  required?: boolean
  hint?: ReactNode
  error?: string | null
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-muted">
        {label} {required ? <span className="text-critical-fg">*</span> : null}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <FieldError id={htmlFor ? `${htmlFor}-error` : undefined} message={error} />
      ) : hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="mt-1 text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
