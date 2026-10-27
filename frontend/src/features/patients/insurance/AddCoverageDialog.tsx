import { Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ApiError, newIdempotencyKey } from '../../../api/client'
import { addCoverage, listRelatedPersons } from '../../../api/generated/endpoints/patients/patients'
import { listPayers } from '../../../api/generated/endpoints/practice-setup/practice-setup'
import type { CoverageCreate, CoverageCreateRelationshipToSubscriber, Payer, RelatedPerson } from '../../../api/generated/model'
import {
  Alert,
  Button,
  DateInput,
  Field,
  formatNameGivenFirst,
  Modal,
  ProblemAlert,
  Select,
  TextInput,
  useToast,
  type Problem,
} from '../../../design-system'
import { PRIORITIES, priorityLabel, RELATIONSHIP } from './labels'

interface Form {
  payerQuery: string
  payerId: string
  memberId: string
  groupNumber: string
  groupName: string
  planName: string
  relationship: CoverageCreateRelationshipToSubscriber
  subscriberRelatedPersonId: string
  subscriberId: string
  /** `YYYY-MM-DD`, `null` when typed but not a real date, `''` when empty. */
  startDate: string | null
  endDate: string | null
  order: number
}

type Errors = Partial<Record<keyof Form, string | undefined>>

const FIELD_LABELS: Record<string, string> = {
  '/payerId': 'Insurance company',
  '/memberId': 'Member ID',
  '/groupNumber': 'Group number',
  '/groupName': 'Group name',
  '/planName': 'Plan name',
  '/relationshipToSubscriber': 'Relationship to subscriber',
  '/subscriberRelatedPersonId': 'Subscriber',
  '/subscriberId': 'Subscriber ID',
  '/startDate': 'Start date',
  '/endDate': 'End date',
  '/order': 'Priority',
}

export function validate(form: Form): Errors {
  const errors: Errors = {}
  if (!form.payerId) errors.payerId = 'Find and choose the insurance company.'
  if (!form.memberId.trim()) errors.memberId = 'Enter the member ID from the card.'
  if (form.relationship !== 'self' && !form.subscriberRelatedPersonId) errors.subscriberRelatedPersonId = 'Choose the subscriber.'
  if (form.startDate === null) errors.startDate = 'Enter the date as MM/DD/YYYY.'
  if (form.endDate === null) errors.endDate = 'Enter the date as MM/DD/YYYY.'
  if (form.startDate && form.endDate && form.endDate < form.startDate) errors.endDate = 'The end date must be on or after the start date.'
  return errors
}

function toBody(form: Form): CoverageCreate {
  const body: CoverageCreate = {
    order: form.order,
    payerId: form.payerId,
    memberId: form.memberId.trim(),
    relationshipToSubscriber: form.relationship,
  }
  if (form.groupNumber.trim()) body.groupNumber = form.groupNumber.trim()
  if (form.groupName.trim()) body.groupName = form.groupName.trim()
  if (form.planName.trim()) body.planName = form.planName.trim()
  if (form.subscriberId.trim()) body.subscriberId = form.subscriberId.trim()
  if (form.relationship !== 'self') body.subscriberRelatedPersonId = form.subscriberRelatedPersonId
  if (form.startDate) body.startDate = form.startDate
  if (form.endDate) body.endDate = form.endDate
  return body
}

