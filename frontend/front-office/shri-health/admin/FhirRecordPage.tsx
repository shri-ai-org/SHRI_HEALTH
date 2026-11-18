// SHRI_HEALTH: a patient's record as FHIR R4 (US Core), read only (getPatientFhirRecord;
// patients:read; #402): the same resources outside systems read on /fhir, shown for the demo.
// The patient is found with the front office's search (D117); restricted charts follow the
// server's rules (D37). Every read is audited by the server.
import { Braces, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { getPatientFhirRecord } from '../../../src/api/generated/endpoints/platform/platform'
import type { PatientFhirRecord } from '../../../src/api/generated/model'
import { Alert } from '../../src/components/ui/Alert'
import { Button } from '../../src/components/ui/Button'
import { Card, CardBody, CardHeader } from '../../src/components/ui/Card'
import type { Patient } from '../../src/types/patient'
import { planSearch, searchPatientsOnServer } from '../patients'
import { readFailure, when } from './format'

type Resource = { resourceType?: string; id?: string }

export function FhirRecordPage() {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Patient[] | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Patient | null>(null)
  const [record, setRecord] = useState<PatientFhirRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function search(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const plan = planSearch(query)
    if ('needMore' in plan) {
      setHint(plan.needMore)
      return
    }
    setHint(null)
    setBusy(true)
    try {
      setFound(await searchPatientsOnServer(plan.criteria))
    } catch (err) {
      setError(readFailure(err, 'the patients'))
    } finally {
      setBusy(false)
    }
  }

  async function open(patient: Patient) {
    setChosen(patient)
    setRecord(null)
    setError(null)
    setBusy(true)
    try {
      const res = await getPatientFhirRecord(patient.patientId)
      if (res.status !== 200) throw new Error('unexpected')
      setRecord(res.data)
    } catch (err) {
      setError(readFailure(err, "this patient's FHIR record"))
    } finally {
      setBusy(false)
    }
  }

  const counts = new Map<string, number>()
  for (const entry of record?.entry ?? []) {
    const type = (entry.resource as Resource).resourceType ?? 'Resource'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card>
        <CardHeader icon={Search} title="Find the patient" subtitle="A name, an MRN or a 10-digit mobile number." />
        <CardBody className="space-y-3">
          <form onSubmit={(e) => void search(e)} className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm text-ink-muted">
              Patient
              <input value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" className="min-h-11 rounded-lg border border-border bg-surface-1 px-3 text-ink" />
            </label>
            <Button type="submit" variant="secondary" loading={busy && !chosen}>
              Search
            </Button>
          </form>
          {hint ? <p className="text-sm text-ink-muted">{hint}</p> : null}
          {found && found.length === 0 ? <p className="text-sm text-ink-muted">No patient matches.</p> : null}
          {found && found.length > 0 ? (
            <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
              {found.map((p) => (
                <li key={p.patientId}>
                  <button type="button" onClick={() => void open(p)} className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm hover:bg-surface-2">
                    <span className="font-medium text-ink">{p.name}</span>
                    <span className="tabular-nums text-ink-muted">{p.uhid}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
      {error ? <Alert tone="critical" title={error} /> : null}
      {chosen && (record || busy) ? (
        <Card>
          <CardHeader icon={Braces} title={`${chosen.name}: FHIR R4 record`} subtitle={record ? `A ${record.type} Bundle assembled ${when(record.timestamp)}, ${record.entry.length} resources${record.truncated ? ' (the first 500)' : ''}.` : 'Reading the record…'} />
          {record ? (
            <CardBody className="space-y-3">
              <ul className="flex flex-wrap gap-2 text-xs text-ink-muted" aria-label="Resources by type">
                {[...counts.entries()].map(([type, n]) => (
                  <li key={type} className="rounded-full border border-border-soft px-2.5 py-1">
                    {type} <span className="font-semibold tabular-nums text-ink">{n}</span>
                  </li>
                ))}
              </ul>
              <ul className="space-y-2">
                {record.entry.map((entry) => {
                  const r = entry.resource as Resource
                  return (
                    <li key={entry.fullUrl}>
                      <details className="rounded-lg border border-border-soft">
                        <summary className="focus-ring cursor-pointer px-3 py-2 text-sm text-ink">
                          {r.resourceType ?? 'Resource'} <span className="text-ink-muted">{r.id}</span>
                        </summary>
                        <pre className="max-h-96 overflow-auto border-t border-border-soft px-3 py-2 text-xs text-ink-muted">{JSON.stringify(entry.resource, null, 2)}</pre>
                      </details>
                    </li>
                  )
                })}
              </ul>
            </CardBody>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}
