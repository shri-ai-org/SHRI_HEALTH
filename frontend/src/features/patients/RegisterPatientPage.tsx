import { UserPlus } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, newIdempotencyKey } from '../../api/client'
import { registerPatient } from '../../api/generated/endpoints/patients/patients'
import type { AdministrativeGender, BirthSex, ContactUse, PatientCreate } from '../../api/generated/model'
import {
  Alert,
  Button,
  DateInput,
  Field,
  fieldKey,
  isOverLimit,
  isValidZip,
  normalizeZip,
  PhoneInput,
  ProblemAlert,
  Select,
  StateSelect,
  Textarea,
  TextInput,
  useToast,
  type Problem,
} from '../../design-system'
import { BIRTH_SEX_OPTIONS, GENDER_IDENTITY_OPTIONS } from './demographics'
import { useRegisterPrefill } from './registerPrefill'

const REASON_LIMIT = 500

interface Form {
  given: string
  family: string
  preferredName: string
  birthDate: string | null
  gender: AdministrativeGender | ''
  birthSex: BirthSex | ''
  /** Key into GENDER_IDENTITY_OPTIONS, or '' when not given. */
  genderIdentity: string
  phone: string | null
  /** SMS reminders need a mobile number, so mobile is the default. */
  phoneUse: Extract<ContactUse, 'mobile' | 'home' | 'work'>
  email: string
  line1: string
  city: string
  state: string
  zip: string
}

/** Labels by JSON pointer, so a 422 field error names the field the user sees. */
const FIELD_LABELS: Record<string, string> = {
  '/name/given': 'First name',
  '/name/given/0': 'First name',
  '/name/family': 'Last name',
  '/preferredName': 'Preferred name',
  '/birthDate': 'Date of birth',
  '/gender': 'Legal sex',
  '/birthSex': 'Sex assigned at birth',
  '/genderIdentity': 'Gender identity',
  '/phones/0/number': 'Phone',
  '/phones/0/use': 'Phone type',
  '/emails/0/address': 'Email',
  '/address/lines/0': 'Street address',
  '/address/city': 'City',
  '/address/state': 'State',
  '/address/postalCode': 'ZIP code',
}

type Errors = Partial<Record<keyof Form, string>>

export function validate(form: Form): Errors {
  const errors: Errors = {}
  if (!form.given.trim()) errors.given = 'Enter the first name.'
  if (!form.family.trim()) errors.family = 'Enter the last name.'
  if (form.birthDate === null || form.birthDate === '') errors.birthDate = 'Enter the date of birth as MM/DD/YYYY.'
  if (form.phone === null) errors.phone = 'Enter a 10-digit U.S. phone number.'
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = 'Enter an email address like name@example.com.'
  const anyAddress = [form.line1, form.city, form.state, form.zip].some((v) => v.trim())
  if (anyAddress) {
    if (!form.line1.trim()) errors.line1 = 'Enter the street address.'
    if (!form.city.trim()) errors.city = 'Enter the city.'
    if (!form.state) errors.state = 'Choose the state.'
    if (!isValidZip(form.zip)) errors.zip = 'Enter a 5-digit ZIP code, or ZIP+4.'
  }
  return errors
}

function toBody(form: Form): PatientCreate {
  const body: PatientCreate = {
    name: { given: [form.given.trim()], family: form.family.trim() },
    birthDate: form.birthDate ?? '',
  }
  if (form.preferredName.trim()) body.preferredName = form.preferredName.trim()
  if (form.gender) body.gender = form.gender
  if (form.birthSex) body.birthSex = form.birthSex
  const identity = GENDER_IDENTITY_OPTIONS.find((o) => o.key === form.genderIdentity)
  if (identity) body.genderIdentity = identity.value
  if (form.phone) body.phones = [{ number: form.phone, use: form.phoneUse }]
  if (form.email.trim()) body.emails = [{ address: form.email.trim(), use: 'home' }]
  if (form.line1.trim()) {
    body.address = { lines: [form.line1.trim()], city: form.city.trim(), state: form.state, postalCode: normalizeZip(form.zip), country: 'US' }
  }
  return body
}

