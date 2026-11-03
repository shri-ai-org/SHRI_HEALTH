import { useEffect, useMemo, useRef, useState } from 'react'
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
import { FieldError } from '../components/patient/AgeConfirm'
import { useStoreValue } from '../hooks/useStore'
import { useToast } from '../hooks/useToast'
import { findPossibleDuplicatesFor, getPatientById } from '../domain/selectors'
import { getState } from '../domain/store'
import { ApiError, newIdempotencyKey, problemMessage } from '../../shri-health/client'
import { ageOn, loadCandidates, registerPatientOnServer } from '../../shri-health/patients'
import { initialsOf } from '../utils/format'
import { cn } from '../utils/cn'
import { nationalMobile } from '../utils/phone'
import { mobileEarlyError, mobileError, nameError, nextNameInput, sexError } from '../utils/validation'
import type { Patient, Sex } from '../types/patient'
import { errorClass, inputClass } from '../utils/formClasses'
import { revealFirstInvalid } from '../utils/revealInvalid'
import { ABHA_SCAN_EVENT } from '../utils/abhaQr'
import type { AbhaScan } from '../utils/abhaQr'

const SEXES: Sex[] = ['Male', 'Female', 'Other']
const MAX_AGE = 130
const REASON_LIMIT = 500

// Registration goes to the SHRI_HEALTH API (POST /patients). The contract asks for the first and
// last name and the date of birth (required, SHRI_HEALTH D44); the server issues the MRN (shown as
// the UHID) and runs the duplicate check. It has no field for an address in one line or for ABHA,
// so the form does not ask for them rather than drop what the desk types.

interface RegisterPatientLocationState {
  prefillName?: string
  /** An ABHA card scanned elsewhere — the form, filled from it. */
  abhaScan?: AbhaScan
  /** A patient just registered — shown as the acknowledgement. */
  registeredId?: string
}

/** "Anita Devi Sharma" → first "Anita", last "Devi Sharma": the desk checks the split. */
function splitName(full: string): { firstName: string; lastName: string } {
  const words = nextNameInput(full).trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { firstName: words[0] ?? '', lastName: '' }
  return { firstName: words[0]!, lastName: words.slice(1).join(' ') }
}

/** The form filled from a scanned ABHA card. The card gives an age, not a date of birth, so that stays for the desk. */
function fillFromScan(form: PatientFormState, scan: AbhaScan): PatientFormState {
  return {
    ...form,
    ...(scan.name ? splitName(scan.name) : {}),
    sex: scan.sex ?? form.sex,
    mobile: scan.mobile ?? form.mobile,
  }
}

/** What the desk typed into the search box before pressing Register Patient. */
function prefillFrom(search: string, state: RegisterPatientLocationState | null): { firstName: string; lastName: string; mobile: string } {
  const query = new URLSearchParams(search)
  return {
    ...splitName(query.get('name')?.trim() ?? state?.prefillName ?? ''),
    mobile: nationalMobile(query.get('mobile')).slice(0, 10),
  }
}

interface PatientFormState {
  firstName: string
  lastName: string
  /** `YYYY-MM-DD`, from the date input. */
  birthDate: string
  sex: Sex | ''
  mobile: string
}

type FieldKey = 'firstName' | 'lastName' | 'birthDate' | 'sex' | 'mobile'
const ALL_TOUCHED: Record<FieldKey, boolean> = { firstName: true, lastName: true, birthDate: true, sex: true, mobile: true }

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function birthDateError(value: string): string | null {
  if (!value) return 'Enter the date of birth.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return 'Enter a real date.'
  if (value > todayIso()) return "The date of birth can't be in the future."
  const age = ageOn(value)
  if (age !== null && age > MAX_AGE) return `That makes the patient older than ${MAX_AGE}.`
  return null
}

/** The server found a possible existing patient: who, and the reason if the desk registers anyway. */
interface ServerDuplicate {
  candidates: Patient[]
  reason: string
  reasonError: string | null
}

