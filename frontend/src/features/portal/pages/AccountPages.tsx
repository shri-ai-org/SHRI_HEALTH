import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { newIdempotencyKey } from '../../../api/client'
import type { PortalChangeRequestChanges, PortalChangeRequestChangesMaritalStatus, PortalPhone, PortalProfile } from '../../../api/generated/model'
import { Alert, Button, Field, isOverLimit, isValidZip, PhoneInput, problemCopy, Select, StateSelect, Textarea, TextInput } from '../../../design-system'
import { usePortalApi } from '../api/portalApi'
import { toProblem, useResource } from '../api/useResource'
import { useRouter } from '../router'
import { SignaturePad, type SignaturePadHandle } from '../SignaturePad'
import { AsyncPanel, ErrorSummary, formatInstantShort, PageHeader } from '../ui'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NAME = /^[A-Za-z][A-Za-z .'-]*$/

/** Times with no facility (when a request was sent, a signature saved) show in the patient's own zone. */
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

/* ---------- Demographics and Profile Information ---------- */

/*
 * The old profile form, as a change request (D91, M20): the patient asks, the front desk checks and
 * applies it, so a typo never changes the chart unseen. Only changed fields are sent. Requests not
 * yet decided show at the top, from `GET /portal/me`. Employer details are not in the portal
 * contract, so the old Employer section is gone; the front desk records them.
 */

const MARITAL: Array<{ code: PortalChangeRequestChangesMaritalStatus; label: string }> = [
  { code: 'M', label: 'Married' },
  { code: 'S', label: 'Never married' },
  { code: 'D', label: 'Divorced' },
  { code: 'W', label: 'Widowed' },
  { code: 'L', label: 'Legally separated' },
  { code: 'T', label: 'Domestic partner' },
  { code: 'U', label: 'Unmarried' },
]

/** OMB race categories, CDC Race and Ethnicity codes (US Core, D39). */
const RACES = [
  { code: '1002-5', label: 'American Indian or Alaska Native' },
  { code: '2028-9', label: 'Asian' },
  { code: '2054-5', label: 'Black or African American' },
  { code: '2076-8', label: 'Native Hawaiian or Other Pacific Islander' },
  { code: '2106-3', label: 'White' },
]

const ETHNICITIES = [
  { code: '2135-2', label: 'Hispanic or Latino' },
  { code: '2186-5', label: 'Not Hispanic or Latino' },
]

/** BCP 47 tags (D39). */
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'zh', label: 'Chinese' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fr', label: 'French' },
]

const NOTE_LIMIT = 500

interface ProfileForm {
  first: string
  middle: string
  last: string
  preferredName: string
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
  email: string
  /** E.164, `''` when empty, `null` when typed but not a valid number. */
  mobile: string | null
  home: string | null
  ecName: string
  ecRelationship: string
  ecPhone: string | null
  language: string
  maritalStatus: '' | PortalChangeRequestChangesMaritalStatus
  race: string
  ethnicity: string
  note: string
}

function formFrom(p: PortalProfile): ProfileForm {
  const phone = (use: PortalPhone['use']) => p.phones?.find((x) => x.use === use)?.number ?? ''
  return {
    first: p.name.given?.[0] ?? '',
    middle: p.name.given?.slice(1).join(' ') ?? '',
    last: p.name.family,
    preferredName: p.preferredName ?? '',
    line1: p.address?.lines[0] ?? '',
    line2: p.address?.lines.slice(1).join(', ') ?? '',
    city: p.address?.city ?? '',
    state: p.address?.state ?? '',
    postalCode: p.address?.postalCode ?? '',
    email: p.email ?? '',
    mobile: phone('mobile'),
    home: phone('home'),
    ecName: p.emergencyContact?.name ?? '',
    ecRelationship: p.emergencyContact?.relationship ?? '',
    ecPhone: p.emergencyContact?.phone ?? '',
    language: p.preferredLanguage ?? '',
    maritalStatus: p.maritalStatus ?? '',
    race: p.race?.ombCategories?.[0] ?? '',
    ethnicity: p.ethnicity?.ombCategories?.[0] ?? '',
    note: '',
  }
}

