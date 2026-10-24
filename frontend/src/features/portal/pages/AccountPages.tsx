import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Alert, Button, Field, isValidZip, PhoneInput, problemCopy, Select, StateSelect, TextInput } from '../../../design-system'
import { usePortalApi } from '../api/portalApi'
import type { Demographics, ReferenceLists } from '../api/types'
import { toProblem, useResource } from '../api/useResource'
import { useRouter } from '../router'
import { SignaturePad, type SignaturePadHandle } from '../SignaturePad'
import { AsyncPanel, ErrorSummary, formatInstantShort, PageHeader } from '../ui'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NAME = /^[A-Za-z][A-Za-z .'-]*$/

/* ---------- Demographics and Profile Information ---------- */

export function DemographicsPage() {
  const api = usePortalApi()
  const data = useResource(() => Promise.all([api.getDemographics(), api.getReferenceLists()]), [])
  return (
    <>
      <PageHeader title="Demographics and Profile Information" back={{ to: '/', label: 'Home' }} />
      <AsyncPanel resource={data} label="your profile">
        {([d, lists]) => <DemographicsForm initial={d} lists={lists} />}
      </AsyncPanel>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
      <legend className="px-1 text-base font-semibold text-ink">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  )
}

function DemographicsForm({ initial, lists }: { initial: Demographics; lists: ReferenceLists }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [d, setD] = useState({ ...initial, mobilePhone: initial.mobilePhone as string | null, homePhone: initial.homePhone as string | null, ecPhone: initial.emergencyContact.phone as string | null })
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => {
    setSaved(false)
    setD((x) => ({ ...x, [k]: v }))
  }
  const setEmp = (k: keyof Demographics['employer'], v: string) => set('employer', { ...d.employer, [k]: v })
  const setEc = (k: 'name' | 'relationship', v: string) => set('emergencyContact', { ...d.emergencyContact, [k]: v })
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message

  async function save(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!NAME.test(d.firstName.trim())) found.push({ fieldId: 'dm-first', message: 'Enter your first name (letters only)' })
    if (d.middleName.trim() && !NAME.test(d.middleName.trim())) found.push({ fieldId: 'dm-middle', message: 'Middle name can have letters only' })
    if (!NAME.test(d.lastName.trim())) found.push({ fieldId: 'dm-last', message: 'Enter your last name (letters only)' })
    if (!d.address.trim()) found.push({ fieldId: 'dm-address', message: 'Enter your address' })
    if (!d.city.trim()) found.push({ fieldId: 'dm-city', message: 'Enter your city' })
    if (!d.state) found.push({ fieldId: 'dm-state', message: 'Select your state' })
    if (!isValidZip(d.postalCode.trim())) found.push({ fieldId: 'dm-zip', message: 'Enter a valid ZIP code' })
    if (!EMAIL.test(d.email.trim())) found.push({ fieldId: 'dm-email', message: 'Enter a valid email address' })
    if (!d.mobilePhone) found.push({ fieldId: 'dm-mobile', message: 'Enter a valid 10-digit mobile phone' })
    if (d.homePhone === null) found.push({ fieldId: 'dm-home', message: 'Enter a valid 10-digit home phone, or leave it empty' })
    if (d.employer.postalCode.trim() && !isValidZip(d.employer.postalCode.trim())) found.push({ fieldId: 'dm-emp-zip', message: 'Enter a valid employer ZIP code' })
    if (!d.emergencyContact.name.trim()) found.push({ fieldId: 'dm-ec-name', message: "Enter your emergency contact's name" })
    if (!d.ecPhone) found.push({ fieldId: 'dm-ec-phone', message: "Enter your emergency contact's phone number" })
    setErrors(found)
    if (found.length) return
    setBusy(true)
    setFailure(null)
    try {
      const { ecPhone, ...rest } = d
      await api.updateDemographics({ ...rest, mobilePhone: d.mobilePhone ?? '', homePhone: d.homePhone ?? '', emergencyContact: { ...d.emergencyContact, phone: ecPhone ?? '' } })
      setSaved(true)
      window.scrollTo({ top: 0 })
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  const opts = (list: string[], placeholder: string) => [
    <option key="" value="">
      {placeholder}
    </option>,
    ...list.map((o) => <option key={o}>{o}</option>),
  ]

  return (
    <form noValidate onSubmit={save} className="space-y-5">
      {saved ? <Alert tone="success" title="Profile updated successfully." /> : null}
      <ErrorSummary errors={errors} />
      {failure ? <Alert tone="critical" title="Not saved">{failure}</Alert> : null}

      <Section title="Personal Details">
        <Field id="dm-first" label="First Name" required error={err('dm-first')}>
          {(p) => <TextInput {...p} autoComplete="given-name" value={d.firstName} onChange={(e) => set('firstName', e.target.value)} />}
        </Field>
        <Field id="dm-middle" label="Middle Name" error={err('dm-middle')}>
          {(p) => <TextInput {...p} autoComplete="additional-name" value={d.middleName} onChange={(e) => set('middleName', e.target.value)} />}
        </Field>
        <Field id="dm-last" label="Last Name" required error={err('dm-last')}>
          {(p) => <TextInput {...p} autoComplete="family-name" value={d.lastName} onChange={(e) => set('lastName', e.target.value)} />}
        </Field>
        <Field id="dm-address" label="Address" required error={err('dm-address')}>
          {(p) => <TextInput {...p} autoComplete="street-address" value={d.address} onChange={(e) => set('address', e.target.value)} />}
        </Field>
        <Field id="dm-city" label="City" required error={err('dm-city')}>
          {(p) => <TextInput {...p} autoComplete="address-level2" value={d.city} onChange={(e) => set('city', e.target.value)} />}
        </Field>
        <Field id="dm-state" label="State" required error={err('dm-state')}>
          {(p) => <StateSelect {...p} value={d.state} onChange={(e) => set('state', e.target.value)} />}
        </Field>
        <Field id="dm-zip" label="ZIP Code" required error={err('dm-zip')}>
          {(p) => <TextInput {...p} inputMode="numeric" autoComplete="postal-code" value={d.postalCode} onChange={(e) => set('postalCode', e.target.value)} />}
        </Field>
        <Field id="dm-country" label="Country">
          {(p) => <Select {...p} value={d.country} onChange={(e) => set('country', e.target.value)}>{opts(lists.countries, 'Select country')}</Select>}
        </Field>
        <Field id="dm-email" label="Email" required error={err('dm-email')}>
          {(p) => <TextInput {...p} type="email" autoComplete="email" value={d.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field id="dm-mobile" label="Mobile Phone" required error={err('dm-mobile')}>
          {(p) => <PhoneInput {...p} value={initial.mobilePhone} onValueChange={(v) => set('mobilePhone', v)} />}
        </Field>
        <Field id="dm-home" label="Home Phone" error={err('dm-home')}>
          {(p) => <PhoneInput {...p} autoComplete="off" value={initial.homePhone} onValueChange={(v) => set('homePhone', v)} />}
        </Field>
        <Field id="dm-marital" label="Marital Status">
          {(p) => <Select {...p} value={d.maritalStatus} onChange={(e) => set('maritalStatus', e.target.value)}>{opts(lists.maritalStatuses, 'Select marital status')}</Select>}
        </Field>
        <Field id="dm-race" label="Race">
          {(p) => <Select {...p} value={d.race} onChange={(e) => set('race', e.target.value)}>{opts(lists.races, 'Select race')}</Select>}
        </Field>
        <Field id="dm-language" label="Language">
          {(p) => <Select {...p} value={d.language} onChange={(e) => set('language', e.target.value)}>{opts(lists.languages, 'Select language')}</Select>}
        </Field>
        <Field id="dm-ethnicity" label="Ethnicity">
          {(p) => <Select {...p} value={d.ethnicity} onChange={(e) => set('ethnicity', e.target.value)}>{opts(lists.ethnicities, 'Select ethnicity')}</Select>}
        </Field>
      </Section>

      <Section title="Employer Details">
        <Field id="dm-emp-name" label="Name">
          {(p) => <TextInput {...p} autoComplete="organization" value={d.employer.name} onChange={(e) => setEmp('name', e.target.value)} />}
        </Field>
        <Field id="dm-emp-address" label="Address">
          {(p) => <TextInput {...p} value={d.employer.address} onChange={(e) => setEmp('address', e.target.value)} />}
        </Field>
        <Field id="dm-emp-city" label="City">
          {(p) => <TextInput {...p} value={d.employer.city} onChange={(e) => setEmp('city', e.target.value)} />}
        </Field>
        <Field id="dm-emp-state" label="Employer State">
          {(p) => <StateSelect {...p} autoComplete="off" value={d.employer.state} onChange={(e) => setEmp('state', e.target.value)} />}
        </Field>
        <Field id="dm-emp-zip" label="ZIP Code" error={err('dm-emp-zip')}>
          {(p) => <TextInput {...p} inputMode="numeric" value={d.employer.postalCode} onChange={(e) => setEmp('postalCode', e.target.value)} />}
        </Field>
        <Field id="dm-emp-country" label="Employer Country">
          {(p) => <Select {...p} value={d.employer.country} onChange={(e) => setEmp('country', e.target.value)}>{opts(lists.countries, 'Select country')}</Select>}
        </Field>
      </Section>

      <Section title="Emergency Contact">
        <Field id="dm-ec-name" label="Name" required error={err('dm-ec-name')}>
          {(p) => <TextInput {...p} value={d.emergencyContact.name} onChange={(e) => setEc('name', e.target.value)} />}
        </Field>
        <Field id="dm-ec-rel" label="Guardian Relationship">
          {(p) => <Select {...p} value={d.emergencyContact.relationship} onChange={(e) => setEc('relationship', e.target.value)}>{opts(lists.relationships, 'Select relationship')}</Select>}
        </Field>
        <Field id="dm-ec-phone" label="Contact Number" required error={err('dm-ec-phone')}>
          {(p) => <PhoneInput {...p} autoComplete="off" value={initial.emergencyContact.phone} onValueChange={(v) => set('ecPhone', v)} />}
        </Field>
      </Section>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => navigate('/')}>
          Cancel
        </Button>
        <Button type="submit" size="lg" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  )
}

/* ---------- E-Signature ---------- */

export function ESignaturePage() {
  const api = usePortalApi()
  const pad = useRef<SignaturePadHandle>(null)
  const [empty, setEmpty] = useState(true)
  const [busy, setBusy] = useState<'save' | 'view' | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'critical'; text: string } | null>(null)

  async function save() {
    if (!pad.current || pad.current.isEmpty()) return setNotice({ tone: 'info', text: 'Draw your signature in the box first.' })
    setBusy('save')
    try {
      const s = await api.saveSignature(pad.current.toDataUrl())
      pad.current.clear()
      setNotice({ tone: 'success', text: `Signature saved ${formatInstantShort(s.savedAt, 'America/Chicago')}. Select View to see it.` })
    } catch (err) {
      setNotice({ tone: 'critical', text: problemCopy(toProblem(err)).message })
    } finally {
      setBusy(null)
    }
  }

  async function view() {
    setBusy('view')
    try {
      const s = await api.getSignature()
      if (s) {
        pad.current?.show(s.image)
        setNotice({ tone: 'info', text: 'This is your saved signature.' })
      } else setNotice({ tone: 'info', text: "You haven't saved a signature yet." })
    } catch (err) {
      setNotice({ tone: 'critical', text: problemCopy(toProblem(err)).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader title="Patient Electronic Signature" description="Your saved signature is used when you sign document templates." back={{ to: '/', label: 'Home' }} />
      <div className="max-w-2xl space-y-4 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
        {notice ? <Alert tone={notice.tone} title={notice.text} /> : null}
        <SignaturePad ref={pad} label="Signature box" onChange={setEmpty} />
        <div className="flex flex-wrap gap-2">
          <Button loading={busy === 'save'} disabled={empty} onClick={save}>
            Save
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              pad.current?.clear()
              setNotice(null)
            }}
          >
            Clear
          </Button>
          <Button variant="outline" loading={busy === 'view'} onClick={view}>
            View
          </Button>
        </div>
      </div>
    </>
  )
}

/* ---------- Change Password ---------- */

export function ChangePasswordPage() {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [f, setF] = useState({ email: '', current: '', next: '', confirm: '' })
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message
  const rules = [
    { ok: f.next.length >= 8, text: 'At least 8 characters' },
    { ok: /[a-z]/.test(f.next) && /[A-Z]/.test(f.next), text: 'Upper and lower case letters' },
    { ok: /\d/.test(f.next), text: 'At least one number' },
    { ok: /[@$!%*?&]/.test(f.next), text: 'At least one of @ $ ! % * ? &' },
  ]

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!EMAIL.test(f.email.trim())) found.push({ fieldId: 'pw-email', message: 'Enter a valid email address' })
    if (!f.current) found.push({ fieldId: 'pw-old', message: 'Enter your old password' })
    if (!rules.every((r) => r.ok)) found.push({ fieldId: 'pw-new', message: 'Your new password must meet all the rules listed' })
    if (f.confirm !== f.next) found.push({ fieldId: 'pw-confirm', message: 'Please retype the same password' })
    setErrors(found)
    setDone(false)
    if (found.length) return
    setBusy(true)
    setFailure(null)
    try {
      await api.changePassword({ email: f.email.trim(), currentPassword: f.current, newPassword: f.next })
      setDone(true)
      setF({ email: '', current: '', next: '', confirm: '' })
    } catch (error) {
      const p = toProblem(error)
      if (p.errors?.some((x) => x.pointer === '/currentPassword')) setErrors([{ fieldId: 'pw-old', message: 'Old password is wrong' }])
      else setFailure(problemCopy(p).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Change Password" description="Enter your new password. We recommend a unique password that others can't guess." back={{ to: '/', label: 'Home' }} />
      <form noValidate onSubmit={submit} className="max-w-lg space-y-4 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
        {done ? <Alert tone="success" title="Password changed successfully." /> : null}
        <ErrorSummary errors={errors} />
        {failure ? <Alert tone="critical" title="Password not changed">{failure}</Alert> : null}
        <Field id="pw-email" label="Email" required error={err('pw-email')}>
          {(p) => <TextInput {...p} type="email" autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field id="pw-old" label="Old Password" required error={err('pw-old')}>
          {(p) => <TextInput {...p} type="password" autoComplete="current-password" value={f.current} onChange={(e) => set('current', e.target.value)} />}
        </Field>
        <Field id="pw-new" label="New Password" required error={err('pw-new')}>
          {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={f.next} onChange={(e) => set('next', e.target.value)} />}
        </Field>
        <ul aria-label="Password rules" className="-mt-2 space-y-0.5 text-xs">
          {rules.map((r) => (
            <li key={r.text} className={r.ok ? 'text-success-fg' : 'text-ink-subtle'}>
              <span aria-hidden="true">{r.ok ? '✓' : '○'} </span>
              {r.text}
              <span className="sr-only">{r.ok ? ', met' : ', not met yet'}</span>
            </li>
          ))}
        </ul>
        <Field id="pw-confirm" label="Confirm New Password" required error={err('pw-confirm')}>
          {(p) => <TextInput {...p} type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => set('confirm', e.target.value)} />}
        </Field>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => navigate('/')}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Submit
          </Button>
        </div>
        <p className="text-xs text-ink-subtle">Having trouble? Call your clinic for help.</p>
      </form>
    </>
  )
}