/** Adds an insurance coverage (inventory #38). The payer comes from the payer directory (`GET /payers`). */
export function AddCoverageDialog({
  patientId,
  nextOrder,
  onClose,
  onAdded,
}: {
  patientId: string
  nextOrder: number
  onClose: () => void
  onAdded: () => void
}) {
  const toast = useToast()
  const formId = useId()
  const [form, setForm] = useState<Form>({
    payerQuery: '',
    payerId: '',
    memberId: '',
    groupNumber: '',
    groupName: '',
    planName: '',
    relationship: 'self',
    subscriberRelatedPersonId: '',
    subscriberId: '',
    startDate: '',
    endDate: '',
    order: nextOrder,
  })
  const [errors, setErrors] = useState<Errors>({})
  const [payers, setPayers] = useState<Payer[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [people, setPeople] = useState<RelatedPerson[] | null>(null)
  const [peopleProblem, setPeopleProblem] = useState<Problem | null>(null)
  // Bumped by "Try again" after the related persons failed to load.
  const [peopleTry, setPeopleTry] = useState(0)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  // One key per user action: kept while the same form is retried, replaced when anything changes.
  const idempotencyKey = useRef<string | null>(null)

  function update(changes: Partial<Form>) {
    setForm((f) => ({ ...f, ...changes }))
    idempotencyKey.current = null
  }

  // The subscriber must be one of this patient's related persons (same-patient link).
  const needsSubscriber = form.relationship !== 'self'
  useEffect(() => {
    if (!needsSubscriber || people) return
    let current = true
    listRelatedPersons(patientId, { limit: 50 })
      .then((res) => {
        if (current && res.status === 200) setPeople(res.data.items.filter((p) => p.active))
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError)) throw e
        if (current) setPeopleProblem(e.problem)
      })
    return () => {
      current = false
    }
  }, [needsSubscriber, people, patientId, peopleTry])

  async function findPayers() {
    const name = form.payerQuery.trim()
    if (name.length < 2) return setErrors({ ...errors, payerQuery: 'Enter at least 2 letters of the insurance company.' })
    setErrors({ ...errors, payerQuery: undefined })
    setSearching(true)
    try {
      const res = await listPayers({ payerName: name, active: true, limit: 25 })
      if (res.status === 200) {
        setPayers(res.data.items)
        update({ payerId: res.data.items.length === 1 ? res.data.items[0]!.id : '' })
      }
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem)
      else throw e
    } finally {
      setSearching(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found = validate(form)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    idempotencyKey.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await addCoverage(patientId, toBody(form), { 'Idempotency-Key': idempotencyKey.current })
      if (res.status === 201) {
        toast.show('Insurance added')
        onAdded()
      }
    } catch (error) {
      if (error instanceof ApiError) setProblem(error.problem)
      else throw error
    } finally {
      setBusy(false)
    }
  }

  const set = (key: keyof Form) => (e: { target: { value: string } }) => update({ [key]: e.target.value } as Partial<Form>)

  return (
    <Modal
      open
      size="lg"
      title="Add insurance"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Add insurance
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            {/* Until a search has run, "choose the payer" is reported on this field. */}
            <Field label="Insurance company" hint="Search the payer directory by name" error={errors.payerQuery ?? (payers ? undefined : errors.payerId)}>
              {(p) => (
                <TextInput
                  {...p}
                  autoComplete="off"
                  value={form.payerQuery}
                  onChange={set('payerQuery')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void findPayers()
                    }
                  }}
                />
              )}
            </Field>
          </div>
          <Button variant="secondary" loading={searching} icon={<Search aria-hidden="true" size={16} />} onClick={() => void findPayers()}>
            Find
          </Button>
        </div>
        {payers ? (
          payers.length === 0 ? (
            <Alert tone="info" title="No insurance company found">
              Check the spelling, or try a shorter part of the name.
            </Alert>
          ) : (
            <Field label="Choose the insurance company" required error={errors.payerId}>
              {(p) => (
                <Select {...p} value={form.payerId} onChange={set('payerId')}>
                  <option value="">Choose…</option>
                  {payers.map((payer) => (
                    <option key={payer.id} value={payer.id}>
                      {payer.name}
                      {payer.state ? ` (${payer.state})` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Member ID" required error={errors.memberId}>{(p) => <TextInput {...p} autoComplete="off" value={form.memberId} onChange={set('memberId')} />}</Field>
          <Field label="Group number" error={errors.groupNumber}>{(p) => <TextInput {...p} autoComplete="off" value={form.groupNumber} onChange={set('groupNumber')} />}</Field>
          <Field label="Plan name" error={errors.planName}>{(p) => <TextInput {...p} autoComplete="off" value={form.planName} onChange={set('planName')} />}</Field>
          <Field label="Group name" error={errors.groupName}>{(p) => <TextInput {...p} autoComplete="off" value={form.groupName} onChange={set('groupName')} />}</Field>
          <Field label="Priority" error={errors.order}>
            {(p) => (
              <Select {...p} value={String(form.order)} onChange={(e) => update({ order: Number(e.target.value) })}>
                {PRIORITIES.map((n) => (
                  <option key={n} value={n}>
                    {priorityLabel(n)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Relationship to subscriber" hint="Self when the patient holds the policy" error={errors.relationship}>
            {(p) => (
              <Select {...p} value={form.relationship} onChange={(e) => update({ relationship: e.target.value as Form['relationship'], subscriberRelatedPersonId: '' })}>
                {(Object.entries(RELATIONSHIP) as Array<[Form['relationship'], string]>).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {needsSubscriber ? (
            peopleProblem ? (
              <div className="md:col-span-2">
                <ProblemAlert
                  problem={peopleProblem}
                  actions={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPeopleProblem(null)
                        setPeopleTry((t) => t + 1)
                      }}
                    >
                      Try again
                    </Button>
                  }
                />
              </div>
            ) : people && people.length === 0 ? (
              <div className="md:col-span-2">
                <Alert tone="warning" title="No related persons on file">
                  Add the subscriber as a related person first, then add this insurance.
                </Alert>
              </div>
            ) : (
              <>
                <Field label="Subscriber" required error={errors.subscriberRelatedPersonId}>
                  {(p) => (
                    <Select {...p} value={form.subscriberRelatedPersonId} onChange={set('subscriberRelatedPersonId')} disabled={!people}>
                      <option value="">{people ? 'Choose…' : 'Loading…'}</option>
                      {(people ?? []).map((person) => (
                        <option key={person.id} value={person.id}>
                          {formatNameGivenFirst(person.name)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Subscriber ID" hint="Only if the card shows a different ID" error={errors.subscriberId}>
                  {(p) => <TextInput {...p} autoComplete="off" value={form.subscriberId} onChange={set('subscriberId')} />}
                </Field>
              </>
            )
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Start date" hint="MM/DD/YYYY" error={errors.startDate}>{(p) => <DateInput {...p} value="" onValueChange={(v) => update({ startDate: v })} />}</Field>
          <Field label="End date" hint="MM/DD/YYYY, if known" error={errors.endDate}>{(p) => <DateInput {...p} value="" onValueChange={(v) => update({ endDate: v })} />}</Field>
        </div>

        {problem ? <ProblemAlert problem={problem} fieldLabels={FIELD_LABELS} /> : null}
      </form>
    </Modal>
  )
}