/** What the patient changed, in the contract's shape; empty when nothing changed. */
function changesBetween(before: ProfileForm, after: ProfileForm): PortalChangeRequestChanges {
  const changed = (...keys: Array<keyof ProfileForm>) => keys.some((k) => before[k] !== after[k])
  const c: PortalChangeRequestChanges = {}
  if (changed('first', 'middle', 'last')) c.name = { given: [after.first.trim(), ...(after.middle.trim() ? [after.middle.trim()] : [])], family: after.last.trim() }
  if (changed('preferredName')) c.preferredName = after.preferredName.trim()
  if (changed('line1', 'line2', 'city', 'state', 'postalCode')) {
    c.address = { lines: [after.line1.trim(), ...(after.line2.trim() ? [after.line2.trim()] : [])], city: after.city.trim(), state: after.state, postalCode: after.postalCode.trim(), country: 'US' }
  }
  if (changed('email')) c.email = after.email.trim()
  if (changed('mobile', 'home')) {
    c.phones = [...(after.mobile ? [{ number: after.mobile, use: 'mobile' as const }] : []), ...(after.home ? [{ number: after.home, use: 'home' as const }] : [])]
  }
  if (changed('ecName', 'ecRelationship', 'ecPhone')) {
    c.emergencyContact = { name: after.ecName.trim(), ...(after.ecRelationship.trim() ? { relationship: after.ecRelationship.trim() } : {}), ...(after.ecPhone ? { phone: after.ecPhone } : {}) }
  }
  if (changed('language') && after.language) c.preferredLanguage = after.language
  if (changed('maritalStatus') && after.maritalStatus) c.maritalStatus = after.maritalStatus
  if (changed('race') && after.race) c.race = { ombCategories: [after.race] }
  if (changed('ethnicity') && after.ethnicity) c.ethnicity = { ombCategories: [after.ethnicity] }
  return c
}

const CHANGE_LABELS: Record<keyof PortalChangeRequestChanges, string> = {
  name: 'name',
  preferredName: 'name you go by',
  phones: 'phone numbers',
  email: 'contact email',
  address: 'address',
  emergencyContact: 'emergency contact',
  preferredLanguage: 'preferred language',
  race: 'race',
  ethnicity: 'ethnicity',
  maritalStatus: 'marital status',
  genderIdentity: 'gender identity',
  sexualOrientation: 'sexual orientation',
}

function changedFieldNames(changes: PortalChangeRequestChanges): string {
  return (Object.keys(changes) as Array<keyof PortalChangeRequestChanges>).map((k) => CHANGE_LABELS[k]).join(', ')
}

