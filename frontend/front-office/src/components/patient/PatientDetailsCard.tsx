import { useState } from 'react'
import { Copy, Link2, Pencil } from 'lucide-react'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { MobileInput } from '../ui/MobileInput'
import { useToast } from '../../hooks/useToast'
import { useStoreValue } from '../../hooks/useStore'
import { findAbhaHolder, getConnectivity } from '../../domain/selectors'
import { linkAbha, updatePatientDemographics } from '../../domain/actions'
import { toEditableMobile } from '../../utils/phone'
import { revealFirstInvalid } from '../../utils/revealInvalid'
import { abhaError, addressError, ageError, ageNeedsConfirmation, emailError, mobileError, nameError, nextAgeInput, nextNameInput } from '../../utils/validation'
import { cn } from '../../utils/cn'
import { AgeConfirm, FieldError } from './AgeConfirm'
import { CreateAbhaLink } from './CreateAbhaLink'
import type { Patient, Sex } from '../../types/patient'
import { errorClass, inputClass } from '../../utils/formClasses'


interface Draft {
  name: string
  age: string
  sex: Sex
  mobile: string
  email: string
  address: string
  ageConfirmed: boolean
}

/** The patient's contact and identity details, in the profile header under the
 *  name — each one copies on click. Edited in place with the same checks as
 *  registration; ABHA is linked (or created) from here too. */
