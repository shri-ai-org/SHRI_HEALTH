import { useEffect, useRef, useState, type FormEvent } from 'react'
import { newIdempotencyKey } from '../../api/client'
import { listMedications, recordMedication } from '../../api/generated/endpoints/medications/medications'
import type { Medication } from '../../api/generated/model'
import { Badge, Button, DataTable, Field, ProblemAlert, Spinner, TextInput, useToast, type Column, type Problem } from '../../design-system'
import { DrugPicker, drugConcept, NO_DRUG, type DrugChoice } from './DrugPicker'
import { catchProblem, Panel } from './parts'

const STATUS: Record<string, string> = { active: 'Active', completed: 'Completed', stopped: 'Stopped' }

function medicationName(m: Medication): string {
  return m.medication.text ?? m.medication.codings?.[0]?.display ?? '—'
}

/**
 * The patient's current medications at rooming (demo step 7; inventory #116–117): the list as it
 * stands, prescribed here or reported, and what the patient says they already take, recorded as
 * reported (D28). A drug coded in RxNorm is what the duplicate-medication alert matches on (D99).
 */
export function MedicationsSection({ patientId, open }: { patientId: string; open: boolean }) {
  const toast = useToast()
  const [items, setItems] = useState<Medication[] | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    listMedications(patientId, { limit: 100 })
      .then((res) => {
        if (current && res.status === 200) setItems(res.data.items)
      })
      .catch((error: unknown) => {
        if (current) catchProblem(setProblem)(error)
      })
    return () => {
      current = false
    }
  }, [patientId, version])

  const columns: Column<Medication>[] = [
    { key: 'name', header: 'Medication', render: (m) => medicationName(m) },
    { key: 'dosage', header: 'How taken', render: (m) => m.dosageText ?? '—' },
    { key: 'status', header: 'Status', render: (m) => STATUS[m.status] ?? m.status },
    { key: 'source', header: 'Source', render: (m) => (m.source === 'prescription' ? <Badge tone="primary">Prescribed here</Badge> : 'Reported') },
  ]

  return (
    <Panel title="Current medications" id="medications-title">
      {problem ? <ProblemAlert problem={problem} /> : null}
      {!items ? (
        problem ? null : <Spinner label="Loading medications" />
      ) : (
        <DataTable caption="Medications on the list" columns={columns} rows={items} rowKey={(m) => m.id} emptyTitle="No medications on the list" emptyDescription="Ask the patient what they take, including over-the-counter medicines." />
      )}
      {open ? (
        <AddMedicationForm
          patientId={patientId}
          onAdded={(name) => {
            toast.show(`${name} added to the medication list`)
            setVersion((v) => v + 1)
          }}
        />
      ) : null}
    </Panel>
  )
}

function AddMedicationForm({ patientId, onAdded }: { patientId: string; onAdded: (name: string) => void }) {
  const [drug, setDrug] = useState<DrugChoice>(NO_DRUG)
  const [dosage, setDosage] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  // One key per medication entered, kept while that same entry is retried (API_STANDARDS §10).
  const key = useRef<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const medication = drugConcept(drug)
    if (!medication) {
      setError('Search for the medication, or type its name.')
      return
    }
    setError(undefined)
    key.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const dosageText = dosage.trim()
      const res = await recordMedication(patientId, { medication, status: 'active', ...(dosageText ? { dosageText } : {}) }, { 'Idempotency-Key': key.current })
      if (res.status === 201) {
        key.current = null
        setDrug(NO_DRUG)
        setDosage('')
        onAdded(medication.text)
      }
    } catch (err) {
      catchProblem(setProblem)(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4 border-t border-border pt-4">
      <h3 className="text-base font-semibold text-ink">Add a medication the patient takes</h3>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <DrugPicker
        label="Medication"
        matchLabel="Matching medication"
        hint="A drug name finds its RxNorm code; anything else can be typed"
        value={drug}
        error={error}
        onProblem={setProblem}
        onChange={(next) => {
          setDrug(next)
          setError(undefined)
          key.current = null
        }}
      />
      <Field label="How the patient takes it" hint="For example, 1 tablet by mouth once daily">
        {(p) => (
          <TextInput
            {...p}
            value={dosage}
            maxLength={500}
            onChange={(e) => {
              setDosage(e.target.value)
              key.current = null
            }}
          />
        )}
      </Field>
      <Button type="submit" loading={busy}>
        Add medication
      </Button>
    </form>
  )
}
