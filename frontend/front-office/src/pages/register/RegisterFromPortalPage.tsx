// Register Patient, converted from the Angular patient portal's registration wizard
// (patientportal_frontend_Feb16, src/app/registration; Minalini's exception of 2026-11-03).
// Same pages, sections, fields and wording, in the same order, drawn with care-entry's own
// components and tokens. Stage 1 is on the API (shri-health/registration.ts); the rest keeps
// its fields with a TODO (frontend/docs/SCREEN_PORT.md, "Registration from the patient portal").
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil, Plus, UserPlus } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { Avatar } from '../../components/ui/Avatar'
import { Modal } from '../../components/ui/Modal'
import { StepRail, SummaryItem } from '../../components/flow/Quadrant'
import { initialsOf } from '../../utils/format'
import { revealFirstInvalid } from '../../utils/revealInvalid'
import { Checkbox, CheckboxList, FieldGrid, RadioField, SelectField, TextAreaField, TextField } from './fields'
import {
  ALCOHOL,
  CARDIOVASCULAR,
  COUNTRIES,
  DRUG_ABUSE,
  FAMILY_DISEASES,
  FAMILY_MEMBERS,
  GUARDIAN_RELATIONS,
  LANGUAGES,
  MARITAL_STATUSES,
  MEDICAL_HISTORIES,
  MOCK_PHARMACIES,
  SUBSCRIBER_RELATIONSHIPS,
  SURGERIES_FEMALE,
  SURGERIES_GENERAL,
  SURGERIES_MALE,
  TOBACCO,
  US_STATES,
  addInfoErrors,
  basicInfoErrors,
  choicesErrors,
  emptyRegistration,
  formatUsPhone,
  hasErrors,
  loadPayers,
  loadProviders,
  newSubmission,
  notesError,
  submitRegistration,
  todayIso,
} from '../../../shri-health/registration'
import type { Option, RegistrationForm, Submission } from '../../../shri-health/registration'
import { loadCandidates } from '../../../shri-health/patients'
import { problemMessage } from '../../../shri-health/client'
import type { Patient } from '../../types/patient'

/** The wizard's pages, as titled in Angular. */
const PAGES = [
  'Basic Information',
  'Choices',
  'Additional Information',
  'Medication and Allergy',
  'Past Medical History',
  'Family History',
  'Social Medical History',
  'Surgical History',
  'Hospitalization/Procedure',
  'Consent Forms',
  'Registered Details',
] as const
const REVIEW = PAGES.length - 1

type Group = Exclude<keyof RegistrationForm, 'consent'>

const STEP_LABEL: Record<'patient' | 'contact' | 'coverage', string> = {
  patient: 'The patient was not registered',
  contact: 'The patient is registered, but the emergency contact was not saved',
  coverage: 'The patient is registered, but the insurance was not saved',
}

