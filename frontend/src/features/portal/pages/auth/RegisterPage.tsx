import { Plus } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Alert, Button, DateInput, Field, formatDate, formatPhone, isValidZip, Modal, PhoneInput, problemCopy, Select, StateSelect, TextInput } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { ReferenceLists, RegistrationCreate } from '../../api/types'
import { toProblem, useResource } from '../../api/useResource'
import { useRouter } from '../../router'
import { Stepper } from '../../Stepper'
import { AsyncPanel, ErrorSummary, PORTAL_NAME, saveBlob } from '../../ui'

/*
 * The old 11-page registration wizard, page for page. Changes: no SSN (D43); U.S. phone and ZIP
 * rules (the old phone rule expected an Indian number); single-answer questions are radio buttons;
 * Add Insurance and Add Pharmacy actually add the entry; failures are shown, not swallowed.
 */

const PAGES = [
  'Basic Information',
  'Choices',
  'Preferred Pharmacy',
  'Medication and Allergy',
  'Past Medical History',
  'Family History',
  'Social History',
  'Surgical History',
  'Hospitalization/Procedure',
  'Consent Forms',
  'Review',
]

const PAST_HISTORY = ['Head', 'Ears', 'Nose/Sinuses', 'Mouth/Throat/Teeth', 'Cardiovascular', 'Respiratory', 'Gastrointestinal', 'Genito-Urinary', 'Endocrine', 'Heme/Onc', 'Infections', 'Musculoskeletal', 'Skin', 'Neurological', 'Psychiatric']
const FAMILY_CONDITIONS = ['Anemia', 'Asthma/Allergies', 'Bleeding/Clotting', 'Cancer', 'Diabetes', 'Epilepsy', 'Heart Disease', 'Skin Disease', 'Kidney Disease']
const RELATIVES = ['Father', 'Mother', 'Children', 'Others']
const TOBACCO = ['Current every day smoker', 'Current some day smoker', 'Former smoker', 'Heavy tobacco smoker', 'Light tobacco smoker', 'Never smoked', 'Unknown if ever smoked']
const ALCOHOL = ['Do not drink', 'Drink daily', 'Drink frequently', 'History of alcohol use', 'Drink occasionally']
const DRUGS = ['IV drug use', 'Illicit drug use', 'No illicit drug use']
const CARDIO = ['Eat healthy meals', 'Regular exercise', 'Take daily aspirin']
const SURGERIES: Array<[string, string[]]> = [
  ['General', ['Angioplasty', 'Appendectomy', 'Arthroscopy knee', 'Back surgery', 'CABG (heart bypass)', 'Carpal tunnel release', 'Colectomy', 'Gastric bypass', 'Hernia repair', 'Liver biopsy']],
  ['Male only', ['Prostate biopsy', 'TURP', 'Vasectomy']],
  ['Female only', ['Augmentation mammoplasty', 'Breast biopsy', 'Mastectomy', 'Myomectomy', 'Vaginal hysterectomy']],
]

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NAME = /^[A-Za-z][A-Za-z .'-]*$/

type Basic = Omit<RegistrationCreate['basic'], 'birthDate' | 'phone' | 'emergencyContact' | 'sex'> & {
  birthDate: string | null
  phone: string | null
  sex: '' | 'female' | 'male'
  ec: { firstName: string; lastName: string; phone: string | null; relationship: string; email: string }
}

interface Draft {
  basic: Basic
  choices: {
    providerId: string
    allowPortal: '' | 'yes' | 'no'
    allowSms: '' | 'yes' | 'no'
    allowEmail: '' | 'yes' | 'no'
    language: string
    responsibleParty: '' | RegistrationCreate['choices']['responsibleParty']
    paymentMethod: '' | RegistrationCreate['choices']['paymentMethod']
    insurance: { company: string; plan: string; policyNumber: string; groupNumber: string; city: string; state: string; country: string; postalCode: string; relationship: string }
  }
  pharmacy: RegistrationCreate['pharmacy']
  meds: { takingMedications: '' | 'yes' | 'no'; medications: string; hasAllergies: '' | 'yes' | 'no'; allergies: string }
  pastMedicalHistory: string[]
  family: Record<string, string[]>
  familyOther: string
  social: RegistrationCreate['socialHistory']
  surgeries: Record<string, string>
  surgeryOther: string
  hospitalizations: Array<{ date: string; notes: string }>
  agreed: boolean
}

const EMPTY: Draft = {
  basic: { firstName: '', middleName: '', lastName: '', birthDate: '', phone: '', address: '', city: '', state: '', country: 'United States', postalCode: '', maritalStatus: '', sex: '', email: '', ec: { firstName: '', lastName: '', phone: '', relationship: '', email: '' } },
  choices: { providerId: '', allowPortal: '', allowSms: '', allowEmail: '', language: '', responsibleParty: '', paymentMethod: '', insurance: { company: '', plan: '', policyNumber: '', groupNumber: '', city: '', state: '', country: 'United States', postalCode: '', relationship: '' } },
  pharmacy: { name: '', city: '', state: '', country: 'United States', postalCode: '' },
  meds: { takingMedications: '', medications: '', hasAllergies: '', allergies: '' },
  pastMedicalHistory: [],
  family: {},
  familyOther: '',
  social: { tobacco: '', alcohol: '', drugs: '', cardiovascular: [], other: '' },
  surgeries: {},
  surgeryOther: '',
  hospitalizations: [
    { date: '', notes: '' },
    { date: '', notes: '' },
    { date: '', notes: '' },
  ],
  agreed: false,
}

type Errors = Array<{ fieldId: string; message: string }>

function validate(page: number, d: Draft): Errors {
  const e: Errors = []
  const b = d.basic
  if (page === 0) {
    if (!NAME.test(b.firstName.trim())) e.push({ fieldId: 'rg-first', message: 'Enter your first name (letters only)' })
    if (b.middleName.trim() && !NAME.test(b.middleName.trim())) e.push({ fieldId: 'rg-middle', message: 'Middle name can have letters only' })
    if (!NAME.test(b.lastName.trim())) e.push({ fieldId: 'rg-last', message: 'Enter your last name (letters only)' })
    if (!b.birthDate) e.push({ fieldId: 'rg-dob', message: 'Enter your date of birth as MM/DD/YYYY' })
    else if (b.birthDate >= new Date().toISOString().slice(0, 10)) e.push({ fieldId: 'rg-dob', message: 'Date of birth must be in the past' })
    if (!b.phone) e.push({ fieldId: 'rg-phone', message: 'Enter a valid 10-digit U.S. phone number' })
    if (!b.address.trim()) e.push({ fieldId: 'rg-address', message: 'Enter your address' })
    if (!b.city.trim()) e.push({ fieldId: 'rg-city', message: 'Enter your city' })
    if (!b.state) e.push({ fieldId: 'rg-state', message: 'Select your state' })
    if (!isValidZip(b.postalCode.trim())) e.push({ fieldId: 'rg-zip', message: 'Enter a valid ZIP code' })
    if (!b.maritalStatus) e.push({ fieldId: 'rg-marital', message: 'Select your marital status' })
    if (!b.sex) e.push({ fieldId: 'rg-sex-female', message: 'Select your gender' })
    if (!EMAIL.test(b.email.trim())) e.push({ fieldId: 'rg-email', message: 'Enter a valid email address' })
    if (!NAME.test(b.ec.firstName.trim())) e.push({ fieldId: 'rg-ec-first', message: "Enter your emergency contact's first name" })
    if (!NAME.test(b.ec.lastName.trim())) e.push({ fieldId: 'rg-ec-last', message: "Enter your emergency contact's last name" })
    if (!b.ec.phone) e.push({ fieldId: 'rg-ec-phone', message: "Enter your emergency contact's phone number" })
    if (!b.ec.relationship) e.push({ fieldId: 'rg-ec-rel', message: 'Select the relationship' })
    if (b.ec.email.trim() && !EMAIL.test(b.ec.email.trim())) e.push({ fieldId: 'rg-ec-email', message: "Enter a valid email for your emergency contact, or leave it empty" })
  }
  if (page === 1) {
    const c = d.choices
    if (!c.allowPortal) e.push({ fieldId: 'rg-portal-yes', message: 'Answer: Allow patient portal' })
    if (!c.allowSms) e.push({ fieldId: 'rg-sms-yes', message: 'Answer: Allow SMS' })
    if (!c.allowEmail) e.push({ fieldId: 'rg-allowemail-yes', message: 'Answer: Allow email' })
    if (!c.responsibleParty) e.push({ fieldId: 'rg-resp-self', message: 'Choose who is financially responsible for you' })
    if (!c.paymentMethod) e.push({ fieldId: 'rg-pay-self-pay', message: 'Choose a method of payment' })
    if (c.paymentMethod === 'insurance') {
      if (!c.insurance.company) e.push({ fieldId: 'rg-ins-company', message: 'Select your insurance company' })
      if (!c.insurance.plan.trim()) e.push({ fieldId: 'rg-ins-plan', message: 'Enter the plan name' })
      if (!/^[A-Za-z0-9-]{4,}$/.test(c.insurance.policyNumber.trim())) e.push({ fieldId: 'rg-ins-policy', message: 'Enter the policy (member ID) number from your card' })
      if (c.insurance.postalCode.trim() && !isValidZip(c.insurance.postalCode.trim())) e.push({ fieldId: 'rg-ins-zip', message: 'Enter a valid ZIP code, or leave it empty' })
      if (!c.insurance.relationship) e.push({ fieldId: 'rg-ins-rel', message: 'Select your relationship to the policy holder' })
    }
  }
  if (page === 2 && d.pharmacy.postalCode.trim() && !isValidZip(d.pharmacy.postalCode.trim())) e.push({ fieldId: 'rg-ph-zip', message: 'Enter a valid ZIP code, or leave it empty' })
  if (page === 3) {
    if (!d.meds.takingMedications) e.push({ fieldId: 'rg-takingmeds-yes', message: 'Answer: Are you taking any medications?' })
    if (d.meds.takingMedications === 'yes' && !d.meds.medications.trim()) e.push({ fieldId: 'rg-meds', message: 'List your medications' })
    if (!d.meds.hasAllergies) e.push({ fieldId: 'rg-hasallergies-yes', message: 'Answer: Do you have any allergies?' })
    if (d.meds.hasAllergies === 'yes' && !d.meds.allergies.trim()) e.push({ fieldId: 'rg-allergies', message: 'List your allergies and reactions' })
  }
  if (page === 9 && !d.agreed) e.push({ fieldId: 'rg-agree', message: 'Agree to the financial policy to continue' })
  return e
}

function toPayload(d: Draft): RegistrationCreate {
  const b = d.basic
  const c = d.choices
  return {
    basic: {
      firstName: b.firstName.trim(), middleName: b.middleName.trim(), lastName: b.lastName.trim(), birthDate: b.birthDate ?? '', phone: b.phone ?? '',
      address: b.address.trim(), city: b.city.trim(), state: b.state, country: b.country, postalCode: b.postalCode.trim(), maritalStatus: b.maritalStatus,
      sex: b.sex === 'male' ? 'male' : 'female', email: b.email.trim(),
      emergencyContact: { firstName: b.ec.firstName.trim(), lastName: b.ec.lastName.trim(), phone: b.ec.phone ?? '', relationship: b.ec.relationship, email: b.ec.email.trim() },
    },
    choices: {
      providerId: c.providerId, allowPortal: c.allowPortal === 'yes', allowSms: c.allowSms === 'yes', allowEmail: c.allowEmail === 'yes', language: c.language,
      responsibleParty: c.responsibleParty || 'self', paymentMethod: c.paymentMethod || 'self-pay',
      ...(c.paymentMethod === 'insurance' ? { insurance: c.insurance } : {}),
    },
    pharmacy: d.pharmacy,
    medicationsAndAllergies: { takingMedications: d.meds.takingMedications === 'yes', medications: d.meds.medications, hasAllergies: d.meds.hasAllergies === 'yes', allergies: d.meds.allergies },
    pastMedicalHistory: d.pastMedicalHistory,
    familyHistory: { conditions: d.family, other: d.familyOther },
    socialHistory: d.social,
    surgicalHistory: { surgeries: Object.fromEntries(Object.entries(d.surgeries).filter(([, v]) => v)), other: d.surgeryOther },
    hospitalizations: d.hospitalizations.filter((h) => h.date || h.notes.trim()),
    financialPolicyAccepted: d.agreed,
  }
}

export function RegisterPage() {
  const api = usePortalApi()
  const lists = useResource(() => api.getReferenceLists(), [])
  return (
    <div className="portal portal-page accent-brand min-h-dvh px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center gap-2">
          <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl bg-linear-to-br from-(--accent) to-(--accent-2) font-extrabold text-white">
            SH
          </span>
          <span className="flex flex-col leading-tight">
            <span className="font-semibold text-ink">Shri Health</span>
            <span className="text-xs text-ink-subtle">Patient portal</span>
          </span>
        </div>
        <AsyncPanel resource={lists} label="the registration form">
          {(l) => <Wizard lists={l} />}
        </AsyncPanel>
      </div>
    </div>
  )
}

function Wizard({ lists }: { lists: ReferenceLists }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [page, setPage] = useState(0)
  const [reached, setReached] = useState(0)
  const [d, setD] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Errors>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [extraInsurers, setExtraInsurers] = useState<string[]>([])
  const [extraPharmacies, setExtraPharmacies] = useState<string[]>([])
  const [adding, setAdding] = useState<'insurance' | 'pharmacy' | null>(null)
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message
  const setBasic = (patch: Partial<Basic>) => setD((x) => ({ ...x, basic: { ...x.basic, ...patch } }))
  const setEc = (patch: Partial<Basic['ec']>) => setD((x) => ({ ...x, basic: { ...x.basic, ec: { ...x.basic.ec, ...patch } } }))
  const setChoices = (patch: Partial<Draft['choices']>) => setD((x) => ({ ...x, choices: { ...x.choices, ...patch } }))
  const setIns = (patch: Partial<Draft['choices']['insurance']>) => setD((x) => ({ ...x, choices: { ...x.choices, insurance: { ...x.choices.insurance, ...patch } } }))
  const setPh = (patch: Partial<Draft['pharmacy']>) => setD((x) => ({ ...x, pharmacy: { ...x.pharmacy, ...patch } }))

  useEffect(() => {
    document.title = `Registration Form · ${PORTAL_NAME}`
  }, [])

  function goTo(n: number) {
    setErrors([])
    setPage(n)
    window.scrollTo({ top: 0 })
    requestAnimationFrame(() => document.getElementById('rg-page')?.focus())
  }

  async function next(e: FormEvent) {
    e.preventDefault()
    const found = validate(page, d)
    setErrors(found)
    if (found.length) return
    if (page < PAGES.length - 1) {
      setReached((r) => Math.max(r, page + 1))
      return goTo(page + 1)
    }
    // Review page: check every page again before sending.
    for (let i = 0; i < PAGES.length - 1; i++) {
      const pageErrors = validate(i, d)
      if (pageErrors.length) {
        goTo(i)
        setErrors(pageErrors)
        return
      }
    }
    setBusy(true)
    setFailure(null)
    try {
      await api.register(toPayload(d))
      setDone(true)
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  async function downloadSummary() {
    try {
      saveBlob(await api.downloadRegistrationSummary(toPayload(d)), 'registration-summary.txt')
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    }
  }

  const insurers = [...lists.insuranceCompanies, ...extraInsurers]
  const pharmacyNames = [...lists.pharmacies.map((p) => p.displayName), ...extraPharmacies]
  const opts = (list: string[], placeholder = 'Select an option') => [
    <option key="" value="">
      {placeholder}
    </option>,
    ...list.map((o) => <option key={o}>{o}</option>),
  ]
  const area = 'w-full rounded-lg border border-border bg-surface-1 px-3.5 py-2.5 text-sm text-ink aria-invalid:border-critical-fg'

  return (
    <>
      <h1 className="portal-banner mb-6 rounded-2xl bg-linear-to-r from-(--accent) to-(--accent-2) px-6 py-5 text-2xl font-bold text-white shadow-card-lg sm:text-3xl">Registration Form</h1>
      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <Stepper steps={PAGES} current={page} reached={reached} onGo={(i) => i <= reached && goTo(i)} />
        <form noValidate onSubmit={next} className="min-w-0 space-y-5 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card sm:p-6">
          <h2 id="rg-page" tabIndex={-1} className="text-lg font-semibold text-ink outline-none">
            {PAGES[page]}
          </h2>
          <ErrorSummary errors={errors} />
          {failure ? <Alert tone="critical" title="Registration not sent">{failure} Your answers are still here.</Alert> : null}

          {page === 0 ? (
            <>
              <Grid>
                <Field id="rg-first" label="First Name" required error={err('rg-first')}>
                  {(p) => <TextInput {...p} autoComplete="given-name" value={d.basic.firstName} onChange={(e) => setBasic({ firstName: e.target.value })} />}
                </Field>
                <Field id="rg-middle" label="Middle Name" error={err('rg-middle')}>
                  {(p) => <TextInput {...p} autoComplete="additional-name" value={d.basic.middleName} onChange={(e) => setBasic({ middleName: e.target.value })} />}
                </Field>
                <Field id="rg-last" label="Last Name" required error={err('rg-last')}>
                  {(p) => <TextInput {...p} autoComplete="family-name" value={d.basic.lastName} onChange={(e) => setBasic({ lastName: e.target.value })} />}
                </Field>
                <Field id="rg-dob" label="Date of Birth" hint="MM/DD/YYYY" required error={err('rg-dob')}>
                  {(p) => <DateInput {...p} autoComplete="bday" value={d.basic.birthDate ?? ''} onValueChange={(v) => setBasic({ birthDate: v })} />}
                </Field>
                <Field id="rg-phone" label="Phone Number" required error={err('rg-phone')}>
                  {(p) => <PhoneInput {...p} value={d.basic.phone ?? ''} onValueChange={(v) => setBasic({ phone: v })} />}
                </Field>
                <Field id="rg-email" label="Email" required error={err('rg-email')}>
                  {(p) => <TextInput {...p} type="email" autoComplete="email" value={d.basic.email} onChange={(e) => setBasic({ email: e.target.value })} />}
                </Field>
                <Field id="rg-address" label="Address Line" required error={err('rg-address')}>
                  {(p) => <TextInput {...p} autoComplete="street-address" value={d.basic.address} onChange={(e) => setBasic({ address: e.target.value })} />}
                </Field>
                <Field id="rg-city" label="City" required error={err('rg-city')}>
                  {(p) => <TextInput {...p} autoComplete="address-level2" value={d.basic.city} onChange={(e) => setBasic({ city: e.target.value })} />}
                </Field>
                <Field id="rg-state" label="State" required error={err('rg-state')}>
                  {(p) => <StateSelect {...p} value={d.basic.state} onChange={(e) => setBasic({ state: e.target.value })} />}
                </Field>
                <Field id="rg-country" label="Country" required>
                  {(p) => <Select {...p} value={d.basic.country} onChange={(e) => setBasic({ country: e.target.value })}>{opts(lists.countries)}</Select>}
                </Field>
                <Field id="rg-zip" label="ZIP Code" required error={err('rg-zip')}>
                  {(p) => <TextInput {...p} inputMode="numeric" autoComplete="postal-code" maxLength={10} value={d.basic.postalCode} onChange={(e) => setBasic({ postalCode: e.target.value })} />}
                </Field>
                <Field id="rg-marital" label="Marital Status" required error={err('rg-marital')}>
                  {(p) => <Select {...p} value={d.basic.maritalStatus} onChange={(e) => setBasic({ maritalStatus: e.target.value })}>{opts(lists.maritalStatuses)}</Select>}
                </Field>
              </Grid>
              <Radios id="rg-sex" legend="Gender" required error={err('rg-sex-female')} value={d.basic.sex} onChange={(v) => setBasic({ sex: v as Basic['sex'] })} options={[['female', 'Female'], ['male', 'Male']]} />
              <Group title="Emergency Contact">
                <Grid>
                  <Field id="rg-ec-first" label="First Name" required error={err('rg-ec-first')}>
                    {(p) => <TextInput {...p} value={d.basic.ec.firstName} onChange={(e) => setEc({ firstName: e.target.value })} />}
                  </Field>
                  <Field id="rg-ec-last" label="Last Name" required error={err('rg-ec-last')}>
                    {(p) => <TextInput {...p} value={d.basic.ec.lastName} onChange={(e) => setEc({ lastName: e.target.value })} />}
                  </Field>
                  <Field id="rg-ec-phone" label="Phone Number" required error={err('rg-ec-phone')}>
                    {(p) => <PhoneInput {...p} autoComplete="off" value={d.basic.ec.phone ?? ''} onValueChange={(v) => setEc({ phone: v })} />}
                  </Field>
                  <Field id="rg-ec-rel" label="Relationship" required error={err('rg-ec-rel')}>
                    {(p) => <Select {...p} value={d.basic.ec.relationship} onChange={(e) => setEc({ relationship: e.target.value })}>{opts(lists.relationships)}</Select>}
                  </Field>
                  <Field id="rg-ec-email" label="Email" error={err('rg-ec-email')}>
                    {(p) => <TextInput {...p} type="email" autoComplete="off" value={d.basic.ec.email} onChange={(e) => setEc({ email: e.target.value })} />}
                  </Field>
                </Grid>
              </Group>
            </>
          ) : null}

          {page === 1 ? (
            <>
              <Grid>
                <Field id="rg-provider" label="Provider">
                  {(p) => (
                    <Select {...p} value={d.choices.providerId} onChange={(e) => setChoices({ providerId: e.target.value })}>
                      <option value="">Select an option</option>
                      {lists.providers.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.displayName}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field id="rg-language" label="Language">
                  {(p) => <Select {...p} value={d.choices.language} onChange={(e) => setChoices({ language: e.target.value })}>{opts(lists.languages)}</Select>}
                </Field>
              </Grid>
              <Radios id="rg-portal" legend="Allow Patient Portal" required error={err('rg-portal-yes')} value={d.choices.allowPortal} onChange={(v) => setChoices({ allowPortal: v as 'yes' | 'no' })} options={YES_NO} />
              <Radios id="rg-sms" legend="Allow SMS" required error={err('rg-sms-yes')} value={d.choices.allowSms} onChange={(v) => setChoices({ allowSms: v as 'yes' | 'no' })} options={YES_NO} />
              <Radios id="rg-allowemail" legend="Allow Email" required error={err('rg-allowemail-yes')} value={d.choices.allowEmail} onChange={(v) => setChoices({ allowEmail: v as 'yes' | 'no' })} options={YES_NO} />
              <Radios
                id="rg-resp"
                legend="Who will be financially responsible for you?"
                required
                error={err('rg-resp-self')}
                value={d.choices.responsibleParty}
                onChange={(v) => setChoices({ responsibleParty: v as Draft['choices']['responsibleParty'] })}
                options={[['self', 'Myself'], ['emergency-contact', 'Same as emergency contact'], ['other', 'Other']]}
              />
              <Radios id="rg-pay" legend="Method of Payment" required error={err('rg-pay-self-pay')} value={d.choices.paymentMethod} onChange={(v) => setChoices({ paymentMethod: v as Draft['choices']['paymentMethod'] })} options={[['self-pay', 'Self pay'], ['insurance', 'Insurance']]} />
              {d.choices.paymentMethod === 'insurance' ? (
                <Group
                  title="Insurance Details"
                  action={
                    <Button variant="ghost" size="sm" icon={<Plus aria-hidden="true" size={16} />} onClick={() => setAdding('insurance')}>
                      Add Insurance
                    </Button>
                  }
                >
                  <Grid>
                    <Field id="rg-ins-company" label="Insurance Company" required error={err('rg-ins-company')}>
                      {(p) => <Select {...p} value={d.choices.insurance.company} onChange={(e) => setIns({ company: e.target.value })}>{opts(insurers)}</Select>}
                    </Field>
                    <Field id="rg-ins-plan" label="Plan Name" required error={err('rg-ins-plan')}>
                      {(p) => <TextInput {...p} value={d.choices.insurance.plan} onChange={(e) => setIns({ plan: e.target.value })} />}
                    </Field>
                    <Field id="rg-ins-policy" label="Policy Number (Member ID)" required error={err('rg-ins-policy')}>
                      {(p) => <TextInput {...p} autoCapitalize="characters" spellCheck={false} value={d.choices.insurance.policyNumber} onChange={(e) => setIns({ policyNumber: e.target.value })} />}
                    </Field>
                    <Field id="rg-ins-group" label="Group Number">
                      {(p) => <TextInput {...p} autoCapitalize="characters" spellCheck={false} value={d.choices.insurance.groupNumber} onChange={(e) => setIns({ groupNumber: e.target.value })} />}
                    </Field>
                    <Field id="rg-ins-city" label="City">
                      {(p) => <TextInput {...p} value={d.choices.insurance.city} onChange={(e) => setIns({ city: e.target.value })} />}
                    </Field>
                    <Field id="rg-ins-state" label="State">
                      {(p) => <StateSelect {...p} autoComplete="off" value={d.choices.insurance.state} onChange={(e) => setIns({ state: e.target.value })} />}
                    </Field>
                    <Field id="rg-ins-country" label="Country">
                      {(p) => <Select {...p} value={d.choices.insurance.country} onChange={(e) => setIns({ country: e.target.value })}>{opts(lists.countries)}</Select>}
                    </Field>
                    <Field id="rg-ins-zip" label="ZIP Code" error={err('rg-ins-zip')}>
                      {(p) => <TextInput {...p} inputMode="numeric" value={d.choices.insurance.postalCode} onChange={(e) => setIns({ postalCode: e.target.value })} />}
                    </Field>
                    <Field id="rg-ins-rel" label="Relationship to policy holder" required error={err('rg-ins-rel')}>
                      {(p) => <Select {...p} value={d.choices.insurance.relationship} onChange={(e) => setIns({ relationship: e.target.value })}>{opts(lists.insuranceRelationships)}</Select>}
                    </Field>
                  </Grid>
                </Group>
              ) : null}
            </>
          ) : null}

          {page === 2 ? (
            <Group
              title="Preferred Pharmacies"
              action={
                <Button variant="ghost" size="sm" icon={<Plus aria-hidden="true" size={16} />} onClick={() => setAdding('pharmacy')}>
                  Add Pharmacy
                </Button>
              }
            >
              <Grid>
                <Field id="rg-ph-name" label="Pharmacy Name">
                  {(p) => <Select {...p} value={d.pharmacy.name} onChange={(e) => setPh({ name: e.target.value })}>{opts(pharmacyNames)}</Select>}
                </Field>
                <Field id="rg-ph-city" label="City">
                  {(p) => <TextInput {...p} value={d.pharmacy.city} onChange={(e) => setPh({ city: e.target.value })} />}
                </Field>
                <Field id="rg-ph-state" label="State">
                  {(p) => <StateSelect {...p} autoComplete="off" value={d.pharmacy.state} onChange={(e) => setPh({ state: e.target.value })} />}
                </Field>
                <Field id="rg-ph-country" label="Country">
                  {(p) => <Select {...p} value={d.pharmacy.country} onChange={(e) => setPh({ country: e.target.value })}>{opts(lists.countries)}</Select>}
                </Field>
                <Field id="rg-ph-zip" label="ZIP Code" error={err('rg-ph-zip')}>
                  {(p) => <TextInput {...p} inputMode="numeric" value={d.pharmacy.postalCode} onChange={(e) => setPh({ postalCode: e.target.value })} />}
                </Field>
              </Grid>
            </Group>
          ) : null}

          {page === 3 ? (
            <>
              <Radios id="rg-takingmeds" legend="Are you taking any medications currently?" required error={err('rg-takingmeds-yes')} value={d.meds.takingMedications} onChange={(v) => setD((x) => ({ ...x, meds: { ...x.meds, takingMedications: v as 'yes' | 'no' } }))} options={YES_NO} />
              {d.meds.takingMedications === 'yes' ? (
                <Field id="rg-meds" label="If yes, please list them here" hint="Name and dose, one per line" required error={err('rg-meds')}>
                  {(p) => <textarea {...p} rows={3} maxLength={1000} className={area} value={d.meds.medications} onChange={(e) => setD((x) => ({ ...x, meds: { ...x.meds, medications: e.target.value } }))} />}
                </Field>
              ) : null}
              <Radios id="rg-hasallergies" legend="Do you have any allergies?" required error={err('rg-hasallergies-yes')} value={d.meds.hasAllergies} onChange={(v) => setD((x) => ({ ...x, meds: { ...x.meds, hasAllergies: v as 'yes' | 'no' } }))} options={YES_NO} />
              {d.meds.hasAllergies === 'yes' ? (
                <Field id="rg-allergies" label="If yes, please list them here with reactions" required error={err('rg-allergies')}>
                  {(p) => <textarea {...p} rows={3} maxLength={1000} className={area} value={d.meds.allergies} onChange={(e) => setD((x) => ({ ...x, meds: { ...x.meds, allergies: e.target.value } }))} />}
                </Field>
              ) : null}
            </>
          ) : null}

          {page === 4 ? (
            <Checks
              legend="Have you had problems with any of these? Tick all that apply."
              options={PAST_HISTORY}
              value={d.pastMedicalHistory}
              onChange={(v) => setD((x) => ({ ...x, pastMedicalHistory: v }))}
            />
          ) : null}

          {page === 5 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[30rem] text-sm">
                  <caption className="mb-2 text-left text-sm text-ink-muted">Tick each relative who has had the condition.</caption>
                  <thead>
                    <tr className="border-b border-border-soft text-xs text-ink-muted">
                      <th scope="col" className="py-2 text-left font-semibold">Condition</th>
                      {RELATIVES.map((r) => (
                        <th key={r} scope="col" className="py-2 text-center font-semibold">{r}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {FAMILY_CONDITIONS.map((c) => (
                      <tr key={c} className="border-b border-border-soft">
                        <th scope="row" className="py-1 text-left font-medium text-ink">{c}</th>
                        {RELATIVES.map((r) => {
                          const on = d.family[c]?.includes(r) ?? false
                          return (
                            <td key={r} className="text-center">
                              <label className="inline-flex size-11 cursor-pointer items-center justify-center">
                                <input
                                  type="checkbox"
                                  className="size-5 accent-primary-600"
                                  aria-label={`${c}: ${r}`}
                                  checked={on}
                                  onChange={(e) =>
                                    setD((x) => {
                                      const cur = x.family[c] ?? []
                                      return { ...x, family: { ...x.family, [c]: e.target.checked ? [...cur, r] : cur.filter((y) => y !== r) } }
                                    })
                                  }
                                />
                              </label>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Field id="rg-family-other" label="If others, please describe">
                {(p) => <textarea {...p} rows={2} maxLength={500} className={area} value={d.familyOther} onChange={(e) => setD((x) => ({ ...x, familyOther: e.target.value }))} />}
              </Field>
            </>
          ) : null}

          {page === 6 ? (
            <>
              <Radios id="rg-tobacco" legend="Tobacco" value={d.social.tobacco} onChange={(v) => setD((x) => ({ ...x, social: { ...x.social, tobacco: v } }))} options={TOBACCO.map((t) => [t, t])} />
              <Radios id="rg-alcohol" legend="Alcohol" value={d.social.alcohol} onChange={(v) => setD((x) => ({ ...x, social: { ...x.social, alcohol: v } }))} options={ALCOHOL.map((t) => [t, t])} />
              <Radios id="rg-drugs" legend="Drug use" value={d.social.drugs} onChange={(v) => setD((x) => ({ ...x, social: { ...x.social, drugs: v } }))} options={DRUGS.map((t) => [t, t])} />
              <Checks legend="Cardiovascular" options={CARDIO} value={d.social.cardiovascular} onChange={(v) => setD((x) => ({ ...x, social: { ...x.social, cardiovascular: v } }))} />
              <Field id="rg-social-other" label="If others, please describe">
                {(p) => <textarea {...p} rows={2} maxLength={500} className={area} value={d.social.other} onChange={(e) => setD((x) => ({ ...x, social: { ...x.social, other: e.target.value } }))} />}
              </Field>
            </>
          ) : null}

          {page === 7 ? (
            <>
              <p className="text-sm text-ink-muted">Enter the date of any surgery you have had. Leave the others empty.</p>
              {SURGERIES.map(([group, items]) => (
                <Group key={group} title={group}>
                  <Grid>
                    {items.map((s) => (
                      <Field key={s} id={`rg-surg-${s.replace(/\W+/g, '-')}`} label={s} hint="MM/DD/YYYY">
                        {(p) => <DateInput {...p} value={d.surgeries[s] ?? ''} onValueChange={(v) => setD((x) => ({ ...x, surgeries: { ...x.surgeries, [s]: v ?? '' } }))} />}
                      </Field>
                    ))}
                  </Grid>
                </Group>
              ))}
              <Field id="rg-surg-other" label="If others, please describe">
                {(p) => <textarea {...p} rows={2} maxLength={500} className={area} value={d.surgeryOther} onChange={(e) => setD((x) => ({ ...x, surgeryOther: e.target.value }))} />}
              </Field>
            </>
          ) : null}

          {page === 8 ? (
            <>
              <p className="text-sm text-ink-muted">Hospital stays or procedures in the past, up to three.</p>
              {d.hospitalizations.map((h, i) => (
                <Group key={i} title={`Visit ${i + 1}`}>
                  <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
                    <Field id={`rg-hosp-date-${i}`} label="Past visit date" hint="MM/DD/YYYY">
                      {(p) => <DateInput {...p} value={h.date} onValueChange={(v) => setD((x) => ({ ...x, hospitalizations: x.hospitalizations.map((y, j) => (j === i ? { ...y, date: v ?? '' } : y)) }))} />}
                    </Field>
                    <Field id={`rg-hosp-notes-${i}`} label="Procedure and notes">
                      {(p) => <textarea {...p} rows={2} maxLength={500} className={area} value={h.notes} onChange={(e) => setD((x) => ({ ...x, hospitalizations: x.hospitalizations.map((y, j) => (j === i ? { ...y, notes: e.target.value } : y)) }))} />}
                    </Field>
                  </div>
                </Group>
              ))}
            </>
          ) : null}

          {page === 9 ? (
            <>
              <section aria-label="Financial policy" className="space-y-3 rounded-lg bg-surface-2 p-4 text-sm leading-relaxed text-ink">
                <p>
                  <strong>Financial policy.</strong> We bill your insurance as a courtesy. If your insurance has not paid within 30 days of the visit, the balance becomes your
                  responsibility. A late charge may apply to balances unpaid after 45 days.
                </p>
                <p>Copays and deductibles are due at the time of the visit. Billing a secondary insurance is your responsibility unless we agree otherwise.</p>
              </section>
              <label className="flex cursor-pointer items-start gap-3 text-sm text-ink">
                <input id="rg-agree" type="checkbox" checked={d.agreed} onChange={(e) => setD((x) => ({ ...x, agreed: e.target.checked }))} className="mt-0.5 size-5 shrink-0 accent-primary-600" aria-invalid={err('rg-agree') ? true : undefined} />
                <span>I agree to the information above.</span>
              </label>
            </>
          ) : null}

          {page === 10 ? <Review d={d} lists={lists} onEdit={goTo} /> : null}

          <div className="flex flex-col-reverse gap-3 border-t border-border-soft pt-5 sm:flex-row sm:justify-between">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => navigate('/sign-in')}>
                Cancel
              </Button>
              {page > 0 ? (
                <Button variant="outline" onClick={() => goTo(page - 1)}>
                  Previous
                </Button>
              ) : null}
            </div>
            <Button type="submit" size="lg" loading={busy}>
              {page === PAGES.length - 1 ? 'Done' : 'Next'}
            </Button>
          </div>
        </form>
      </div>

      {adding ? (
        <AddEntryDialog
          kind={adding}
          onClose={() => setAdding(null)}
          onAdd={(name, place) => {
            if (adding === 'insurance') {
              setExtraInsurers((l) => [...l, name])
              setIns({ company: name, ...place })
            } else {
              setExtraPharmacies((l) => [...l, name])
              setPh({ name, ...place })
            }
            setAdding(null)
          }}
        />
      ) : null}

      <Modal
        open={done}
        title="Registration successful"
        footer={
          <>
            <Button variant="outline" onClick={downloadSummary}>
              Download summary
            </Button>
            <Button onClick={() => navigate('/sign-in')}>OK</Button>
          </>
        }
      >
        <p>All set. The practice will review your registration. After it's approved, your username and password are sent to {d.basic.email}.</p>
        <p className="mt-2">Thank you!</p>
      </Modal>
    </>
  )
}

const YES_NO: Array<[string, string]> = [
  ['yes', 'Yes'],
  ['no', 'No'],
]

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
}

function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border-soft p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Radios({ id, legend, required = false, error, value, onChange, options }: { id: string; legend: string; required?: boolean; error?: string | undefined; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <fieldset className="min-w-0" aria-invalid={error ? true : undefined}>
      <legend className="mb-2 text-sm font-medium text-ink-muted">
        {legend}
        {required ? (
          <span className="ml-1 text-critical-fg">
            <span aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </span>
        ) : null}
      </legend>
      {error ? <p className="mb-2 text-xs font-medium text-critical-fg">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {options.map(([v, label]) => (
          <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 text-sm text-ink has-checked:border-primary-600 has-checked:bg-primary-50">
            <input id={`${id}-${v.replace(/\W+/g, '-')}`} type="radio" name={id} checked={value === v} onChange={() => onChange(v)} className="size-4 accent-primary-600" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function Checks({ legend, options, value, onChange }: { legend: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-ink-muted">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((o) => (
          <label key={o} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 text-sm text-ink has-checked:border-primary-600 has-checked:bg-primary-50">
            <input type="checkbox" checked={value.includes(o)} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} className="size-5 accent-primary-600" />
            {o}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** The old "Add Insurance" / "Add Pharmacy" popups, which now add the entry and select it. */
function AddEntryDialog({ kind, onClose, onAdd }: { kind: 'insurance' | 'pharmacy'; onClose: () => void; onAdd: (name: string, place: { city: string; state: string; postalCode: string }) => void }) {
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [errors, setErrors] = useState<{ name?: string; zip?: string }>({})
  const label = kind === 'insurance' ? 'Insurance Company Name' : 'Pharmacy Name'
  function add(e: FormEvent) {
    e.preventDefault()
    e.stopPropagation()
    const next: typeof errors = {}
    if (!name.trim()) next.name = `Enter the ${kind === 'insurance' ? 'insurance company' : 'pharmacy'} name`
    if (zip.trim() && !isValidZip(zip.trim())) next.zip = 'Enter a valid ZIP code, or leave it empty'
    setErrors(next)
    if (next.name || next.zip) return
    onAdd(name.trim(), { city: city.trim(), state, postalCode: zip.trim() })
  }
  return (
    <Modal
      open
      title={kind === 'insurance' ? 'Add Insurance' : 'Add Pharmacy'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-entry-form">
            OK
          </Button>
        </>
      }
    >
      <form id="add-entry-form" noValidate onSubmit={add} className="space-y-4">
        <Field id="add-name" label={label} required error={errors.name}>
          {(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="add-city" label="City">
            {(p) => <TextInput {...p} value={city} onChange={(e) => setCity(e.target.value)} />}
          </Field>
          <Field id="add-state" label="State">
            {(p) => <StateSelect {...p} autoComplete="off" value={state} onChange={(e) => setState(e.target.value)} />}
          </Field>
          <Field id="add-zip" label="ZIP Code" error={errors.zip}>
            {(p) => <TextInput {...p} inputMode="numeric" value={zip} onChange={(e) => setZip(e.target.value)} />}
          </Field>
        </div>
      </form>
    </Modal>
  )
}

/** The old "Registered Details" review page: every section, each with an Edit link back to its page. */
function Review({ d, lists, onEdit }: { d: Draft; lists: ReferenceLists; onEdit: (page: number) => void }) {
  const b = d.basic
  const c = d.choices
  const yn = (v: string) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '—')
  const sections: Array<{ page: number; title: string; rows: Array<[string, string]> }> = [
    {
      page: 0,
      title: 'Basic Information',
      rows: [
        ['Name', [b.firstName, b.middleName, b.lastName].filter(Boolean).join(' ')],
        ['Date of birth', b.birthDate ? formatDate(b.birthDate) : ''],
        ['Phone', b.phone ? formatPhone(b.phone) : ''],
        ['Email', b.email],
        ['Address', `${b.address}, ${b.city}, ${b.state} ${b.postalCode}, ${b.country}`],
        ['Marital status', b.maritalStatus],
        ['Gender', b.sex === 'female' ? 'Female' : b.sex === 'male' ? 'Male' : ''],
        ['Emergency contact', `${b.ec.firstName} ${b.ec.lastName} (${b.ec.relationship}), ${b.ec.phone ? formatPhone(b.ec.phone) : ''}`],
      ],
    },
    {
      page: 1,
      title: 'Choices',
      rows: [
        ['Provider', lists.providers.find((p) => p.id === c.providerId)?.displayName ?? '—'],
        ['Allow patient portal', yn(c.allowPortal)],
        ['Allow SMS', yn(c.allowSms)],
        ['Allow email', yn(c.allowEmail)],
        ['Language', c.language || '—'],
        ['Financially responsible', { self: 'Myself', 'emergency-contact': 'Same as emergency contact', other: 'Other', '': '—' }[c.responsibleParty]],
        ['Method of payment', c.paymentMethod === 'insurance' ? `Insurance: ${c.insurance.company}, ${c.insurance.plan}, policy ${c.insurance.policyNumber}` : 'Self pay'],
      ],
    },
    { page: 2, title: 'Preferred Pharmacy', rows: [['Pharmacy', [d.pharmacy.name, d.pharmacy.city, d.pharmacy.state].filter(Boolean).join(', ') || '—']] },
    {
      page: 3,
      title: 'Medication and Allergy',
      rows: [
        ['Medications', d.meds.takingMedications === 'yes' ? d.meds.medications : yn(d.meds.takingMedications)],
        ['Allergies', d.meds.hasAllergies === 'yes' ? d.meds.allergies : yn(d.meds.hasAllergies)],
      ],
    },
    { page: 4, title: 'Past Medical History', rows: [['Problems', d.pastMedicalHistory.join(', ') || 'None']] },
    {
      page: 5,
      title: 'Family History',
      rows: [
        ...Object.entries(d.family)
          .filter(([, rel]) => rel.length)
          .map(([cond, rel]) => [cond, rel.join(', ')] as [string, string]),
        ...(d.familyOther ? [['Other', d.familyOther] as [string, string]] : []),
      ],
    },
    {
      page: 6,
      title: 'Social History',
      rows: [
        ['Tobacco', d.social.tobacco || '—'],
        ['Alcohol', d.social.alcohol || '—'],
        ['Drug use', d.social.drugs || '—'],
        ['Cardiovascular', d.social.cardiovascular.join(', ') || '—'],
      ],
    },
    {
      page: 7,
      title: 'Surgical History',
      rows: [
        ...Object.entries(d.surgeries)
          .filter(([, v]) => v)
          .map(([s, v]) => [s, formatDate(v)] as [string, string]),
        ...(d.surgeryOther ? [['Other', d.surgeryOther] as [string, string]] : []),
      ],
    },
    {
      page: 8,
      title: 'Hospitalization/Procedure',
      rows: d.hospitalizations.filter((h) => h.date || h.notes).map((h, i) => [`Visit ${i + 1}`, `${h.date ? formatDate(h.date) : ''} ${h.notes}`.trim()] as [string, string]),
    },
  ]
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">Please check that the information is correct, then select Done.</p>
      {sections.map((s) => (
        <section key={s.title} aria-label={s.title} className="rounded-lg border border-border-soft p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
            <Button variant="ghost" size="sm" onClick={() => onEdit(s.page)} aria-label={`Edit ${s.title}`}>
              Edit
            </Button>
          </div>
          {s.rows.length ? (
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
              {s.rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-subtle">{k}</dt>
                  <dd className="text-ink">{v || '—'}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-ink-muted">Nothing entered.</p>
          )}
        </section>
      ))}
    </div>
  )
}