export function RegisterPatientPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { notify } = useToast()
  const [form, setForm] = useState<PatientFormState>(() => {
    const state = location.state as RegisterPatientLocationState | null
    const prefill = prefillFrom(location.search, state)
    const blank: PatientFormState = { ...prefill, birthDate: '', sex: '' }
    return state?.abhaScan ? fillFromScan(blank, state.abhaScan) : blank
  })

  // A field shows its message once it has been left (or a submit was tried) —
  // never while the desk is still typing its first character.
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [serverDuplicate, setServerDuplicate] = useState<ServerDuplicate | null>(null)
  // One Idempotency-Key per attempt: kept while the same request is retried, new once anything changes.
  const attemptKey = useRef<string | null>(null)
  const [registered, setRegistered] = useState<Patient | null>(() => {
    const id = (location.state as RegisterPatientLocationState | null)?.registeredId
    return id ? getPatientById(getState(), id) : null
  })

  // An ABHA card scanned on this page fills the form; Register Patient is still the desk's click.
  useEffect(() => {
    function onScan(event: Event) {
      const scan = (event as CustomEvent<AbhaScan>).detail
      setForm((current) => fillFromScan(current, scan))
      // Anything the card left wrong or empty (the date of birth, always) shows at once.
      setTouched(ALL_TOUCHED)
      setError(null)
      setServerDuplicate(null)
      attemptKey.current = null
    }
    window.addEventListener(ABHA_SCAN_EVENT, onScan)
    return () => window.removeEventListener(ABHA_SCAN_EVENT, onScan)
  }, [])

  const fullName = `${form.firstName} ${form.lastName}`.trim()
  const duplicateQuery = useMemo(() => ({ name: fullName, mobile: form.mobile, abhaId: '' }), [fullName, form.mobile])
  const localDuplicates = useStoreValue(findPossibleDuplicatesFor, duplicateQuery)
  const duplicates = serverDuplicate
    ? [...serverDuplicate.candidates, ...localDuplicates.filter((d) => !serverDuplicate.candidates.some((c) => c.patientId === d.patientId))]
    : localDuplicates

  const errors: Record<FieldKey, string | null> = {
    firstName: nameError(form.firstName),
    lastName: nameError(form.lastName),
    birthDate: birthDateError(form.birthDate),
    sex: sexError(form.sex),
    mobile: mobileError(form.mobile),
  }
  const invalid = (Object.keys(errors) as FieldKey[]).filter((key) => errors[key])
  const ready = invalid.length === 0
  // A mobile starting 0–5 is wrong already, so it is flagged while still being typed.
  const shown = (key: FieldKey) => (touched[key] ? errors[key] : key === 'mobile' ? mobileEarlyError(form.mobile) : null)
  const age = errors.birthDate ? null : ageOn(form.birthDate)

  function update<K extends keyof PatientFormState>(field: K, value: PatientFormState[K]) {
    setForm((current) => ({ ...current, [field]: value }))
    setError(null)
    // A changed form is a new request: a new key, and the server checks for duplicates again.
    attemptKey.current = null
    setServerDuplicate(null)
  }

  const touch = (key: FieldKey) => () => setTouched((current) => ({ ...current, [key]: true }))

  async function send(overrideReason?: string) {
    attemptKey.current ??= newIdempotencyKey()
    setBusy(true)
    setError(null)
    try {
      const patient = await registerPatientOnServer(
        {
          firstName: form.firstName,
          lastName: form.lastName,
          birthDate: form.birthDate,
          sex: form.sex as Sex,
          mobile: form.mobile,
          ...(overrideReason ? { overrideReason } : {}),
        },
        attemptKey.current,
      )
      attemptKey.current = null
      setRegistered(patient)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible-duplicate') {
        // The server keeps this answer under the key; registering anyway is a different request.
        attemptKey.current = null
        const ids = Array.isArray(err.problem.candidateIds) ? (err.problem.candidateIds as string[]) : []
        const candidates = await loadCandidates(ids).catch(() => [])
        setServerDuplicate({ candidates, reason: '', reasonError: null })
        return
      }
      const message = problemMessage(err)
      setError(message)
      notify('Registration failed', { tone: 'error', detail: message })
    } finally {
      setBusy(false)
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setTouched(ALL_TOUCHED)
    if (!ready) {
      // Register stays clickable: it marks every missing or wrong field and goes to the first.
      revealFirstInvalid()
      return
    }
    void send()
  }

  function registerAnyway() {
    if (!serverDuplicate) return
    const reason = serverDuplicate.reason.trim()
    if (!reason) return setServerDuplicate({ ...serverDuplicate, reasonError: 'Say why this is a different patient.' })
    if (reason.length > REASON_LIMIT) return setServerDuplicate({ ...serverDuplicate, reasonError: `Keep the reason to ${REASON_LIMIT} characters.` })
    void send(reason)
  }

  function openExistingPatient(patient: Patient) {
    navigate(`/patients/${patient.patientId}`, { replace: true })
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
            onDone={() => navigate(`/patients/${registered.patientId}`, { replace: true })}
          >
            <p className="text-base font-semibold text-ink">{registered.name}</p>
            <p className="text-2xl font-semibold tracking-wide tabular-nums text-primary-text">{registered.uhid}</p>
            <p>
              {registered.age} yrs · {registered.sex} · {registered.mobile}
            </p>
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="First name" required htmlFor="reg-first-name" error={shown('firstName')}>
                  <input
                    id="reg-first-name"
                    value={form.firstName}
                    onChange={(event) => update('firstName', nextNameInput(event.target.value))}
                    onBlur={touch('firstName')}
                    placeholder="As written on the patient's ID"
                    maxLength={60}
                    autoComplete="off"
                    aria-invalid={Boolean(shown('firstName'))}
                    className={cn(inputClass, shown('firstName') && errorClass)}
                  />
                </Field>
                <Field label="Last name" required htmlFor="reg-last-name" error={shown('lastName')}>
                  <input
                    id="reg-last-name"
                    value={form.lastName}
                    onChange={(event) => update('lastName', nextNameInput(event.target.value))}
                    onBlur={touch('lastName')}
                    placeholder="Family name or surname"
                    maxLength={60}
                    autoComplete="off"
                    aria-invalid={Boolean(shown('lastName'))}
                    className={cn(inputClass, shown('lastName') && errorClass)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-[12rem_minmax(0,1fr)]">
                <Field label="Date of birth" required htmlFor="reg-birth-date" error={shown('birthDate')} hint={age !== null ? `${age} yrs` : undefined}>
                  <input
                    id="reg-birth-date"
                    type="date"
                    value={form.birthDate}
                    max={todayIso()}
                    onChange={(event) => update('birthDate', event.target.value)}
                    onBlur={touch('birthDate')}
                    aria-invalid={Boolean(shown('birthDate'))}
                    className={cn(inputClass, shown('birthDate') && errorClass)}
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

              <div className="flex flex-col items-stretch gap-2 border-t border-border-soft pt-4 sm:flex-row sm:items-center sm:justify-end">
                <AbhaScanButton />
                <Button type="submit" disabled={busy || Boolean(serverDuplicate)}>
                  <UserPlus className="h-4 w-4" strokeWidth={1.75} />
                  {busy ? 'Registering…' : 'Register Patient'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          {duplicates.length > 0 || serverDuplicate ? (
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
                          {candidate.uhid} · {candidate.age ?? '—'} yrs · {candidate.sex} · {candidate.mobile || '—'}
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
                {serverDuplicate ? (
                  // The server's duplicate check: register anyway only with a reason, which is kept with the record.
                  <div className="flex flex-col gap-3 px-5 py-4">
                    <Field
                      label="Reason to register anyway"
                      htmlFor="reg-duplicate-reason"
                      error={serverDuplicate.reasonError}
                      hint="For example: twins, or a different person with the same name"
                    >
                      <input
                        id="reg-duplicate-reason"
                        value={serverDuplicate.reason}
                        onChange={(event) => setServerDuplicate({ ...serverDuplicate, reason: event.target.value, reasonError: null })}
                        maxLength={REASON_LIMIT}
                        autoComplete="off"
                        aria-invalid={Boolean(serverDuplicate.reasonError)}
                        className={cn(inputClass, serverDuplicate.reasonError && errorClass)}
                      />
                    </Field>
                    <div className="flex justify-end">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={registerAnyway}>
                        {busy ? 'Registering…' : 'Register anyway'}
                      </Button>
                    </div>
                  </div>
                ) : null}
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