export function RegisterFromPortalPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState<RegistrationForm>(emptyRegistration)
  const [page, setPage] = useState(0)
  const [visited, setVisited] = useState(0)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [attempted, setAttempted] = useState<Record<number, boolean>>({})
  const [insuranceModal, setInsuranceModal] = useState(false)
  const [pharmacyModal, setPharmacyModal] = useState(false)

  const [payers, setPayers] = useState<Option[]>([])
  const [payersError, setPayersError] = useState<string | null>(null)
  const [providers, setProviders] = useState<Option[]>([])

  const [submission, setSubmission] = useState<Submission>(newSubmission)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<Patient[]>([])
  const [allSet, setAllSet] = useState(false)
  // A `409 possible-duplicate`: the candidates, and the desk's reason if it registers anyway.
  const [duplicateFound, setDuplicateFound] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideTried, setOverrideTried] = useState(false)

  useEffect(() => {
    let live = true
    loadPayers()
      .then((list) => live && setPayers(list))
      .catch((error: unknown) => live && setPayersError(problemMessage(error)))
    // The Provider select: sent as generalPractitionerId once #225 merges (TODO(#225)); left out until then.
    loadProviders()
      .then((list) => live && setProviders(list))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const today = todayIso()
  const errors = {
    basicInfo: basicInfoErrors(form.basicInfo, today),
    choicesForm: choicesErrors(form.choicesForm),
    AddInfo: addInfoErrors(form.AddInfo),
    medicationForm: {
      medicationInfo: notesError(form.medicationForm.medicationInfo, 'Invalid MedicationInfo'),
      allergiesInfo: notesError(form.medicationForm.allergiesInfo, 'Invalid AllergiesInfo'),
    },
    familyHistoryForm: { familyHistoryInfo: notesError(form.familyHistoryForm.familyHistoryInfo, 'Invalid family HistoryInfo') },
    socialHistoryForm: {
      socialMedicalHistoryInfo: notesError(form.socialHistoryForm.socialMedicalHistoryInfo, 'Invalid socialMedicalHistory Info'),
    },
    SurgicalHistory: { IfOthers: notesError(form.SurgicalHistory.IfOthers, 'Invalid SurgicalHistory Info') },
    Hospitalization: {
      Notes1: notesError(form.Hospitalization.Notes1, 'Invalid Notes1'),
      Notes2: notesError(form.Hospitalization.Notes2, 'Invalid Notes2'),
      Notes3: notesError(form.Hospitalization.Notes3, 'Invalid Notes3'),
    },
  }
  // The page whose form group must be valid before Next (Angular's clrWizardPageNextDisabled).
  const PAGE_ERRORS: Record<number, Record<string, string | undefined>> = {
    0: errors.basicInfo,
    1: errors.choicesForm,
    2: errors.AddInfo,
    3: errors.medicationForm,
    5: errors.familyHistoryForm,
    6: errors.socialHistoryForm,
    7: errors.SurgicalHistory,
    8: errors.Hospitalization,
  }

  function set<G extends Group, K extends keyof RegistrationForm[G]>(group: G, key: K, value: RegistrationForm[G][K]) {
    setForm((current) => ({ ...current, [group]: { ...current[group], [key]: value } }))
    setSubmitError(null)
  }

  /** A field's message: once it has been left, or Next was tried on its page. */
  function shown<G extends keyof typeof errors>(group: G, key: keyof (typeof errors)[G] & string): string | undefined {
    const message = (errors[group] as Record<string, string | undefined>)[key]
    return touched[`${group}.${key}`] || attempted[page] ? message : undefined
  }
  const touch = (group: string, key: string) => () => setTouched((current) => ({ ...current, [`${group}.${key}`]: true }))

  function go(next: number) {
    setPage(next)
    setVisited((current) => Math.max(current, next))
    window.scrollTo({ top: 0 })
  }

  function onNext() {
    if (hasErrors(PAGE_ERRORS[page] ?? {})) {
      setAttempted((current) => ({ ...current, [page]: true }))
      revealFirstInvalid()
      return
    }
    go(page + 1)
  }

  async function onDone(override?: string) {
    // The Basic Information page is what the server needs (name, date of birth: D44).
    if (hasErrors(errors.basicInfo)) {
      setAttempted((current) => ({ ...current, 0: true }))
      go(0)
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    const result = await submitRegistration(form, submission, override)
    setSubmission(result.submission)
    setSubmitting(false)
    if (result.kind === 'done') {
      setDuplicateFound(false)
      setDuplicates([])
      setAllSet(true)
    } else if (result.kind === 'duplicate') {
      setDuplicateFound(true)
      setDuplicates(await loadCandidates(result.candidateIds).catch(() => []))
    } else {
      setSubmitError(`${STEP_LABEL[result.step]}: ${problemMessage(result.error)}`)
    }
  }

  function onRegisterAnyway() {
    setOverrideTried(true)
    if (!overrideReason.trim()) {
      revealFirstInvalid()
      return
    }
    void onDone(overrideReason)
  }

  const b = form.basicInfo
  const c = form.choicesForm
  const a = form.AddInfo
  const m = form.medicationForm

  const rail = PAGES.map((label, index) => ({ label, target: 'register-page', done: index < visited && index !== page, current: index === page }))

  return (
    <div>
      <PageHeader title="Registration Form" />

      {/* A step opens on click once it has been reached (Clarity's wizard navigation). */}
      <div
        className="mt-4 sm:mt-5"
        onClickCapture={(event) => {
          const item = (event.target as HTMLElement).closest('li')
          if (!item?.parentElement) return
          const index = Array.from(item.parentElement.children).indexOf(item)
          if (index >= 0 && index <= visited) go(index)
        }}
      >
        <StepRail steps={rail} />
      </div>

      <div id="register-page" className="mt-2 flex flex-col gap-6">
        {page === 0 ? (
          <>
            <Section title="Demographics" icon={UserPlus}>
              <FieldGrid>
                <TextField id="reg-firstName" name="firstName" label="First Name" required value={b.firstName} onChange={(v) => set('basicInfo', 'firstName', v)} onBlur={touch('basicInfo', 'firstName')} error={shown('basicInfo', 'firstName')} maxLength={100} />
                <TextField id="reg-middleName" name="middleName" label="Middle Name" value={b.middleName} onChange={(v) => set('basicInfo', 'middleName', v)} onBlur={touch('basicInfo', 'middleName')} error={shown('basicInfo', 'middleName')} maxLength={100} />
                <TextField id="reg-lastName" name="lastName" label="Last Name" required value={b.lastName} onChange={(v) => set('basicInfo', 'lastName', v)} onBlur={touch('basicInfo', 'lastName')} error={shown('basicInfo', 'lastName')} maxLength={100} />
                <TextField id="reg-date" name="date" type="date" label="DOB" required max={today} value={b.date} onChange={(v) => set('basicInfo', 'date', v)} onBlur={touch('basicInfo', 'date')} error={shown('basicInfo', 'date')} />
                <TextField id="reg-phoneNo" name="phoneNo" type="tel" inputMode="tel" label="Phone No" required value={b.phoneNo} onChange={(v) => set('basicInfo', 'phoneNo', formatUsPhone(v))} onBlur={touch('basicInfo', 'phoneNo')} error={shown('basicInfo', 'phoneNo')} />
                <TextField id="reg-address" name="address" label="Address Line" required value={b.address} onChange={(v) => set('basicInfo', 'address', v)} onBlur={touch('basicInfo', 'address')} error={shown('basicInfo', 'address')} maxLength={100} />
                <TextField id="reg-city" name="city" label="City" required value={b.city} onChange={(v) => set('basicInfo', 'city', v)} onBlur={touch('basicInfo', 'city')} error={shown('basicInfo', 'city')} maxLength={60} />
                <SelectField id="reg-state" name="state" label="State" required placeholder="Select State" options={US_STATES} value={b.state} onChange={(v) => set('basicInfo', 'state', v)} onBlur={touch('basicInfo', 'state')} error={shown('basicInfo', 'state')} />
                <SelectField id="reg-country" name="country" label="Country" required placeholder="Select Country" options={COUNTRIES} value={b.country} onChange={(v) => set('basicInfo', 'country', v)} onBlur={touch('basicInfo', 'country')} error={shown('basicInfo', 'country')} />
                <TextField id="reg-zip" name="zip" inputMode="numeric" label="ZIP" required value={b.zip} onChange={(v) => set('basicInfo', 'zip', v)} onBlur={touch('basicInfo', 'zip')} error={shown('basicInfo', 'zip')} maxLength={10} />
                <SelectField id="reg-maritalStatus" name="maritalStatus" label="Marital Status" placeholder="Select Marital Status" options={MARITAL_STATUSES} value={b.maritalStatus} onChange={(v) => set('basicInfo', 'maritalStatus', v)} onBlur={touch('basicInfo', 'maritalStatus')} error={shown('basicInfo', 'maritalStatus')} />
                <RadioField id="reg-gender" name="gender" label="Gender" required options={['Male', 'Female']} value={b.gender} onChange={(v) => set('basicInfo', 'gender', v)} error={shown('basicInfo', 'gender')} />
                <TextField id="reg-email" name="email" type="email" inputMode="email" label="Email" value={b.email} onChange={(v) => set('basicInfo', 'email', v)} onBlur={touch('basicInfo', 'email')} error={shown('basicInfo', 'email')} maxLength={254} />
              </FieldGrid>
            </Section>
            <Section title="Emergency Contact">
              <FieldGrid>
                <TextField id="reg-relationFirstname" name="relationFirstname" label="First Name" required value={b.relationFirstname} onChange={(v) => set('basicInfo', 'relationFirstname', v)} onBlur={touch('basicInfo', 'relationFirstname')} error={shown('basicInfo', 'relationFirstname')} maxLength={100} />
                <TextField id="reg-relationLastname" name="relationLastname" label="Last Name" required value={b.relationLastname} onChange={(v) => set('basicInfo', 'relationLastname', v)} onBlur={touch('basicInfo', 'relationLastname')} error={shown('basicInfo', 'relationLastname')} maxLength={100} />
                <TextField id="reg-relationPhoneno" name="relationPhoneno" type="tel" inputMode="tel" label="Phone Number" required value={b.relationPhoneno} onChange={(v) => set('basicInfo', 'relationPhoneno', formatUsPhone(v))} onBlur={touch('basicInfo', 'relationPhoneno')} error={shown('basicInfo', 'relationPhoneno')} />
                <SelectField id="reg-relation" name="relation" label="Relation ship" required placeholder="Select Guardian Relationship" options={GUARDIAN_RELATIONS} value={b.relation} onChange={(v) => set('basicInfo', 'relation', v)} onBlur={touch('basicInfo', 'relation')} error={shown('basicInfo', 'relation')} />
                <TextField id="reg-relationEmail" name="relationEmail" type="email" inputMode="email" label="Email" value={b.relationEmail} onChange={(v) => set('basicInfo', 'relationEmail', v)} onBlur={touch('basicInfo', 'relationEmail')} error={shown('basicInfo', 'relationEmail')} maxLength={254} />
              </FieldGrid>
            </Section>
          </>
        ) : null}

        {page === 1 ? (
          <>
            <Section title="Choices">
              <FieldGrid>
                {/* TODO(#225): listed from GET /booking/providers; sent as generalPractitionerId once #225 merges. */}
                <SelectField id="reg-provider" name="provider" label="Provider" placeholder="Select Provider" options={providers} value={c.provider} onChange={(v) => set('choicesForm', 'provider', v)} />
                {/* TODO(stage 1 gap): a portal invitation needs the photo-ID check at the desk; shown, not sent. */}
                <RadioField id="reg-AllowPatientPortal" name="AllowPatientPortal" label="Allow Patient Portal" required options={['Yes', 'No']} value={c.AllowPatientPortal} onChange={(v) => set('choicesForm', 'AllowPatientPortal', v)} />
                <RadioField id="reg-AllowSMS" name="AllowSMS" label="Allow SMS" required options={['Yes', 'No']} value={c.AllowSMS} onChange={(v) => set('choicesForm', 'AllowSMS', v)} />
                {/* TODO(stage 1 gap): the contract has no email preference; shown, not sent. */}
                <RadioField id="reg-AllowEmail" name="AllowEmail" label="Allow Email" required options={['Yes', 'No']} value={c.AllowEmail} onChange={(v) => set('choicesForm', 'AllowEmail', v)} />
                <SelectField id="reg-Language" name="Language" label="Language" placeholder="Select Language" options={LANGUAGES} value={c.Language} onChange={(v) => set('choicesForm', 'Language', v)} />
              </FieldGrid>
            </Section>
            <Section title="Responsible party">
              {/* TODO(stage 1 gap): "Other" has no fields for who; only "Same as Emergency Contact" is sent (GUAR). */}
              <RadioField id="reg-ResponsibleParty" name="ResponsibleParty" label="Who will be financially responsible for you" options={['Myself', 'Same as Emergency Contact', 'Other']} value={c.ResponsibleParty} onChange={(v) => set('choicesForm', 'ResponsibleParty', v)} />
            </Section>
            <Section title="Method of Payment">
              {/* TODO(stage 2): mock — the contract has no payment-method field at registration. */}
              <RadioField id="reg-payMethod" name="payMethod" label="What will be your method of payment" options={['Self Pay', 'Insurance']} value={c.payMethod} onChange={(v) => set('choicesForm', 'payMethod', v)} />
            </Section>
            <Section
              title="Insurance Details"
              action={
                <Button type="button" size="sm" variant="secondary" onClick={() => setInsuranceModal(true)}>
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  Add Insurance
                </Button>
              }
            >
              {payersError ? (
                <Alert tone="warning" className="mb-4">
                  Insurance companies could not be loaded. {payersError}
                </Alert>
              ) : null}
              <FieldGrid>
                <SelectField id="reg-insuranceCompany" name="insuranceCompany" label="Insurance Company" placeholder="Select Company" options={payers} value={c.insuranceCompany} onChange={(v) => set('choicesForm', 'insuranceCompany', v)} />
                <TextField id="reg-planName" name="planName" label="Plan Name" value={c.planName} onChange={(v) => set('choicesForm', 'planName', v)} onBlur={touch('choicesForm', 'planName')} error={shown('choicesForm', 'planName')} maxLength={200} />
                <TextField id="reg-policyNumber" name="policyNumber" label="Policy Number" value={c.policyNumber} onChange={(v) => set('choicesForm', 'policyNumber', v)} onBlur={touch('choicesForm', 'policyNumber')} error={shown('choicesForm', 'policyNumber')} maxLength={200} />
                <TextField id="reg-groupNumber" name="groupNumber" label="Group Number" value={c.groupNumber} onChange={(v) => set('choicesForm', 'groupNumber', v)} onBlur={touch('choicesForm', 'groupNumber')} error={shown('choicesForm', 'groupNumber')} maxLength={80} />
                {/* TODO(stage 1 gap): a coverage has no City/State/Country/Zip; shown, not sent. */}
                <TextField id="reg-ins-City" name="City" label="City" value={c.City} onChange={(v) => set('choicesForm', 'City', v)} onBlur={touch('choicesForm', 'City')} error={shown('choicesForm', 'City')} maxLength={60} />
                <SelectField id="reg-ins-State" name="State" label="State" placeholder="Select State" options={US_STATES} value={c.State} onChange={(v) => set('choicesForm', 'State', v)} />
                <SelectField id="reg-ins-Country" name="Country" label="Country" placeholder="Select Country" options={COUNTRIES} value={c.Country} onChange={(v) => set('choicesForm', 'Country', v)} />
                <TextField id="reg-ins-Zip" name="Zip" inputMode="numeric" label="Zip" value={c.Zip} onChange={(v) => set('choicesForm', 'Zip', v)} onBlur={touch('choicesForm', 'Zip')} error={shown('choicesForm', 'Zip')} maxLength={10} />
                <SelectField id="reg-relationship" name="relationship" label="Relationship" placeholder="Select Relationship" options={SUBSCRIBER_RELATIONSHIPS} value={c.relationship} onChange={(v) => set('choicesForm', 'relationship', v)} />
              </FieldGrid>
            </Section>
            {/* TODO(stage 1 gap): no way to create a payer from the desk (payers are set up by the platform, D48); kept, not sent. */}
            <Modal
              open={insuranceModal}
              onClose={() => setInsuranceModal(false)}
              title="Add Insurance"
              className="max-w-3xl"
              footer={
                <>
                  <Button type="button" variant="outline" onClick={() => setInsuranceModal(false)}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={() => setInsuranceModal(false)}>
                    Ok
                  </Button>
                </>
              }
            >
              <FieldGrid columns="sm:grid-cols-2">
                <TextField id="reg-newInsuranceCompany" name="newInsuranceCompany" label="Insurance Company Name" value={c.newInsuranceCompany} onChange={(v) => set('choicesForm', 'newInsuranceCompany', v)} onBlur={touch('choicesForm', 'newInsuranceCompany')} error={shown('choicesForm', 'newInsuranceCompany')} maxLength={200} />
                <TextField id="reg-newInsuranceCity" name="newInsuranceCity" label="City" value={c.newInsuranceCity} onChange={(v) => set('choicesForm', 'newInsuranceCity', v)} onBlur={touch('choicesForm', 'newInsuranceCity')} error={shown('choicesForm', 'newInsuranceCity')} maxLength={60} />
                <SelectField id="reg-newInsuranceState" name="newInsuranceState" label="State" placeholder="Select State" options={US_STATES} value={c.newInsuranceState} onChange={(v) => set('choicesForm', 'newInsuranceState', v)} />
                <SelectField id="reg-newInsuranceCountry" name="newInsuranceCountry" label="Country" placeholder="Select Country" options={COUNTRIES} value={c.newInsuranceCountry} onChange={(v) => set('choicesForm', 'newInsuranceCountry', v)} />
                <TextField id="reg-newInsuranceZip" name="newInsuranceZip" inputMode="numeric" label="Zip" value={c.newInsuranceZip} onChange={(v) => set('choicesForm', 'newInsuranceZip', v)} onBlur={touch('choicesForm', 'newInsuranceZip')} error={shown('choicesForm', 'newInsuranceZip')} maxLength={10} />
                <TextField id="reg-newInsurancePlanName" name="newInsurancePlanName" label="Plan Name" value={c.newInsurancePlanName} onChange={(v) => set('choicesForm', 'newInsurancePlanName', v)} onBlur={touch('choicesForm', 'newInsurancePlanName')} error={shown('choicesForm', 'newInsurancePlanName')} maxLength={200} />
                <TextField id="reg-newInsurancePolicyNumber" name="newInsurancePolicyNumber" label="Policy Number" value={c.newInsurancePolicyNumber} onChange={(v) => set('choicesForm', 'newInsurancePolicyNumber', v)} onBlur={touch('choicesForm', 'newInsurancePolicyNumber')} error={shown('choicesForm', 'newInsurancePolicyNumber')} maxLength={200} />
                <TextField id="reg-newInsuranceGroupNumber" name="newInsuranceGroupNumber" label="Group Number" value={c.newInsuranceGroupNumber} onChange={(v) => set('choicesForm', 'newInsuranceGroupNumber', v)} onBlur={touch('choicesForm', 'newInsuranceGroupNumber')} error={shown('choicesForm', 'newInsuranceGroupNumber')} maxLength={80} />
              </FieldGrid>
            </Modal>
          </>
        ) : null}

        {page === 2 ? (
          <>
            {/* TODO(stage 2): mock — no pharmacy directory read for the desk yet (SCREEN_PORT gaps 12, 31). */}
            <Section
              title="Preferred Pharmacies"
              action={
                <Button type="button" size="sm" variant="secondary" onClick={() => setPharmacyModal(true)}>
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  Add Pharmacy
                </Button>
              }
            >
              <FieldGrid>
                <SelectField id="reg-pharmacyName" name="pharmacyName" label="Pharmacy Name" placeholder="Select PharmacyName" options={MOCK_PHARMACIES} value={a.pharmacyName} onChange={(v) => set('AddInfo', 'pharmacyName', v)} />
                <TextField id="reg-ph-City" name="City" label="City" value={a.City} onChange={(v) => set('AddInfo', 'City', v)} onBlur={touch('AddInfo', 'City')} error={shown('AddInfo', 'City')} maxLength={60} />
                <SelectField id="reg-ph-State" name="State" label="State" placeholder="Select State" options={US_STATES} value={a.State} onChange={(v) => set('AddInfo', 'State', v)} />
                <SelectField id="reg-ph-Country" name="Country" label="Country" placeholder="Select Country" options={COUNTRIES} value={a.Country} onChange={(v) => set('AddInfo', 'Country', v)} />
                <TextField id="reg-ph-Zip" name="Zip" inputMode="numeric" label="Zip" value={a.Zip} onChange={(v) => set('AddInfo', 'Zip', v)} onBlur={touch('AddInfo', 'Zip')} error={shown('AddInfo', 'Zip')} maxLength={10} />
              </FieldGrid>
            </Section>
            {/* TODO(stage 2): mock — adding a pharmacy needs a contract read and write. */}
            <Modal
              open={pharmacyModal}
              onClose={() => setPharmacyModal(false)}
              title="Add Pharmacy"
              className="max-w-3xl"
              footer={
                <>
                  <Button type="button" variant="outline" onClick={() => setPharmacyModal(false)}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={() => setPharmacyModal(false)}>
                    Ok
                  </Button>
                </>
              }
            >
              <FieldGrid columns="sm:grid-cols-2">
                <TextField id="reg-newPharmacyName" name="newPharmacyName" label="Pharmacy Name" value={a.newPharmacyName} onChange={(v) => set('AddInfo', 'newPharmacyName', v)} onBlur={touch('AddInfo', 'newPharmacyName')} error={shown('AddInfo', 'newPharmacyName')} maxLength={200} />
                <TextField id="reg-newPharmacyCity" name="newPharmacyCity" label="City" value={a.newPharmacyCity} onChange={(v) => set('AddInfo', 'newPharmacyCity', v)} onBlur={touch('AddInfo', 'newPharmacyCity')} error={shown('AddInfo', 'newPharmacyCity')} maxLength={60} />
                <SelectField id="reg-newPharmacyState" name="newPharmacyState" label="State" placeholder="Select State" options={US_STATES} value={a.newPharmacyState} onChange={(v) => set('AddInfo', 'newPharmacyState', v)} />
                <SelectField id="reg-newPharmacyCountry" name="newPharmacyCountry" label="Country" placeholder="Select Country" options={COUNTRIES} value={a.newPharmacyCountry} onChange={(v) => set('AddInfo', 'newPharmacyCountry', v)} />
                <TextField id="reg-newPharmacyZip" name="newPharmacyZip" inputMode="numeric" label="Zip" value={a.newPharmacyZip} onChange={(v) => set('AddInfo', 'newPharmacyZip', v)} onBlur={touch('AddInfo', 'newPharmacyZip')} error={shown('AddInfo', 'newPharmacyZip')} maxLength={10} />
              </FieldGrid>
            </Modal>
          </>
        ) : null}

        {page === 3 ? (
          // TODO(stage 2): mock — medications and allergies as typed text have no registration field.
          <Section title="Current Medications">
            <div className="flex flex-col gap-4">
              <RadioField id="reg-medication" name="medication" label="Taking any Medications Currently" required options={['Yes', 'No']} value={m.medication} onChange={(v) => set('medicationForm', 'medication', v)} />
              <TextAreaField id="reg-medicationInfo" name="medicationInfo" label="If Yes Please List out here" value={m.medicationInfo} onChange={(v) => set('medicationForm', 'medicationInfo', v)} onBlur={touch('medicationForm', 'medicationInfo')} error={shown('medicationForm', 'medicationInfo')} />
              <RadioField id="reg-allergies" name="allergies" label="Having any Allergies" required options={['Yes', 'No']} value={m.allergies} onChange={(v) => set('medicationForm', 'allergies', v)} />
              <TextAreaField id="reg-allergiesInfo" name="allergiesInfo" label="If Yes Please List out here" value={m.allergiesInfo} onChange={(v) => set('medicationForm', 'allergiesInfo', v)} onBlur={touch('medicationForm', 'allergiesInfo')} error={shown('medicationForm', 'allergiesInfo')} />
            </div>
          </Section>
        ) : null}

        {page === 4 ? (
          // TODO(stage 2): mock — past medical history needs coded Conditions.
          <Section title="Select any Medical Histories You Experienced">
            <CheckboxList id="reg-medicalHistory" options={MEDICAL_HISTORIES} selected={form.medicalHistoryForm.selectedMedicalHistory} onChange={(next) => set('medicalHistoryForm', 'selectedMedicalHistory', next)} />
          </Section>
        ) : null}

        {page === 5 ? (
          // TODO(stage 2): mock — family history needs FamilyMemberHistory.
          <Section title="Select Any Family Medical history You Experienced">
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold text-ink-muted">
                      <th className="py-2 pr-3 font-semibold" />
                      {FAMILY_MEMBERS.map((member) => (
                        <th key={member} className="px-2 py-2 text-center font-semibold">
                          {member}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-soft">
                    {FAMILY_DISEASES.map(({ key, label }) => (
                      <tr key={key}>
                        <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink">
                          {label}
                        </th>
                        {FAMILY_MEMBERS.map((member) => {
                          const selected = form.familyHistoryForm[key]
                          return (
                            <td key={member} className="px-2 py-2.5 text-center">
                              <input
                                type="checkbox"
                                value={member}
                                aria-label={`${label}: ${member}`}
                                checked={selected.includes(member)}
                                onChange={(event) => set('familyHistoryForm', key, event.target.checked ? [...selected, member] : selected.filter((v) => v !== member))}
                                className="h-5 w-5 accent-[var(--color-primary-600)]"
                              />
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TextAreaField id="reg-familyHistoryInfo" name="familyHistoryInfo" label="If Others" value={form.familyHistoryForm.familyHistoryInfo} onChange={(v) => set('familyHistoryForm', 'familyHistoryInfo', v)} onBlur={touch('familyHistoryForm', 'familyHistoryInfo')} error={shown('familyHistoryForm', 'familyHistoryInfo')} />
            </div>
          </Section>
        ) : null}

        {page === 6 ? (
          // TODO(stage 2): mock — social history needs Observations (tobacco, alcohol).
          <Section title="Social History">
            <div className="flex flex-col gap-5">
              <SubHeading title="Tobacco">
                <CheckboxList id="reg-tobacco" options={TOBACCO} selected={form.socialHistoryForm.selectedtobaccoHistory} onChange={(next) => set('socialHistoryForm', 'selectedtobaccoHistory', next)} />
              </SubHeading>
              <SubHeading title="Alcohol">
                <CheckboxList id="reg-alcohol" options={ALCOHOL} selected={form.socialHistoryForm.selectedalcoholHistory} onChange={(next) => set('socialHistoryForm', 'selectedalcoholHistory', next)} />
              </SubHeading>
              <SubHeading title="Drug Abuse">
                <CheckboxList id="reg-drugAbuse" options={DRUG_ABUSE} selected={form.socialHistoryForm.selectedDrugAbuse} onChange={(next) => set('socialHistoryForm', 'selectedDrugAbuse', next)} />
              </SubHeading>
              <SubHeading title="Cardio-vascular">
                <CheckboxList id="reg-cardiovascular" options={CARDIOVASCULAR} selected={form.socialHistoryForm.selectedCardioVascular} onChange={(next) => set('socialHistoryForm', 'selectedCardioVascular', next)} />
              </SubHeading>
              <TextAreaField id="reg-socialMedicalHistoryInfo" name="socialMedicalHistoryInfo" label="If Others" value={form.socialHistoryForm.socialMedicalHistoryInfo} onChange={(v) => set('socialHistoryForm', 'socialMedicalHistoryInfo', v)} onBlur={touch('socialHistoryForm', 'socialMedicalHistoryInfo')} error={shown('socialHistoryForm', 'socialMedicalHistoryInfo')} />
            </div>
          </Section>
        ) : null}

        {page === 7 ? (
          // TODO(stage 2): mock — surgical history needs Procedures.
          <Section title="Select Any Surgical Histories You Experienced">
            <div className="flex flex-col gap-5">
              <SurgeryList title={['Surgery', 'Year']} surgeries={SURGERIES_GENERAL} form={form} today={today} onChange={(key, v) => set('SurgicalHistory', key, v)} />
              <SubHeading title="Surgery And Year [Male Only]">
                <SurgeryList title={['Male Only', 'Year']} surgeries={SURGERIES_MALE} form={form} today={today} onChange={(key, v) => set('SurgicalHistory', key, v)} />
              </SubHeading>
              <SubHeading title="Surgery And Year [Female Only]">
                <SurgeryList title={['Female Only', 'Year']} surgeries={SURGERIES_FEMALE} form={form} today={today} onChange={(key, v) => set('SurgicalHistory', key, v)} />
              </SubHeading>
              <TextAreaField id="reg-IfOthers" name="IfOthers" label="If Others" value={form.SurgicalHistory.IfOthers} onChange={(v) => set('SurgicalHistory', 'IfOthers', v)} onBlur={touch('SurgicalHistory', 'IfOthers')} error={shown('SurgicalHistory', 'IfOthers')} />
            </div>
          </Section>
        ) : null}

        {page === 8 ? (
          // TODO(stage 2): mock — past visits and procedures need Encounters or Procedures.
          <Section title="Fill In Any Of The Past Visit And Procedures Undergone">
            <div className="flex flex-col gap-4">
              {([1, 2, 3] as const).map((n) => (
                <div key={n} className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
                  <TextField id={`reg-PastVisit${n}`} name={`PastVisit${n}`} type="date" label="Past Visit Date" max={today} value={form.Hospitalization[`PastVisit${n}`]} onChange={(v) => set('Hospitalization', `PastVisit${n}`, v)} />
                  <TextAreaField id={`reg-Notes${n}`} name={`Notes${n}`} label="Procedure and Notes" value={form.Hospitalization[`Notes${n}`]} onChange={(v) => set('Hospitalization', `Notes${n}`, v)} onBlur={touch('Hospitalization', `Notes${n}`)} error={shown('Hospitalization', `Notes${n}`)} />
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {page === 9 ? (
          // TODO(stage 2): mock — agreeing is not recorded; needs recordConsent and a consent requirement.
          <Section title="Financial Policy">
            <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink">
              <p>
                As a courtesy to you, we will gladly process and submit your insurance claim. However, if this claim is not paid by your insurance company within 30 days, the balance is your responsibility and due immediately. If your account has not been paid in full within 45 days after the date of service, a late charge will be assessed. If there is a balance to you on your account after insurance has paid your claim, a check for the difference will be sent to you.
              </p>
              <p>
                Claims are filed on behalf of our patients for services performed in the office to the primary insurance company. Secondary insurance is the patient’s responsibility. To assist in filing your secondary claim, we will give you a complete statement of services from our office. Insurance benefits belong to you, and it is up to you to ensure that you are receiving appropriate reimbursement under the terms of your plan. There is no guarantee of benefits from the insurance company until a claim is received and processed by the insurance company. Therefore, benefits quoted to you are only an estimate provided by the insurance company.
              </p>
              <Checkbox id="reg-consent" checked={form.consent} onChange={(checked) => setForm((current) => ({ ...current, consent: checked }))}>
                I agree to the above mentioned information
              </Checkbox>
            </div>
          </Section>
        ) : null}

        {page === REVIEW ? (
          <Review form={form} payers={payers} providers={providers} onEdit={go} />
        ) : null}

        {page === REVIEW && duplicateFound ? (
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
                        {candidate.uhid} · {candidate.age ?? '—'} yrs · {candidate.sex}
                        {candidate.mobile ? ` · ${candidate.mobile}` : ''}
                      </p>
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => navigate(`/patients/${candidate.patientId}`, { replace: true })}>
                    Use this patient
                  </Button>
                </div>
              ))}
            </div>
            {/* Not in the Angular form (Minalini, 2026-11-03): a false match, such as twins, must not block the desk (duplicateCheck: override). */}
            <div className="flex flex-col gap-3 border-t border-border-soft px-5 py-4">
              <TextAreaField
                id="reg-overrideReason"
                name="duplicateOverrideReason"
                label="Reason for registering anyway"
                required
                maxLength={500}
                value={overrideReason}
                onChange={setOverrideReason}
                error={overrideTried && !overrideReason.trim() ? 'Reason required' : undefined}
              />
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={onRegisterAnyway} disabled={submitting}>
                  Register anyway
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {submitError ? (
          <Alert tone="critical" live>
            {submitError}
          </Alert>
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t border-border-soft pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => navigate('/patients')}>
            Cancel
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {page > 0 ? (
              <Button type="button" variant="outline" onClick={() => go(page - 1)}>
                Previous
              </Button>
            ) : null}
            {page < REVIEW ? (
              <Button type="button" onClick={onNext}>
                Next
              </Button>
            ) : (
              <Button type="button" onClick={() => void onDone()} disabled={submitting}>
                {submitting ? 'Loading...' : submitError && submission.patientId ? 'Try again' : 'Done'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={allSet}
        title="Registration Successfull 🎊"
        footer={
          <>
            {/* TODO(stage 2): the Angular app printed the form as a PDF; nothing to download yet. */}
            <Button type="button" variant="outline" disabled>
              Download PDF
            </Button>
            <Button type="button" onClick={() => navigate(`/patients/${submission.patientId}`, { replace: true })}>
              Ok
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm text-ink">
          <h3 className="text-lg font-semibold text-ink">All Set !!</h3>
          {/* Reworded (Minalini, 2026-11-03): the portal's "an email containing your new account credentials" isn't true at the desk. */}
          <p>The patient is registered. Their medical record number is:</p>
          {submission.mrn ? <p className="text-2xl font-semibold tracking-wide tabular-nums text-primary-text">{submission.mrn}</p> : null}
          <h4 className="font-semibold text-ink">Thank You !!</h4>
        </div>
      </Modal>
    </div>
  )
}

function Section({ title, icon, action, children }: { title: string; icon?: typeof UserPlus; action?: ReactNode; children: ReactNode }) {
  return (
    <Card accentTone="teal" className="min-w-0">
      <CardHeader icon={icon} iconTone="teal" title={title} action={action} />
      <CardBody>{children}</CardBody>
    </Card>
  )
}

function SubHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h5 className="mb-2.5 text-sm font-semibold text-ink">{title}</h5>
      {children}
    </div>
  )
}

function SurgeryList({
  title,
  surgeries,
  form,
  today,
  onChange,
}: {
  title: [string, string]
  surgeries: readonly { key: keyof RegistrationForm['SurgicalHistory']; label: string }[]
  form: RegistrationForm
  today: string
  onChange: (key: keyof RegistrationForm['SurgicalHistory'], value: string) => void
}) {
  return (
    <div>
      <div className="mb-1 hidden grid-cols-[minmax(0,1fr)_14rem] gap-4 text-xs font-semibold text-ink-muted sm:grid">
        <span>{title[0]}</span>
        <span>{title[1]}</span>
      </div>
      <div className="divide-y divide-border-soft">
        {surgeries.map(({ key, label }) => (
          <div key={key} className="grid grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-4">
            <label htmlFor={`reg-${key}`} className="text-sm font-medium text-ink">
              {label}
            </label>
            <TextField id={`reg-${key}`} name={key} type="date" label="" max={today} value={form.SurgicalHistory[key]} onChange={(v) => onChange(key, v)} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Review({ form, payers, providers, onEdit }: { form: RegistrationForm; payers: Option[]; providers: Option[]; onEdit: (page: number) => void }) {
  const b = form.basicInfo
  const c = form.choicesForm
  const a = form.AddInfo
  const m = form.medicationForm
  const s = form.socialHistoryForm
  const f = form.familyHistoryForm
  const h = form.Hospitalization
  const v = (value: string) => value.trim() || null
  const list = (values: string[]) => (values.length ? values.join(', ') : null)
  const labelOf = (options: Option[], value: string) => options.find((o) => o.value === value)?.label ?? v(value)
  const surgeries = [...SURGERIES_GENERAL, ...SURGERIES_MALE, ...SURGERIES_FEMALE].filter(({ key }) => form.SurgicalHistory[key])
  const visits = ([1, 2, 3] as const).filter((n) => h[`PastVisit${n}`] || h[`Notes${n}`])

  return (
    <>
      <Alert tone="info">Please verify whether the informations provided are correct</Alert>
      <ReviewCard title="Basic Informations" onEdit={() => onEdit(0)}>
        <SummaryItem label="First Name" value={v(b.firstName)} />
        <SummaryItem label="Middle Name" value={v(b.middleName)} />
        <SummaryItem label="Last Name" value={v(b.lastName)} />
        <SummaryItem label="Date of Birth" value={v(b.date)} />
        <SummaryItem label="Contact" value={v(b.phoneNo)} />
        <SummaryItem label="Email" value={v(b.email)} />
      </ReviewCard>
      <ReviewCard title="Choices" onEdit={() => onEdit(1)}>
        <SummaryItem label="Provider Name" value={labelOf(providers, c.provider)} />
        <SummaryItem label="Allow Patient Portal" value={v(c.AllowPatientPortal)} />
        <SummaryItem label="Allow SMS" value={v(c.AllowSMS)} />
        <SummaryItem label="Allow Email" value={v(c.AllowEmail)} />
        <SummaryItem label="Financial Responsible" value={v(c.ResponsibleParty)} />
        <SummaryItem label="Method Of Payment" value={v(c.payMethod)} />
        <SummaryItem label="Insurance Name" value={v(c.planName) ?? labelOf(payers, c.insuranceCompany)} />
      </ReviewCard>
      <ReviewCard title="Additional Information" onEdit={() => onEdit(2)}>
        <SummaryItem label="Pharmacy Name" value={labelOf(MOCK_PHARMACIES, a.pharmacyName)} />
        <SummaryItem label="City" value={v(a.City)} />
        <SummaryItem label="State" value={v(a.State)} />
        <SummaryItem label="Country" value={labelOf(COUNTRIES, a.Country)} />
      </ReviewCard>
      <ReviewCard title="Medication And Allergy" onEdit={() => onEdit(3)}>
        <SummaryItem label="Medication Currently" value={v(m.medication)} />
        <SummaryItem label="Medication List" value={v(m.medicationInfo)} />
        <SummaryItem label="Allergies" value={v(m.allergies)} />
        <SummaryItem label="Allergy List" value={v(m.allergiesInfo)} />
      </ReviewCard>
      <ReviewCard title="Past Medical History" onEdit={() => onEdit(4)}>
        <SummaryItem label="Medication Currently" value={list(form.medicalHistoryForm.selectedMedicalHistory)} />
      </ReviewCard>
      <ReviewCard title="Family History" onEdit={() => onEdit(5)}>
        {FAMILY_DISEASES.map(({ key, label }) => (
          <SummaryItem key={key} label={label} value={list(f[key])} />
        ))}
      </ReviewCard>
      <ReviewCard title="Social History" onEdit={() => onEdit(6)}>
        <SummaryItem label="Tobacco" value={list(s.selectedtobaccoHistory)} />
        <SummaryItem label="Alcohol" value={list(s.selectedalcoholHistory)} />
        <SummaryItem label="Drug/Abuse" value={list(s.selectedDrugAbuse)} />
        <SummaryItem label="Cardio Vascular" value={list(s.selectedCardioVascular)} />
      </ReviewCard>
      <ReviewCard title="Surgical History" onEdit={() => onEdit(7)}>
        {surgeries.length ? surgeries.map(({ key, label }) => <SummaryItem key={key} label={label} value={form.SurgicalHistory[key]} />) : <SummaryItem label="Surgery" value={null} />}
      </ReviewCard>
      <ReviewCard title="Hospitalization/Procedure" onEdit={() => onEdit(8)}>
        {visits.length ? (
          visits.map((n) => <SummaryItem key={n} label={v(h[`PastVisit${n}`]) ?? 'Past Visit Date'} value={v(h[`Notes${n}`])} />)
        ) : (
          <SummaryItem label="Past Visit Date" value={null} />
        )}
      </ReviewCard>
    </>
  )
}

function ReviewCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader
        title={title}
        action={
          <Button type="button" size="xs" variant="ghost" onClick={onEdit} aria-label={`Edit ${title}`}>
            <Pencil className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        }
      />
      <CardBody>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">{children}</dl>
      </CardBody>
    </Card>
  )
}
