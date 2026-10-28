import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, etagOf, ifMatch, newIdempotencyKey } from '../../api/client'
import { getEncounter, recordVitals, searchCodes, updateEncounter } from '../../api/generated/endpoints/encounters/encounters'
import { addAllergy, listAllergies } from '../../api/generated/endpoints/history/history'
import { getPatientSummaries } from '../../api/generated/endpoints/patients/patients'
import { listBookableLocations, recordVisitStatus } from '../../api/generated/endpoints/scheduling/scheduling'
import type { Allergy, AllergyCreate, BookableLocation, CodeMatch, Encounter, PatientSummary, Vital } from '../../api/generated/model'
import {
  ageInYears,
  Badge,
  Button,
  DataTable,
  Field,
  formatDate,
  formatDateTime,
  formatNameFamilyFirst,
  ProblemAlert,
  Select,
  Spinner,
  Textarea,
  TextInput,
  todayIn,
  toUsDisplay,
  useToast,
  type Column,
  type Problem,
} from '../../design-system'
import { bmi, EMPTY_VITALS, INTERPRETATION, SINGLE_VITALS, toVitalEntries, VITAL_LABEL, type VitalsErrors, type VitalsForm } from './vitals'

/** SNOMED CT "No known allergy" (716186003), the statement the contract names for it. */
const NO_KNOWN_ALLERGY = { codings: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text: 'No known allergies' }

/** Vitals may be recorded, and the reason edited, only while the visit is open. */
const OPEN = new Set(['arrived', 'triaged', 'in-progress'])

interface Loaded {
  encounter: Encounter
  etag: string | null
  patient: PatientSummary | null
  rooms: BookableLocation[]
}

function catchProblem(set: (p: Problem) => void) {
  return (error: unknown) => {
    if (error instanceof ApiError) set(error.problem)
    else throw error
  }
}

/**
 * Rooming one checked-in patient (demo step 7): the exam room, the reason for the visit, vitals
 * and allergies. Reached from Today by the encounter's opaque ID only (D13). Current medications
 * join this screen with the prescriptions slice (#93).
 */
/** The encounter with its ETag, the patient's minimum-necessary summary (D54) and the facility's rooms. */
async function load(encounterId: string): Promise<Loaded | null> {
  const res = await getEncounter(encounterId)
  if (res.status !== 200) return null
  const encounter = res.data
  const [summaries, locations] = await Promise.all([
    getPatientSummaries({ patientIds: [encounter.patientId] }),
    listBookableLocations({ facilityId: encounter.facilityId, limit: 100 }),
  ])
  const rooms = locations.status === 200 ? locations.data.items : []
  const examRooms = rooms.filter((l) => l.physicalType === 'ro')
  return {
    encounter,
    etag: etagOf(res),
    patient: summaries.status === 200 ? (summaries.data.items[0] ?? null) : null,
    rooms: examRooms.length > 0 ? examRooms : rooms,
  }
}

