import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { PatientSearch } from './PatientSearch'
import type { Patient } from '../../types/patient'

/**
 * A form's patient: the one patient search until someone is chosen, then
 * who they are and a way to change it. Services (guest pass, MLC, estimate)
 * use it so every patient is found the same way.
 */
export function PatientPickField({
  patient,
  onChange,
  scope,
  placeholder,
  detail,
}: {
  patient: Patient | null
  onChange: (patient: Patient) => void
  /** Only patients in a bed — a guest pass is for an inpatient. */
  scope?: 'inpatients'
  placeholder?: string
  /** Shown under the chosen patient — e.g. their ward and bed. */
  detail?: ReactNode
}) {
  const [changing, setChanging] = useState(false)

  if (patient && !changing) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-primary-200 dark:border-primary-500/35 bg-primary-50 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{patient.name}</p>
          <p className="truncate text-xs text-ink-muted">
            {patient.uhid}
            {patient.age ? ` · ${patient.age} ${patient.sex.charAt(0)}` : ''}
            {detail ? <> · {detail}</> : null}
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(true)}>
          Change
        </Button>
      </div>
    )
  }

  return (
    <PatientSearch
      mode="pick"
      scope={scope}
      autoFocus={changing}
      placeholder={placeholder}
      onPick={(next) => {
        onChange(next)
        setChanging(false)
      }}
    />
  )
}