/**
 * Registers a patient (inventory #29). Only name and date of birth are required (D44). The front
 * desk sees only the possible-duplicate warning (Vimal's Stage 3 list): it can search again, or register anyway with
 * a reason, which is recorded in the audit trail. Duplicate review itself is in the admin portal.
 */
export function RegisterPatientPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const handoff = useRegisterPrefill()
  const [form, setForm] = useState<Form>(() => {
    const prefill = handoff.peek()
    return {
      given: prefill.given ?? '',
      family: prefill.family ?? '',
      preferredName: '',
      birthDate: prefill.birthDate ?? '',
      gender: '',
      birthSex: '',
      genderIdentity: '',
      phone: '',
      phoneUse: 'mobile',
      email: '',
      line1: '',
      city: '',
      state: '',
      zip: '',
    }
  })
  // Used once: a later visit to this page starts empty.
  useEffect(() => handoff.clear(), [handoff])
  const [errors, setErrors] = useState<Errors>({})
  const [problem, setProblem] = useState<Problem | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // One key per user action: kept while the same form is retried, replaced when anything changes.
  const idempotencyKey = useRef<string | null>(null)

  function update(changes: Partial<Form>) {
    setForm((f) => ({ ...f, ...changes }))
    idempotencyKey.current = null
    setDuplicate(false)
  }

  async function send(override: boolean) {
    const body = toBody(form)
    if (override) {
      body.duplicateCheck = 'override'
      body.duplicateOverrideReason = reason.trim()
    }
    idempotencyKey.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await registerPatient(body, { 'Idempotency-Key': idempotencyKey.current })
      if (res.status === 201) {
        toast.show(`Patient registered. MRN ${res.data.mrn}`)
        void navigate(`/patients/${res.data.id}`)
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      if (error.code === 'possible-duplicate') {
        // The server keeps this answer under the key; the override is a different request, so it gets its own.
        idempotencyKey.current = null
        setDuplicate(true)
      } else {
        setProblem(error.problem)
        // A field error from the server is shown on its field too.
        const fromServer: Errors = {}
        for (const e of error.problem.errors ?? []) {
          const field = Object.entries(POINTERS).find(([, p]) => fieldKey(e).startsWith(p))?.[0] as keyof Form | undefined
          if (field) fromServer[field] = 'Check this field.'
        }
        setErrors(fromServer)
      }
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const found = validate(form)
    setErrors(found)
    if (Object.keys(found).length === 0) void send(false)
  }

  function registerAnyway() {
    const text = reason.trim()
    if (!text) return setReasonError('Explain why this is a different patient.')
    if (isOverLimit(text, REASON_LIMIT)) return setReasonError(`Shorten the reason to ${REASON_LIMIT} characters or fewer.`)
    setReasonError(null)
    void send(true)
  }

  const set = (key: keyof Form) => (e: { target: { value: string } }) => update({ [key]: e.target.value } as Partial<Form>)

  return (
    <section aria-labelledby="register-title" className="space-y-6">
      <h1 id="register-title" className="text-2xl font-semibold text-ink">
        Register a new patient
      </h1>
      <form onSubmit={submit} noValidate className="space-y-6 rounded-xl border border-border bg-surface-1 p-5">
        <fieldset className="grid gap-4 md:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold text-ink">Patient</legend>
          <Field label="First name" required error={errors.given}>{(p) => <TextInput {...p} autoComplete="off" value={form.given} onChange={set('given')} />}</Field>
          <Field label="Last name" required error={errors.family}>{(p) => <TextInput {...p} autoComplete="off" value={form.family} onChange={set('family')} />}</Field>
          <Field label="Preferred name" hint="If they go by another name" error={errors.preferredName}>{(p) => <TextInput {...p} autoComplete="off" value={form.preferredName} onChange={set('preferredName')} />}</Field>
          <Field label="Date of birth" hint="MM/DD/YYYY" required error={errors.birthDate}>{(p) => <DateInput {...p} value={form.birthDate ?? ''} onValueChange={(v) => update({ birthDate: v })} />}</Field>
          <Field label="Legal sex" hint="As on ID and insurance" error={errors.gender}>
            {(p) => (
              <Select {...p} value={form.gender} onChange={(e) => update({ gender: e.target.value as AdministrativeGender | '' })}>
                <option value="">Not given</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
                <option value="unknown">Unknown</option>
              </Select>
            )}
          </Field>
          <Field label="Sex assigned at birth" hint="Optional" error={errors.birthSex}>
            {(p) => (
              <Select {...p} value={form.birthSex} onChange={(e) => update({ birthSex: e.target.value as BirthSex | '' })}>
                <option value="">Not asked</option>
                {BIRTH_SEX_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Gender identity" hint="Optional" error={errors.genderIdentity}>
            {(p) => (
              <Select {...p} value={form.genderIdentity} onChange={(e) => update({ genderIdentity: e.target.value })}>
                <option value="">Not asked</option>
                {GENDER_IDENTITY_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 md:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold text-ink">Contact</legend>
          <Field label="Phone" error={errors.phone}>{(p) => <PhoneInput {...p} value="" onValueChange={(v) => update({ phone: v })} />}</Field>
          <Field label="Phone type">
            {(p) => (
              <Select {...p} value={form.phoneUse} onChange={(e) => update({ phoneUse: e.target.value as Form['phoneUse'] })}>
                <option value="mobile">Mobile</option>
                <option value="home">Home</option>
                <option value="work">Work</option>
              </Select>
            )}
          </Field>
          <Field label="Email" error={errors.email}>{(p) => <TextInput {...p} type="email" autoComplete="off" value={form.email} onChange={set('email')} />}</Field>
        </fieldset>
        <fieldset className="grid gap-4 md:grid-cols-4">
          <legend className="mb-2 text-sm font-semibold text-ink">Home address (optional)</legend>
          <Field label="Street address" error={errors.line1}>{(p) => <TextInput {...p} autoComplete="off" value={form.line1} onChange={set('line1')} />}</Field>
          <Field label="City" error={errors.city}>{(p) => <TextInput {...p} autoComplete="off" value={form.city} onChange={set('city')} />}</Field>
          <Field label="State" error={errors.state}>{(p) => <StateSelect {...p} value={form.state} onChange={set('state')} />}</Field>
          <Field label="ZIP code" hint="12345 or 12345-6789" error={errors.zip}>{(p) => <TextInput {...p} inputMode="numeric" autoComplete="off" value={form.zip} onChange={set('zip')} />}</Field>
        </fieldset>

        {problem ? <ProblemAlert problem={problem} fieldLabels={FIELD_LABELS} /> : null}

        {duplicate ? (
          <Alert tone="warning" title="This patient may already be registered">
            <p>Someone with a similar name and the same date of birth or phone is already registered. Search first, so the chart isn't split in two.</p>
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <Button type="button" variant="secondary" onClick={() => void navigate('/patients/search')}>
                  Search for the patient
                </Button>
              </div>
              <Field label="Reason to register anyway" hint="Recorded and reviewed, e.g. twins, or a different person with the same name" error={reasonError ?? undefined}>
                {(p) => <Textarea {...p} value={reason} limit={REASON_LIMIT} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <div>
                <Button type="button" variant="outline" loading={busy} onClick={registerAnyway}>
                  Register anyway
                </Button>
              </div>
            </div>
          </Alert>
        ) : (
          <div className="flex gap-3">
            <Button type="submit" loading={busy} icon={<UserPlus aria-hidden="true" size={16} />}>
              Register patient
            </Button>
            <Button type="button" variant="ghost" onClick={() => void navigate('/patients/search')}>
              Cancel
            </Button>
          </div>
        )}
      </form>
    </section>
  )
}

/** The form field each body pointer belongs to (prefix match). */
const POINTERS: Partial<Record<keyof Form, string>> = {
  given: '/name/given',
  family: '/name/family',
  preferredName: '/preferredName',
  birthDate: '/birthDate',
  gender: '/gender',
  birthSex: '/birthSex',
  genderIdentity: '/genderIdentity',
  phone: '/phones',
  email: '/emails',
  line1: '/address/lines',
  city: '/address/city',
  state: '/address/state',
  zip: '/address/postalCode',
}