export function DemographicsPage() {
  const api = usePortalApi()
  const profile = useResource(() => api.getProfile(), [])
  // Set after a request is sent; the profile is read again, so the request shows as pending.
  const [sent, setSent] = useState(false)
  return (
    <>
      <PageHeader
        title="Demographics and Profile Information"
        description="Changes go to your clinic's front desk, who update your record after checking them."
        back={{ to: '/', label: 'Home' }}
      />
      {sent ? <Alert tone="success" title="Sent to the front desk. They'll update your record after checking it." /> : null}
      <div className={sent ? 'mt-5' : ''}>
        <AsyncPanel resource={profile} label="your profile">
          {(p) => (
            <DemographicsForm
              profile={p}
              onEdit={() => setSent(false)}
              onSent={() => {
                setSent(true)
                profile.reload()
              }}
            />
          )}
        </AsyncPanel>
      </div>
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

function DemographicsForm({ profile, onEdit, onSent }: { profile: PortalProfile; onEdit: () => void; onSent: () => void }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [initial] = useState(() => formFrom(profile))
  const [d, setD] = useState(initial)
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'info'; text: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // One key per set of answers, so a retry after a network error sends the same request.
  const [key, setKey] = useState(newIdempotencyKey)
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => {
    setNotice(null)
    onEdit()
    setD((x) => ({ ...x, [k]: v }))
    setKey(newIdempotencyKey())
  }
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message

  async function save(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!NAME.test(d.first.trim())) found.push({ fieldId: 'dm-first', message: 'Enter your first name (letters only)' })
    if (d.middle.trim() && !NAME.test(d.middle.trim())) found.push({ fieldId: 'dm-middle', message: 'Middle name can have letters only' })
    if (!NAME.test(d.last.trim())) found.push({ fieldId: 'dm-last', message: 'Enter your last name (letters only)' })
    if (!d.line1.trim()) found.push({ fieldId: 'dm-address', message: 'Enter your address' })
    if (!d.city.trim()) found.push({ fieldId: 'dm-city', message: 'Enter your city' })
    if (!d.state) found.push({ fieldId: 'dm-state', message: 'Select your state' })
    if (!isValidZip(d.postalCode.trim())) found.push({ fieldId: 'dm-zip', message: 'Enter a valid ZIP code' })
    if (d.email.trim() && !EMAIL.test(d.email.trim())) found.push({ fieldId: 'dm-email', message: 'Enter a valid email address' })
    if (d.mobile === null) found.push({ fieldId: 'dm-mobile', message: 'Enter a valid 10-digit mobile phone, or leave it empty' })
    if (d.home === null) found.push({ fieldId: 'dm-home', message: 'Enter a valid 10-digit home phone, or leave it empty' })
    if (d.ecPhone === null) found.push({ fieldId: 'dm-ec-phone', message: 'Enter a valid 10-digit phone for your emergency contact, or leave it empty' })
    if ((d.ecPhone || d.ecRelationship.trim()) && !d.ecName.trim()) found.push({ fieldId: 'dm-ec-name', message: "Enter your emergency contact's name" })
    if (isOverLimit(d.note, NOTE_LIMIT)) found.push({ fieldId: 'dm-note', message: `Shorten the note to ${NOTE_LIMIT} characters or fewer` })
    setErrors(found)
    if (found.length) return
    const changes = changesBetween(initial, d)
    if (Object.keys(changes).length === 0) return setNotice({ tone: 'info', text: 'Nothing has changed yet.' })
    setBusy(true)
    setFailure(null)
    try {
      await api.requestChange({ changes, ...(d.note.trim() ? { note: d.note.trim() } : {}) }, key)
      window.scrollTo({ top: 0 })
      // Reading the profile again shows the new request as pending.
      onSent()
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  const options = (list: Array<{ code: string; label: string }>, placeholder: string) => [
    <option key="" value="">
      {placeholder}
    </option>,
    ...list.map((o) => (
      <option key={o.code} value={o.code}>
        {o.label}
      </option>
    )),
  ]

  return (
    <form noValidate onSubmit={save} className="space-y-5">
      {notice ? <Alert tone={notice.tone} title={notice.text} /> : null}
      {profile.pendingChangeRequests.length ? (
        <Alert
          tone="info"
          title={profile.pendingChangeRequests.length === 1 ? 'You have a change waiting for the front desk' : `You have ${profile.pendingChangeRequests.length} changes waiting for the front desk`}
        >
          <ul className="list-disc pl-5">
            {profile.pendingChangeRequests.map((r) => (
              <li key={r.id}>
                Sent {formatInstantShort(r.submittedAt, BROWSER_TZ)}: {changedFieldNames(r.changes)}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <ErrorSummary errors={errors} />
      {failure ? <Alert tone="critical" title="Not sent">{failure}</Alert> : null}

      <Section title="Personal Details">
        <Field id="dm-first" label="First Name" required error={err('dm-first')}>
          {(p) => <TextInput {...p} autoComplete="given-name" value={d.first} onChange={(e) => set('first', e.target.value)} />}
        </Field>
        <Field id="dm-middle" label="Middle Name" error={err('dm-middle')}>
          {(p) => <TextInput {...p} autoComplete="additional-name" value={d.middle} onChange={(e) => set('middle', e.target.value)} />}
        </Field>
        <Field id="dm-last" label="Last Name" required error={err('dm-last')}>
          {(p) => <TextInput {...p} autoComplete="family-name" value={d.last} onChange={(e) => set('last', e.target.value)} />}
        </Field>
        <Field id="dm-preferred" label="Name you go by" hint="What we call you">
          {(p) => <TextInput {...p} autoComplete="nickname" value={d.preferredName} onChange={(e) => set('preferredName', e.target.value)} />}
        </Field>
        <Field id="dm-address" label="Address" required error={err('dm-address')}>
          {(p) => <TextInput {...p} autoComplete="address-line1" value={d.line1} onChange={(e) => set('line1', e.target.value)} />}
        </Field>
        <Field id="dm-address2" label="Apartment, suite or unit">
          {(p) => <TextInput {...p} autoComplete="address-line2" value={d.line2} onChange={(e) => set('line2', e.target.value)} />}
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
        <Field id="dm-email" label="Contact email" hint="To change the email you sign in with, use Password and security" error={err('dm-email')}>
          {(p) => <TextInput {...p} type="email" autoComplete="email" value={d.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field id="dm-mobile" label="Mobile Phone" error={err('dm-mobile')}>
          {(p) => <PhoneInput {...p} value={initial.mobile ?? ''} onValueChange={(v) => set('mobile', v)} />}
        </Field>
        <Field id="dm-home" label="Home Phone" error={err('dm-home')}>
          {(p) => <PhoneInput {...p} autoComplete="off" value={initial.home ?? ''} onValueChange={(v) => set('home', v)} />}
        </Field>
        <Field id="dm-marital" label="Marital Status">
          {(p) => (
            <Select {...p} value={d.maritalStatus} onChange={(e) => set('maritalStatus', e.target.value as ProfileForm['maritalStatus'])}>
              {options(MARITAL, 'Select marital status')}
            </Select>
          )}
        </Field>
        <Field id="dm-race" label="Race">
          {(p) => (
            <Select {...p} value={d.race} onChange={(e) => set('race', e.target.value)}>
              {options(RACES, 'Select race')}
            </Select>
          )}
        </Field>
        <Field id="dm-language" label="Preferred language">
          {(p) => (
            <Select {...p} value={d.language} onChange={(e) => set('language', e.target.value)}>
              {options(LANGUAGES, 'Select language')}
            </Select>
          )}
        </Field>
        <Field id="dm-ethnicity" label="Ethnicity">
          {(p) => (
            <Select {...p} value={d.ethnicity} onChange={(e) => set('ethnicity', e.target.value)}>
              {options(ETHNICITIES, 'Select ethnicity')}
            </Select>
          )}
        </Field>
      </Section>

      <Section title="Emergency Contact">
        <Field id="dm-ec-name" label="Name" error={err('dm-ec-name')}>
          {(p) => <TextInput {...p} value={d.ecName} onChange={(e) => set('ecName', e.target.value)} />}
        </Field>
        <Field id="dm-ec-rel" label="Relationship" hint="For example spouse, parent or friend">
          {(p) => <TextInput {...p} value={d.ecRelationship} onChange={(e) => set('ecRelationship', e.target.value)} />}
        </Field>
        <Field id="dm-ec-phone" label="Contact Number" error={err('dm-ec-phone')}>
          {(p) => <PhoneInput {...p} autoComplete="off" value={initial.ecPhone ?? ''} onValueChange={(v) => set('ecPhone', v)} />}
        </Field>
      </Section>

      <div className="max-w-2xl rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
        <Field id="dm-note" label="Note for the front desk" hint="Optional, for example why your name changed" error={err('dm-note')}>
          {(p) => <Textarea {...p} value={d.note} limit={NOTE_LIMIT} onChange={(e) => set('note', e.target.value)} />}
        </Field>
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => navigate('/')}>
          Cancel
        </Button>
        <Button type="submit" size="lg" loading={busy}>
          Send changes
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
      setNotice({ tone: 'success', text: `Signature saved ${formatInstantShort(s.savedAt, BROWSER_TZ)}. Select View to see it.` })
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