export function RoomingPage() {
  const { encounterId = '' } = useParams()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    load(encounterId)
      .then((l) => {
        if (current && l) setLoaded(l)
      })
      .catch((error: unknown) => {
        if (current) catchProblem(setProblem)(error)
      })
    return () => {
      current = false
    }
  }, [encounterId, version])

  const back = (
    <Link to="/today" className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
      <ArrowLeft aria-hidden="true" size={14} /> Today
    </Link>
  )

  if (problem) {
    return (
      <section className="space-y-4">
        {back}
        <ProblemAlert problem={problem} />
      </section>
    )
  }
  if (!loaded) return <Spinner label="Loading the visit" />

  const { encounter, patient } = loaded
  const open = OPEN.has(encounter.status)
  const name = patient ? formatNameFamilyFirst(patient.name) : 'Patient'
  const age = patient?.birthDate ? ageInYears(patient.birthDate, todayIn(encounter.timeZone)) : null
  const refresh = () => setVersion((v) => v + 1)

  return (
    <section aria-labelledby="rooming-title" className="space-y-6">
      {back}
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 id="rooming-title" className="text-2xl font-semibold text-ink">
          Rooming: {name}
        </h1>
        {patient ? (
          <p className="text-sm text-ink-muted">
            {patient.birthDate ? `DOB ${formatDate(patient.birthDate)}${age !== null ? ` (${age} y)` : ''} · ` : ''}MRN {patient.mrn}
          </p>
        ) : null}
        {patient?.restricted ? <Badge tone="warning">Restricted chart</Badge> : null}
      </header>
      {!open ? <p className="rounded-lg border border-border bg-surface-1 p-4 text-ink-muted">This visit is closed; it can no longer be changed here.</p> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <RoomSection loaded={loaded} open={open} onChanged={refresh} />
        <ReasonSection loaded={loaded} open={open} onChanged={refresh} />
      </div>
      <VitalsSection encounter={encounter} open={open} onChanged={refresh} />
      <AllergiesSection encounter={encounter} open={open} />
    </section>
  )
}

