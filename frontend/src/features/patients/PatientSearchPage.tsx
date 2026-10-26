import { Search, UserPlus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError } from '../../api/client'
import { searchPatients } from '../../api/generated/endpoints/patients/patients'
import type { PatientSearchRequestCriteria, PatientSummary } from '../../api/generated/model'
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DateInput,
  Field,
  formatDate,
  formatNameFamilyFirst,
  formatPhoneLast4,
  PhoneInput,
  ProblemAlert,
  TextInput,
  type Column,
  type Problem,
} from '../../design-system'

const PAGE_SIZE = 25

/** What the register form starts with when the search found nobody. Passed in router state, never the URL (D13). */
export interface RegisterPrefill {
  family?: string
  given?: string
  birthDate?: string
}

interface Form {
  family: string
  given: string
  /** `YYYY-MM-DD`, `null` when typed but not a real date, `''` when empty. */
  birthDate: string | null
  /** E.164, `null` when typed but not a valid U.S. number, `''` when empty. */
  phone: string | null
  mrn: string
}

const EMPTY: Form = { family: '', given: '', birthDate: '', phone: '', mrn: '' }

/**
 * The server needs one exact identifier (phone, MRN) or at least two criteria (API_STANDARDS
 * §14.2). Checked here first so the front desk gets an answer without a round trip; the server
 * still decides (`422 business-rule-violation`).
 */
export function criteriaProblem(form: Form): string | null {
  if (form.birthDate === null) return 'Enter the date of birth as MM/DD/YYYY.'
  if (form.phone === null) return 'Enter a 10-digit U.S. phone number.'
  const family = form.family.trim()
  if (family.length === 1) return 'Enter at least 2 letters of the last name.'
  const exact = Boolean(form.phone) || Boolean(form.mrn.trim())
  const count = [family, form.given.trim(), form.birthDate].filter(Boolean).length
  if (exact || count >= 2) return null
  return 'Enter a phone number or MRN, or two of: last name, first name, date of birth.'
}

function toCriteria(form: Form): PatientSearchRequestCriteria {
  const c: PatientSearchRequestCriteria = {}
  if (form.family.trim()) c.family = form.family.trim()
  if (form.given.trim()) c.given = form.given.trim()
  if (form.birthDate) c.birthDate = form.birthDate
  if (form.phone) c.phone = form.phone
  if (form.mrn.trim()) c.mrn = form.mrn.trim()
  return c
}

const GENDER: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other', unknown: 'Unknown' }

/** Front-desk patient search (inventory #28). Criteria go in the request body, never the URL (D13). */
export function PatientSearchPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState<Form>(EMPTY)
  const [formError, setFormError] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [results, setResults] = useState<{ criteria: PatientSearchRequestCriteria; items: PatientSummary[]; nextCursor?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  async function run(criteria: PatientSearchRequestCriteria, cursor?: string) {
    setProblem(null)
    try {
      const res = await searchPatients({ criteria, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      if (res.status !== 200) return
      setResults((prev) => ({
        criteria,
        items: cursor && prev ? [...prev.items, ...res.data.items] : res.data.items,
        ...(res.data.nextCursor ? { nextCursor: res.data.nextCursor } : {}),
      }))
    } catch (error) {
      if (error instanceof ApiError) setProblem(error.problem)
      else throw error
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const message = criteriaProblem(form)
    setFormError(message)
    if (message) return
    setBusy(true)
    await run(toCriteria(form))
    setBusy(false)
  }

  async function loadMore() {
    if (!results?.nextCursor) return
    setLoadingMore(true)
    await run(results.criteria, results.nextCursor)
    setLoadingMore(false)
  }

  function registerNew() {
    const prefill: RegisterPrefill = {
      ...(form.family.trim() ? { family: form.family.trim() } : {}),
      ...(form.given.trim() ? { given: form.given.trim() } : {}),
      ...(form.birthDate ? { birthDate: form.birthDate } : {}),
    }
    void navigate('/patients/new', { state: prefill })
  }

  const columns: Column<PatientSummary>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (p) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link to={`/patients/${p.id}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">
            {formatNameFamilyFirst(p.name)}
          </Link>
          {p.restricted ? <Badge tone="warning">Restricted</Badge> : null}
          {p.active ? null : <Badge>Merged</Badge>}
        </span>
      ),
    },
    { key: 'birthDate', header: 'Date of birth', render: (p) => (p.birthDate ? formatDate(p.birthDate) : '—') },
    { key: 'gender', header: 'Sex', render: (p) => (p.gender ? GENDER[p.gender] : '—') },
    { key: 'mrn', header: 'MRN', render: (p) => <span className="tabular-nums">{p.mrn}</span> },
    { key: 'phone', header: 'Phone', render: (p) => (p.phoneLast4 ? formatPhoneLast4(p.phoneLast4) : '—') },
  ]

  return (
    <section aria-labelledby="search-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="search-title" className="text-2xl font-semibold text-ink">
          Find a patient
        </h1>
        <Button variant="outline" icon={<UserPlus aria-hidden="true" size={16} />} onClick={registerNew}>
          Register new patient
        </Button>
      </div>

      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4 rounded-xl border border-border bg-surface-1 p-5">
        <p className="text-sm text-ink-muted">Enter a phone number or MRN, or two of: last name, first name, date of birth.</p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Last name">{(p) => <TextInput {...p} autoComplete="off" value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value })} />}</Field>
          <Field label="First name">{(p) => <TextInput {...p} autoComplete="off" value={form.given} onChange={(e) => setForm({ ...form, given: e.target.value })} />}</Field>
          <Field label="Date of birth" hint="MM/DD/YYYY">{(p) => <DateInput {...p} value="" onValueChange={(v) => setForm({ ...form, birthDate: v })} />}</Field>
          <Field label="Phone">{(p) => <PhoneInput {...p} value="" onValueChange={(v) => setForm({ ...form, phone: v })} />}</Field>
          <Field label="MRN">{(p) => <TextInput {...p} autoComplete="off" value={form.mrn} onChange={(e) => setForm({ ...form, mrn: e.target.value })} />}</Field>
        </div>
        {formError ? <Alert tone="critical" title="Check the search">{formError}</Alert> : null}
        <Button type="submit" loading={busy} icon={<Search aria-hidden="true" size={16} />}>
          Search
        </Button>
      </form>

      {problem ? <ProblemAlert problem={problem} /> : null}

      {results ? (
        <DataTable
          caption={`Search results: ${results.items.length}${results.nextCursor ? '+' : ''} ${results.items.length === 1 ? 'patient' : 'patients'}`}
          columns={columns}
          rows={results.items}
          rowKey={(p) => p.id}
          hasMore={Boolean(results.nextCursor)}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          emptyTitle="No patients found"
          emptyDescription="Check the spelling and date of birth, or register a new patient."
        />
      ) : null}
    </section>
  )
}