export function PatientDetailsStrip({ patient }: { patient: Patient }) {
  const { notify } = useToast()
  const connectivity = useStoreValue(getConnectivity)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [abha, setAbha] = useState('')
  const [abhaTouched, setAbhaTouched] = useState(false)
  // Link ABHA opens a single field for the number; Create ABHA goes to the ABDM site.
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abhaHolder = useStoreValue(findAbhaHolder, abha)

  function startEditing() {
    setError(null)
    setDraft({
      name: patient.name,
      age: patient.age != null ? String(patient.age) : '',
      sex: patient.sex,
      mobile: toEditableMobile(patient.mobile),
      email: patient.email ?? '',
      address: patient.address ?? '',
      ageConfirmed: false,
    })
  }

  const draftErrors = draft
    ? {
        name: nameError(draft.name),
        age: ageError(draft.age),
        mobile: mobileError(draft.mobile),
        email: emailError(draft.email),
        address: addressError(draft.address),
      }
    : null
  const ageChanged = draft ? Number(draft.age) !== patient.age : false
  const needsAgeConfirm = Boolean(draft && ageChanged && ageNeedsConfirmation(draft.age))
  const draftReady = Boolean(
    draftErrors && Object.values(draftErrors).every((message) => !message) && (!needsAgeConfirm || draft?.ageConfirmed),
  )

  const abhaProblem = abhaError(abha) ?? (abhaHolder && abhaHolder.patientId !== patient.patientId ? `Already linked to ${abhaHolder.name} (${abhaHolder.uhid}).` : null)

  function save(event: React.FormEvent) {
    event.preventDefault()
    if (!draft) return
    // Save stays clickable: with something wrong it goes to the first marked field.
    if (!draftReady) {
      revealFirstInvalid()
      return
    }
    try {
      updatePatientDemographics(patient.patientId, draft)
      notify('Details updated', { detail: patient.uhid })
      setDraft(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function link(event: React.FormEvent) {
    event.preventDefault()
    setAbhaTouched(true)
    if (abhaProblem) return
    try {
      linkAbha(patient.patientId, abha)
      notify('ABHA linked', { detail: abha.trim() })
      setAbha('')
      setAbhaTouched(false)
      setLinking(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (!draft) return
    setDraft({ ...draft, [key]: value, ...(key === 'age' ? { ageConfirmed: false } : {}) })
    setError(null)
  }

  function copy(label: string, value: string) {
    void navigator.clipboard?.writeText(value).then(
      () => notify(`${label} copied`, { detail: value }),
      () => notify(`Could not copy the ${label.toLowerCase()}`, { tone: 'error' }),
    )
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border-soft pt-3">
      {error ? <Alert tone="critical">{error}</Alert> : null}

      {draft && draftErrors ? (
        <form onSubmit={save} noValidate className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <input value={draft.name} onChange={(e) => edit('name', nextNameInput(e.target.value))} maxLength={60} className={cn(inputClass, draftErrors.name && errorClass)} placeholder="Full name" aria-label="Full name" aria-invalid={Boolean(draftErrors.name)} />
            <FieldError message={draftErrors.name} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <input
                value={draft.age}
                onChange={(e) => edit('age', nextAgeInput(e.target.value, draft.age))}
                className={cn(inputClass, (draftErrors.age || needsAgeConfirm) && errorClass)}
                placeholder="Age"
                aria-label="Age in years, 0 to 130"
                aria-invalid={Boolean(draftErrors.age) || (needsAgeConfirm && !draft.ageConfirmed)}
                inputMode="numeric"
                maxLength={3}
              />
              <FieldError message={draftErrors.age} />
            </div>
            <select value={draft.sex} onChange={(e) => edit('sex', e.target.value as Sex)} className={inputClass} aria-label="Sex">
              {(['Male', 'Female', 'Other'] as Sex[]).map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>
          {needsAgeConfirm ? (
            <div className="sm:col-span-2">
              <AgeConfirm age={draft.age} confirmed={draft.ageConfirmed} onConfirm={(next) => edit('ageConfirmed', next)} />
            </div>
          ) : null}
          <div>
            <MobileInput value={draft.mobile} onValueChange={(value) => edit('mobile', value)} className={cn(inputClass, draftErrors.mobile && errorClass)} placeholder="Mobile (10 digits)" aria-invalid={Boolean(draftErrors.mobile)} />
            <FieldError message={draftErrors.mobile} />
          </div>
          <div>
            <input type="email" value={draft.email} onChange={(e) => edit('email', e.target.value)} className={cn(inputClass, draftErrors.email && errorClass)} placeholder="Email (optional)" aria-label="Email" aria-invalid={Boolean(draftErrors.email)} />
            <FieldError message={draftErrors.email} />
          </div>
          <div className="sm:col-span-2">
            <input value={draft.address} onChange={(e) => edit('address', e.target.value)} maxLength={200} className={cn(inputClass, draftErrors.address && errorClass)} placeholder="Address (optional)" aria-label="Address" aria-invalid={Boolean(draftErrors.address)} />
            <FieldError message={draftErrors.address} />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <CopyChip label="Mobile" value={patient.mobile} onCopy={copy} />
            <CopyChip label="Address" value={patient.address} onCopy={copy} wide />
            {/* ABHA: linked — its ID, copyable; not linked — link an existing one, or create one. */}
            {patient.abhaId ? (
              <CopyChip label="ABHA linked" value={patient.abhaId} onCopy={copy} />
            ) : linking ? null : (
              // Two clear choices: the patient already has an ABHA ID → Link it;
              // they don't → Create one on the ABDM site.
              <>
                <button
                  type="button"
                  onClick={() => setLinking(true)}
                  title="The patient already has an ABHA ID — enter it to link"
                  className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-primary-200 bg-primary-50 px-3 text-xs font-semibold text-primary-text transition-colors hover:border-primary-300 hover:bg-primary-100 dark:border-primary-500/35"
                >
                  <Link2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  Link ABHA
                </button>
                <span aria-hidden="true" className="text-xs text-ink-subtle">or</span>
                <CreateAbhaLink choice />
              </>
            )}
            <Button size="sm" variant="ghost" onClick={startEditing} aria-label="Edit details" className="ml-auto">
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
              Edit
            </Button>
          </div>

          {/* Link ABHA: the patient has an ABHA — enter its address or number. */}
          {!patient.abhaId && linking ? (
            <form onSubmit={link} noValidate className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={abha}
                  onChange={(event) => {
                    setAbha(event.target.value)
                    setError(null)
                  }}
                  onBlur={() => setAbhaTouched(true)}
                  autoFocus
                  placeholder="ABHA address or number"
                  aria-label="ABHA address or number"
                  aria-invalid={Boolean(abhaTouched && abhaProblem)}
                  title={connectivity.abha === 'unavailable' ? 'ABHA lookup is unavailable — record an existing ABHA by hand. Care is never blocked on it.' : undefined}
                  className={cn(inputClass, 'h-9 w-full sm:w-80', abhaTouched && abhaProblem && errorClass)}
                />
                <Button type="submit" size="sm" disabled={!abha.trim()} className="shrink-0">
                  Link
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLinking(false)
                    setAbha('')
                    setAbhaTouched(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
              <FieldError message={abhaTouched ? abhaProblem : null} />
            </form>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** One detail — label and value in a chip that copies the value when pressed. */
function CopyChip({
  label,
  value,
  empty = '—',
  wide = false,
  onCopy,
}: {
  label: string
  value: string | null | undefined
  empty?: string
  wide?: boolean
  onCopy: (label: string, value: string) => void
}) {
  if (!value) {
    return (
      <span className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 text-xs text-ink-subtle">
        <span className="font-medium">{label}</span>
        {empty}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onCopy(label, value)}
      title={`Copy ${label.toLowerCase()} — ${value}`}
      aria-label={`Copy ${label}: ${value}`}
      className={cn(
        'focus-ring inline-flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-2.5 text-left text-xs transition-colors hover:border-primary-600 hover:bg-primary-50',
        wide ? 'max-w-full sm:max-w-sm' : 'max-w-full',
      )}
    >
      <span className="shrink-0 font-medium text-ink-muted">{label}</span>
      <span className="min-w-0 truncate font-medium text-ink">{value}</span>
      <Copy className="h-3 w-3 shrink-0 text-ink-subtle" strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}