function Panel({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-xl border border-border bg-surface-1 p-5">
      <h2 id={id} className="text-lg font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  )
}

function RoomSection({ loaded, open, onChanged }: { loaded: Loaded; open: boolean; onChanged: () => void }) {
  const { encounter, rooms } = loaded
  const toast = useToast()
  const current = rooms.find((r) => r.id === encounter.locationId)
  const [roomId, setRoomId] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const appointmentId = encounter.appointmentId

  async function room(e: FormEvent) {
    e.preventDefault()
    if (!appointmentId || !roomId) return
    setBusy(true)
    setProblem(null)
    try {
      const res = await recordVisitStatus(appointmentId, { status: 'roomed', roomLocationId: roomId })
      if (res.status === 200) {
        toast.show(`Roomed in ${rooms.find((r) => r.id === roomId)?.name ?? 'the room'}`)
        setRoomId('')
        onChanged()
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Exam room" id="room-title">
      <p className="text-ink">{current ? `Current room: ${current.name}` : encounter.locationId ? 'Roomed' : 'Not roomed yet'}</p>
      {problem ? <ProblemAlert problem={problem} /> : null}
      {open && appointmentId ? (
        <form onSubmit={(e) => void room(e)} className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <Field label="Room">
              {(p) => (
                <Select {...p} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                  <option value="">Choose a room</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button type="submit" loading={busy} disabled={!roomId}>
            {encounter.locationId ? 'Move to this room' : 'Mark as roomed'}
          </Button>
        </form>
      ) : null}
    </Panel>
  )
}

function reasonText(encounter: Encounter): string {
  const r = encounter.reasons?.[0]
  return r?.text ?? r?.codings?.[0]?.display ?? ''
}

function ReasonSection({ loaded, open, onChanged }: { loaded: Loaded; open: boolean; onChanged: () => void }) {
  const { encounter, etag } = loaded
  const toast = useToast()
  const saved = reasonText(encounter)
  const [text, setText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!etag) return
    setBusy(true)
    setProblem(null)
    try {
      const trimmed = text.trim()
      const res = await updateEncounter(encounter.id, { reasons: trimmed ? [{ text: trimmed }] : null }, ifMatch(etag))
      if (res.status === 200) {
        toast.show('Reason for visit saved')
        onChanged()
      }
    } catch (error) {
      catchProblem(setProblem)(error)
      // A 412 means someone else changed the visit: show theirs next to the problem.
      if (error instanceof ApiError && error.status === 412) onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Reason for visit" id="reason-title">
      {problem ? <ProblemAlert problem={problem} /> : null}
      {open ? (
        <form onSubmit={(e) => void save(e)} className="space-y-3">
          <Field label="Reason for visit" hint="In the patient’s words">
            {(p) => <Textarea {...p} value={text} limit={1000} onChange={(e) => setText(e.target.value)} />}
          </Field>
          <Button type="submit" loading={busy} disabled={text.trim() === saved || !etag}>
            Save reason
          </Button>
        </form>
      ) : (
        <p className="text-ink">{saved || '—'}</p>
      )}
    </Panel>
  )
}

function vitalValue(v: Vital): string {
  if (v.bloodPressure) return `${v.bloodPressure.systolic.value}/${v.bloodPressure.diastolic.value} mmHg`
  return v.value ? toUsDisplay(v.value).text : '—'
}

function VitalsSection({ encounter, open, onChanged }: { encounter: Encounter; open: boolean; onChanged: () => void }) {
  const toast = useToast()
  const [form, setForm] = useState<VitalsForm>(EMPTY_VITALS)
  const [errors, setErrors] = useState<VitalsErrors>({})
  const [nothing, setNothing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  // One key per set of readings: kept while the same readings are retried, replaced when one changes.
  const key = useRef<string | null>(null)

  function update(changes: Partial<VitalsForm>) {
    setForm((f) => ({ ...f, ...changes }))
    setNothing(false)
    key.current = null
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const { entries, errors: found } = toVitalEntries(form)
    setErrors(found)
    setNothing(Object.keys(found).length === 0 && entries.length === 0)
    if (Object.keys(found).length > 0 || entries.length === 0) return
    key.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await recordVitals(encounter.id, { entries }, { 'Idempotency-Key': key.current })
      if (res.status === 201) {
        const flagged = res.data.vitals.filter((v) => v.interpretation && v.interpretation !== 'N').length
        toast.show(flagged ? `Vitals saved; ${flagged} out of range` : 'Vitals saved')
        setForm(EMPTY_VITALS)
        key.current = null
        onChanged()
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<Vital>[] = [
    { key: 'type', header: 'Vital', render: (v) => VITAL_LABEL[v.type] },
    {
      key: 'value',
      header: 'Value',
      render: (v) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{vitalValue(v)}</span>
          {v.interpretation && INTERPRETATION[v.interpretation] ? <Badge tone={INTERPRETATION[v.interpretation]!.tone}>{INTERPRETATION[v.interpretation]!.label}</Badge> : null}
        </span>
      ),
    },
    { key: 'at', header: 'Taken', render: (v) => formatDateTime(v.effectiveAt, encounter.timeZone) },
  ]
  const computedBmi = bmi(form)

  return (
    <Panel title="Vitals" id="vitals-title">
      {problem ? <ProblemAlert problem={problem} /> : null}
      {open ? (
        <form onSubmit={(e) => void save(e)} noValidate className="space-y-4">
          <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <legend className="sr-only">New readings</legend>
            <Field label="Systolic (mmHg)" error={errors.systolic}>
              {(p) => <TextInput {...p} inputMode="numeric" value={form.systolic} onChange={(e) => update({ systolic: e.target.value })} />}
            </Field>
            <Field label="Diastolic (mmHg)" error={errors.diastolic}>
              {(p) => <TextInput {...p} inputMode="numeric" value={form.diastolic} onChange={(e) => update({ diastolic: e.target.value })} />}
            </Field>
            {SINGLE_VITALS.map((v) => (
              <Field key={v.field} label={`${v.label} (${v.unitLabel})`} error={errors[v.field]}>
                {(p) => <TextInput {...p} inputMode={v.decimals ? 'decimal' : 'numeric'} value={form[v.field]} onChange={(e) => update({ [v.field]: e.target.value })} />}
              </Field>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" loading={busy}>
              Save vitals
            </Button>
            {computedBmi !== null ? <span className="text-sm text-ink-muted">BMI {computedBmi} kg/m²</span> : null}
            {nothing ? (
              <span role="alert" className="text-sm text-critical-fg">
                Enter at least one vital sign.
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
      <DataTable caption="Vitals taken this visit" columns={columns} rows={encounter.vitals} rowKey={(v) => v.id} emptyTitle="No vitals yet this visit" />
    </Panel>
  )
}

function allergyName(a: Allergy): string {
  return a.code.text ?? a.code.codings?.[0]?.display ?? '—'
}

function AllergiesSection({ encounter, open }: { encounter: Encounter; open: boolean }) {
  const toast = useToast()
  const [items, setItems] = useState<Allergy[] | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    listAllergies(encounter.patientId, { limit: 100 })
      .then((res) => {
        if (current && res.status === 200) setItems(res.data.items)
      })
      .catch((error: unknown) => {
        if (current) catchProblem(setProblem)(error)
      })
    return () => {
      current = false
    }
  }, [encounter.patientId, version])

  const added = (what: string) => {
    toast.show(what)
    setVersion((v) => v + 1)
  }

  const columns: Column<Allergy>[] = [
    { key: 'substance', header: 'Substance', render: (a) => allergyName(a) },
    { key: 'type', header: 'Type', render: (a) => (a.type === 'intolerance' ? 'Intolerance' : a.type === 'allergy' ? 'Allergy' : '—') },
    { key: 'reaction', header: 'Reaction', render: (a) => a.reactions?.map((r) => [r.manifestations.map((m) => m.text ?? m.codings?.[0]?.display).join(', '), r.severity].filter(Boolean).join(' · ')).join('; ') || '—' },
    {
      key: 'criticality',
      header: 'Criticality',
      render: (a) => (a.criticality === 'high' ? <Badge tone="critical">High</Badge> : a.criticality === 'low' ? 'Low' : a.criticality === 'unable-to-assess' ? 'Unable to assess' : '—'),
    },
    { key: 'status', header: 'Status', render: (a) => (a.clinicalStatus ? a.clinicalStatus[0]!.toUpperCase() + a.clinicalStatus.slice(1) : '—') },
  ]

  return (
    <Panel title="Allergies" id="allergies-title">
      {problem ? <ProblemAlert problem={problem} /> : null}
      {!items ? (
        problem ? null : <Spinner label="Loading allergies" />
      ) : (
        <DataTable caption="Allergies on the chart" columns={columns} rows={items} rowKey={(a) => a.id} emptyTitle="No allergies recorded" emptyDescription="Ask the patient, then record the allergies or “no known allergies”." />
      )}
      {open ? <AddAllergyForm encounter={encounter} onAdded={added} /> : null}
    </Panel>
  )
}

const SEVERITIES = [
  { value: '', label: 'Not stated' },
  { value: 'mild', label: 'Mild' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
] as const

function AddAllergyForm({ encounter, onAdded }: { encounter: Encounter; onAdded: (message: string) => void }) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<CodeMatch[] | null>(null)
  const [picked, setPicked] = useState('')
  const [type, setType] = useState<'allergy' | 'intolerance'>('allergy')
  const [criticality, setCriticality] = useState<'' | 'low' | 'high' | 'unable-to-assess'>('')
  const [reaction, setReaction] = useState('')
  const [severity, setSeverity] = useState<'' | 'mild' | 'moderate' | 'severe'>('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  // One key per action, kept while it is retried: the typed allergy and "no known allergies" are
  // different requests, so each has its own.
  const key = useRef<string | null>(null)
  const nkaKey = useRef<string | null>(null)

  async function search() {
    const q = query.trim()
    if (q.length < 2) {
      setError('Enter at least 2 letters.')
      return
    }
    setError(undefined)
    setProblem(null)
    try {
      // Drug names only: no patient data goes in this query string (D13).
      const res = await searchCodes({ system: 'rxnorm', q, limit: 10 })
      if (res.status === 200) {
        setMatches(res.data.items)
        setPicked(res.data.items[0] ? `${res.data.items[0].system}|${res.data.items[0].code}` : '')
      }
    } catch (e) {
      catchProblem(setProblem)(e)
    }
  }

  async function send(body: AllergyCreate, message: string, which: React.RefObject<string | null>) {
    which.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await addAllergy(encounter.patientId, body, { 'Idempotency-Key': which.current })
      if (res.status === 201) {
        which.current = null
        setQuery('')
        setMatches(null)
        setPicked('')
        setReaction('')
        setSeverity('')
        setCriticality('')
        onAdded(message)
      }
    } catch (e) {
      catchProblem(setProblem)(e)
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = query.trim()
    const match = matches?.find((m) => `${m.system}|${m.code}` === picked)
    if (!match && !text) {
      setError('Search for the substance, or type its name.')
      return
    }
    // A coded drug (RxNorm) is what the prescription safety check matches on (D99); text is kept otherwise.
    const code = match ? { codings: [{ system: match.system, code: match.code, display: match.display }], text: match.display } : { text }
    const body: AllergyCreate = {
      code,
      type,
      encounterId: encounter.id,
      ...(criticality ? { criticality } : {}),
      ...(reaction.trim() ? { reactions: [{ manifestations: [{ text: reaction.trim() }], ...(severity ? { severity } : {}) }] } : {}),
    }
    void send(body, `Allergy to ${code.text} recorded`, key)
  }

  const changed = () => {
    key.current = null
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 border-t border-border pt-4">
      <h3 className="text-base font-semibold text-ink">Record an allergy</h3>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Field label="Substance" hint="A drug name finds its RxNorm code; other substances can be typed" error={error}>
            {(p) => (
              <TextInput
                {...p}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setMatches(null)
                  setPicked('')
                  changed()
                }}
              />
            )}
          </Field>
        </div>
        <Button variant="outline" onClick={() => void search()}>
          Search drugs
        </Button>
      </div>
      {matches ? (
        matches.length === 0 ? (
          <p className="text-sm text-ink-muted">No drug matches; it will be recorded as typed.</p>
        ) : (
          <Field label="Drug">
            {(p) => (
              <Select
                {...p}
                value={picked}
                onChange={(e) => {
                  setPicked(e.target.value)
                  changed()
                }}
              >
                {matches.map((m) => (
                  <option key={`${m.system}|${m.code}`} value={`${m.system}|${m.code}`}>
                    {m.display}
                  </option>
                ))}
                <option value="">None of these: record as typed</option>
              </Select>
            )}
          </Field>
        )
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Type">
          {(p) => (
            <Select
              {...p}
              value={type}
              onChange={(e) => {
                setType(e.target.value as 'allergy' | 'intolerance')
                changed()
              }}
            >
              <option value="allergy">Allergy</option>
              <option value="intolerance">Intolerance</option>
            </Select>
          )}
        </Field>
        <Field label="Criticality">
          {(p) => (
            <Select
              {...p}
              value={criticality}
              onChange={(e) => {
                setCriticality(e.target.value as typeof criticality)
                changed()
              }}
            >
              <option value="">Not stated</option>
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="unable-to-assess">Unable to assess</option>
            </Select>
          )}
        </Field>
        <Field label="Reaction" hint="For example, hives">
          {(p) => (
            <TextInput
              {...p}
              value={reaction}
              onChange={(e) => {
                setReaction(e.target.value)
                changed()
              }}
            />
          )}
        </Field>
        <Field label="Severity">
          {(p) => (
            <Select
              {...p}
              value={severity}
              disabled={!reaction.trim()}
              onChange={(e) => {
                setSeverity(e.target.value as typeof severity)
                changed()
              }}
            >
              {SEVERITIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy}>
          Record allergy
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void send({ code: NO_KNOWN_ALLERGY, encounterId: encounter.id }, 'No known allergies recorded', nkaKey)}>
          No known allergies
        </Button>
      </div>
    </form>
  )
}
