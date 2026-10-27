import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError } from '../../api/client'
import { getPatient } from '../../api/generated/endpoints/patients/patients'
import type { Patient } from '../../api/generated/model'
import { PatientAppointmentsPanel } from '../scheduling/PatientAppointmentsPanel'
import { InsurancePanel } from './insurance/InsurancePanel'
import { PortalAccountPanel } from './PortalAccountPanel'
import { birthSexLabel, genderIdentityLabel } from './demographics'
import { Badge, formatAddressLines, formatDate, formatNameGivenFirst, formatPhone, ProblemAlert, Spinner, type Problem } from '../../design-system'

const GENDER: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other', unknown: 'Unknown' }

/**
 * The patient's demographics after search or registration. Insurance, appointments and the
 * break-glass flow for restricted charts come in later front-desk PRs; until then a refused read
 * shows the server's problem in plain words.
 */
export function PatientPage() {
  const { patientId = '' } = useParams()
  // A new key per patient starts each chart with empty state.
  return <PatientDetails key={patientId} patientId={patientId} />
}

function PatientDetails({ patientId }: { patientId: string }) {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)

  useEffect(() => {
    let current = true
    getPatient(patientId)
      .then((res) => {
        if (current && res.status === 200) setPatient(res.data)
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setProblem(error.problem)
        else throw error
      })
    return () => {
      current = false
    }
  }, [patientId])

  if (problem) {
    return (
      <section className="space-y-4">
        <ProblemAlert problem={problem} />
        <Link to="/patients/search" className="text-primary-700 underline">
          Back to patient search
        </Link>
      </section>
    )
  }
  if (!patient) return <Spinner label="Loading patient" />

  const rows: Array<[string, string]> = [
    ['MRN', patient.mrn],
    ['Date of birth', patient.birthDate ? formatDate(patient.birthDate) : '—'],
    ['Legal sex', patient.gender ? (GENDER[patient.gender] ?? patient.gender) : '—'],
    ['Sex assigned at birth', birthSexLabel(patient.birthSex) ?? '—'],
    ['Gender identity', genderIdentityLabel(patient.genderIdentity) ?? '—'],
    ['Phone', patient.phones?.[0] ? formatPhone(patient.phones[0].number) : '—'],
    ['Email', patient.emails?.[0]?.address ?? '—'],
    ['Address', patient.address ? formatAddressLines(patient.address).join(', ') : '—'],
  ]

  return (
    <section aria-labelledby="patient-title" className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="patient-title" className="text-2xl font-semibold text-ink">
          {formatNameGivenFirst(patient.name)}
        </h1>
        {patient.preferredName ? <span className="text-ink-muted">goes by {patient.preferredName}</span> : null}
        {patient.restricted ? <Badge tone="warning">Restricted</Badge> : null}
        {patient.active ? null : <Badge>Merged</Badge>}
      </div>
      <dl className="grid gap-x-6 gap-y-3 rounded-xl border border-border bg-surface-1 p-5 sm:grid-cols-[10rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-sm font-semibold text-ink-muted">{label}</dt>
            <dd className="text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <PatientAppointmentsPanel patientId={patient.id} patientName={formatNameGivenFirst(patient.name)} />
      <InsurancePanel patientId={patient.id} />
      <PortalAccountPanel patientId={patient.id} />
    </section>
  )
}
