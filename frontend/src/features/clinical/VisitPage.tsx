import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, etagOf, ifMatch, newIdempotencyKey } from '../../api/client'
import {
  addEncounterDiagnosis,
  addNoteAddendum,
  createNote,
  getEncounter,
  getNote,
  removeEncounterDiagnosis,
  searchCodes,
  signNote,
  updateNoteDraft,
} from '../../api/generated/endpoints/encounters/encounters'
import { getPatientSummaries } from '../../api/generated/endpoints/patients/patients'
import { listNoteTemplates } from '../../api/generated/endpoints/practice-setup/practice-setup'
import type { CodeMatch, Encounter, EncounterDiagnosis, Note, NoteSection, NoteTemplate, PatientSummary } from '../../api/generated/model'
import {
  ageInYears,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Field,
  formatDate,
  formatDateTime,
  formatNameFamilyFirst,
  Modal,
  ProblemAlert,
  Select,
  Spinner,
  Textarea,
  TextInput,
  todayIn,
  useToast,
  type Column,
  type Problem,
} from '../../design-system'
import { PrescriptionsSection } from '../medications/PrescriptionsSection'
import { catchProblem, Panel } from './parts'
import { roomingPath } from './TodayPage'

/** Notes may be started, and diagnoses changed, only while the visit is open. */
const OPEN = new Set(['arrived', 'triaged', 'in-progress'])

/** A signed note locks the encounter's diagnoses (D24); later changes go through entered-in-error. */
const SIGNED = new Set(['final', 'amended'])

const VERIFICATION = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'provisional', label: 'Provisional' },
  { value: 'differential', label: 'Differential' },
] as const
type Verification = (typeof VERIFICATION)[number]['value']

const VERIFICATION_LABEL: Record<string, string> = { confirmed: 'Confirmed', provisional: 'Provisional', differential: 'Differential', unconfirmed: 'Unconfirmed', refuted: 'Refuted' }

interface Loaded {
  encounter: Encounter
  patient: PatientSummary | null
}

async function load(encounterId: string): Promise<Loaded | null> {
  const res = await getEncounter(encounterId)
  if (res.status !== 200) return null
  const summaries = await getPatientSummaries({ patientIds: [res.data.patientId] })
  return { encounter: res.data, patient: summaries.status === 200 ? (summaries.data.items[0] ?? null) : null }
}

/**
 * The clinician's visit (demo step 8): the encounter's diagnoses (ICD-10-CM through `GET /codes`),
 * and its note: started from a template, edited as a draft, signed, then amended only by addenda.
 * Reached by the encounter's opaque ID only (D13).
 */
export function VisitPage() {
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
  const reason = encounter.reasons?.[0]?.text ?? encounter.reasons?.[0]?.codings?.[0]?.display
  // The note this screen works on: the newest one not entered in error.
  const note = encounter.notes.find((n) => n.status !== 'entered-in-error') ?? null
  const locked = encounter.notes.some((n) => SIGNED.has(n.status))
  const refresh = () => setVersion((v) => v + 1)

  return (
    <section aria-labelledby="visit-title" className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        {back}
        <Link to={roomingPath(encounter.id)} className="text-sm font-medium text-primary-700 hover:underline">
          Rooming and vitals
        </Link>
      </div>
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 id="visit-title" className="text-2xl font-semibold text-ink">
            Visit: {name}
          </h1>
          {patient ? (
            <p className="text-sm text-ink-muted">
              {patient.birthDate ? `DOB ${formatDate(patient.birthDate)}${age !== null ? ` (${age} y)` : ''} · ` : ''}MRN {patient.mrn}
            </p>
          ) : null}
          {patient?.restricted ? <Badge tone="warning">Restricted chart</Badge> : null}
        </div>
        <p className="text-ink">Reason for visit: {reason ?? '—'}</p>
      </header>
      {!open && !note ? <p className="rounded-lg border border-border bg-surface-1 p-4 text-ink-muted">This visit is closed; a note can no longer be started here.</p> : null}
      <DiagnosesSection encounter={encounter} editable={open && !locked} locked={locked} onChanged={refresh} />
      <NoteSection encounter={encounter} noteId={note?.id ?? null} open={open} onChanged={refresh} />
      <PrescriptionsSection encounter={encounter} open={open} />
    </section>
  )
}

// ---- Diagnoses -------------------------------------------------------------------------------

function codeText(d: EncounterDiagnosis): string {
  return d.code.display ? `${d.code.code} ${d.code.display}` : d.code.code
}

function DiagnosesSection({ encounter, editable, locked, onChanged }: { encounter: Encounter; editable: boolean; locked: boolean; onChanged: () => void }) {
  const [removing, setRemoving] = useState<EncounterDiagnosis | null>(null)
  const rows = [...encounter.diagnoses].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))

  const columns: Column<EncounterDiagnosis>[] = [
    { key: 'rank', header: 'Rank', render: (d) => d.rank ?? '—' },
    { key: 'code', header: 'Diagnosis (ICD-10-CM)', render: (d) => codeText(d) },
    { key: 'status', header: 'Status', render: (d) => VERIFICATION_LABEL[d.verificationStatus] ?? d.verificationStatus },
    ...(editable
      ? [
          {
            key: 'action',
            header: 'Action',
            render: (d: EncounterDiagnosis) => (
              <Button size="sm" variant="ghost" aria-label={`Remove ${codeText(d)}`} onClick={() => setRemoving(d)}>
                Remove
              </Button>
            ),
          },
        ]
      : []),
  ]

  return (
    <Panel title="Diagnoses" id="diagnoses-title">
      {locked ? <p className="text-sm text-ink-muted">The note is signed, so these diagnoses are locked.</p> : null}
      <DataTable caption="Diagnoses for this visit" columns={columns} rows={rows} rowKey={(d) => d.id} emptyTitle="No diagnoses yet" />
      {editable ? <AddDiagnosisForm encounter={encounter} onAdded={onChanged} /> : null}
      {removing ? (
        <RemoveDiagnosisDialog
          encounter={encounter}
          diagnosis={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null)
            onChanged()
          }}
        />
      ) : null}
    </Panel>
  )
}

const matchKey = (m: CodeMatch) => `${m.system}|${m.code}`

function AddDiagnosisForm({ encounter, onAdded }: { encounter: Encounter; onAdded: () => void }) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<CodeMatch[] | null>(null)
  const [picked, setPicked] = useState('')
  const [verification, setVerification] = useState<Verification>('confirmed')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  // One key per chosen diagnosis: kept while it is retried, replaced when the choice changes.
  const key = useRef<string | null>(null)

  async function search() {
    const q = query.trim()
    if (q.length < 2) {
      setError('Enter at least 2 characters of a code or name.')
      return
    }
    setError(undefined)
    setProblem(null)
    try {
      // Reference data only: no patient data goes in this query string (D13).
      const res = await searchCodes({ system: 'icd-10-cm', q, billableOnly: true, limit: 10 })
      if (res.status === 200) {
        setMatches(res.data.items)
        setPicked(res.data.items[0] ? matchKey(res.data.items[0]) : '')
        key.current = null
      }
    } catch (e) {
      catchProblem(setProblem)(e)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    const match = matches?.find((m) => matchKey(m) === picked)
    if (!match) {
      setError(matches ? 'Choose a diagnosis from the list.' : 'Search for a diagnosis first.')
      return
    }
    key.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await addEncounterDiagnosis(
        encounter.id,
        { code: { system: match.system, code: match.code, display: match.display }, verificationStatus: verification },
        { 'Idempotency-Key': key.current },
      )
      if (res.status === 201) {
        toast.show(`${match.code} added`)
        key.current = null
        setQuery('')
        setMatches(null)
        setPicked('')
        onAdded()
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void add(e)} noValidate className="space-y-4 border-t border-border pt-4">
      <h3 className="text-base font-semibold text-ink">Add a diagnosis</h3>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Field label="Diagnosis" hint="An ICD-10-CM code or words, for example J06.9 or sinusitis" error={error}>
            {(p) => (
              <TextInput
                {...p}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setMatches(null)
                  setPicked('')
                  setError(undefined)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void search()
                  }
                }}
              />
            )}
          </Field>
        </div>
        <Button variant="outline" onClick={() => void search()}>
          Search codes
        </Button>
      </div>
      {matches ? (
        matches.length === 0 ? (
          <p className="text-sm text-ink-muted">No billable ICD-10-CM codes match. Try other words or a code.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label="Matching codes">
              {(p) => (
                <Select
                  {...p}
                  value={picked}
                  onChange={(e) => {
                    setPicked(e.target.value)
                    key.current = null
                  }}
                >
                  {matches.map((m) => (
                    <option key={matchKey(m)} value={matchKey(m)}>
                      {m.code} {m.display}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {(p) => (
                <Select
                  {...p}
                  value={verification}
                  onChange={(e) => {
                    setVerification(e.target.value as Verification)
                    key.current = null
                  }}
                >
                  {VERIFICATION.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )
      ) : null}
      <Button type="submit" loading={busy} disabled={!matches || matches.length === 0}>
        Add diagnosis
      </Button>
    </form>
  )
}

function RemoveDiagnosisDialog({ encounter, diagnosis, onClose, onRemoved }: { encounter: Encounter; diagnosis: EncounterDiagnosis; onClose: () => void; onRemoved: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  async function remove() {
    if (!reason.trim()) {
      setError('Give the reason for removing it.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const res = await removeEncounterDiagnosis(encounter.id, diagnosis.id, { reason: reason.trim() })
      if (res.status === 200) {
        toast.show(`${diagnosis.code.code} removed`)
        onRemoved()
      }
    } catch (e) {
      catchProblem(setProblem)(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title="Remove this diagnosis?"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            Remove diagnosis
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-ink">
          {codeText(diagnosis)} is marked entered in error with your reason, and left out of the chart and claims. Nothing is deleted.
        </p>
        {problem ? <ProblemAlert problem={problem} /> : null}
        <Field label="Reason" error={error}>
          {(p) => (
            <Textarea
              {...p}
              value={reason}
              limit={500}
              onChange={(e) => {
                setReason(e.target.value)
                setError(undefined)
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  )
}

// ---- The note --------------------------------------------------------------------------------

interface LoadedNote {
  note: Note
  etag: string | null
}

function NoteSection({ encounter, noteId, open, onChanged }: { encounter: Encounter; noteId: string | null; open: boolean; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<LoadedNote | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  // A save or sign refused because the note changed elsewhere (412): shown over the reloaded note.
  const [conflict, setConflict] = useState<Problem | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!noteId) return
    let current = true
    getNote(noteId)
      .then((res) => {
        if (current && res.status === 200) setLoaded({ note: res.data, etag: etagOf(res) })
      })
      .catch((error: unknown) => {
        if (current) catchProblem(setProblem)(error)
      })
    return () => {
      current = false
    }
  }, [noteId, version])

  // A note's own changes keep its newest ETag; the encounter reloads for what depends on the note.
  const changed = (next: LoadedNote) => {
    setConflict(null)
    setLoaded(next)
    onChanged()
  }
  const saved = (next: LoadedNote) => {
    setConflict(null)
    setLoaded(next)
  }
  // The draft starts again from the saved version, so a later save can't overwrite the other change.
  const reload = (p: Problem) => {
    setConflict(p)
    setLoaded(null)
    setVersion((v) => v + 1)
  }

  return (
    <Panel title="Note" id="note-title">
      {problem ? <ProblemAlert problem={problem} /> : null}
      {conflict ? <ProblemAlert problem={conflict} /> : null}
      {!noteId ? (
        open ? <StartNoteForm encounter={encounter} onStarted={onChanged} /> : <p className="text-ink-muted">No note was written for this visit.</p>
      ) : !loaded || loaded.note.id !== noteId ? (
        problem ? null : <Spinner label="Loading the note" />
      ) : SIGNED.has(loaded.note.status) ? (
        <SignedNote loaded={loaded} timeZone={encounter.timeZone} onAmended={changed} />
      ) : (
        <DraftNote key={version} loaded={loaded} timeZone={encounter.timeZone} onSaved={saved} onSigned={changed} onConflict={reload} />
      )}
    </Panel>
  )
}

function StartNoteForm({ encounter, onStarted }: { encounter: Encounter; onStarted: () => void }) {
  const toast = useToast()
  const [templates, setTemplates] = useState<NoteTemplate[] | null>(null)
  const [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const key = useRef<string | null>(null)

  useEffect(() => {
    let current = true
    listNoteTemplates({ active: true, limit: 100 })
      .then((res) => {
        if (!current || res.status !== 200) return
        setTemplates(res.data.items)
        setTemplateId(res.data.items[0]?.id ?? '')
      })
      .catch((error: unknown) => {
        if (current) catchProblem(setProblem)(error)
      })
    return () => {
      current = false
    }
  }, [])

  async function start(e: FormEvent) {
    e.preventDefault()
    if (!templateId) return
    key.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await createNote(encounter.id, { templateId }, { 'Idempotency-Key': key.current })
      if (res.status === 201) {
        toast.show('Note started')
        key.current = null
        onStarted()
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  if (!templates) return problem ? <ProblemAlert problem={problem} /> : <Spinner label="Loading note templates" />

  return (
    <form onSubmit={(e) => void start(e)} className="space-y-4">
      {problem ? <ProblemAlert problem={problem} /> : null}
      {templates.length === 0 ? (
        <p className="text-ink-muted">The practice has no active note templates yet. An administrator adds them in practice setup.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label="Template">
              {(p) => (
                <Select
                  {...p}
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.target.value)
                    key.current = null
                  }}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.personal ? ' (personal)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button type="submit" loading={busy}>
            Start note
          </Button>
        </div>
      )}
    </form>
  )
}

const bySequence = (a: NoteSection, b: NoteSection) => a.sequence - b.sequence

/** The sign refusal's errors point at the note's own section order: `/sections/{i}/text`. */
function sectionErrors(problem: Problem | null, note: Note): Record<string, string> {
  const found: Record<string, string> = {}
  for (const e of problem?.errors ?? []) {
    const m = /^\/sections\/(\d+)\/(text|aiDecision)$/.exec(e.pointer ?? '')
    const section = m ? note.sections[Number(m[1])] : undefined
    if (section) found[section.id] = m![2] === 'text' ? 'This section is required. Write it before signing.' : 'Accept, edit or reject the AI draft first.'
  }
  return found
}

function DraftNote({
  loaded,
  timeZone,
  onSaved,
  onSigned,
  onConflict,
}: {
  loaded: LoadedNote
  timeZone: string
  onSaved: (next: LoadedNote) => void
  onSigned: (next: LoadedNote) => void
  onConflict: (problem: Problem) => void
}) {
  const toast = useToast()
  const { note } = loaded
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(note.sections.map((s) => [s.id, s.text])))
  const [saving, setSaving] = useState(false)
  const [signing, setSigning] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  const saved = Object.fromEntries(note.sections.map((s) => [s.id, s.text]))
  const dirty = note.sections.filter((s) => (texts[s.id] ?? '') !== s.text)
  const errors = sectionErrors(problem, note)
  const labels = Object.fromEntries(note.sections.map((s, i) => [`/sections/${i}/text`, s.title]))

  // Saves run one at a time against the newest version, so leaving a section and then signing
  // (or saving twice) never sends an outdated If-Match.
  const latest = useRef(loaded)
  const latestTexts = useRef(texts)
  const inFlight = useRef<Promise<LoadedNote | null> | null>(null)
  useEffect(() => {
    latest.current = loaded
  }, [loaded])
  useEffect(() => {
    latestTexts.current = texts
  }, [texts])

  /** Saves the changed sections; returns the newest version, or null when the save was refused. */
  async function save(): Promise<LoadedNote | null> {
    if (inFlight.current) await inFlight.current
    const run = saveNow()
    inFlight.current = run
    try {
      return await run
    } finally {
      if (inFlight.current === run) inFlight.current = null
    }
  }

  async function saveNow(): Promise<LoadedNote | null> {
    const { note: current, etag: currentEtag } = latest.current
    const changes = current.sections.filter((s) => (latestTexts.current[s.id] ?? '') !== s.text)
    if (changes.length === 0) return latest.current
    if (!currentEtag) return null
    setSaving(true)
    setProblem(null)
    try {
      const res = await updateNoteDraft(current.id, { sections: changes.map((s) => ({ id: s.id, text: latestTexts.current[s.id] ?? '' })) }, ifMatch(currentEtag))
      if (res.status === 200) {
        const next = { note: res.data, etag: etagOf(res) }
        latest.current = next
        onSaved(next)
        return next
      }
      return null
    } catch (error) {
      // A 412 means the note changed in another tab: load it, so the next save starts from it.
      if (error instanceof ApiError && error.status === 412) onConflict(error.problem)
      else catchProblem(setProblem)(error)
      return null
    } finally {
      setSaving(false)
    }
  }

  async function sign() {
    setConfirm(false)
    const current = await save()
    if (!current?.etag) return
    setSigning(true)
    setProblem(null)
    try {
      const res = await signNote(note.id, ifMatch(current.etag))
      if (res.status === 200) {
        toast.show('Note signed')
        onSigned({ note: res.data, etag: etagOf(res) })
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) onConflict(error.problem)
      else catchProblem(setProblem)(error)
    } finally {
      setSigning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-ink">{note.title}</h3>
        <Badge tone="warning">Draft</Badge>
        <span className="text-sm text-ink-muted">
          {note.author.displayName} · last saved {formatDateTime(note.updatedAt, timeZone)}
        </span>
      </div>
      {problem ? <ProblemAlert problem={problem} fieldLabels={labels} /> : null}
      {[...note.sections].sort(bySequence).map((s) => (
        <Field key={s.id} label={s.required ? `${s.title} (required)` : s.title} error={errors[s.id]}>
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              value={texts[s.id] ?? ''}
              limit={20000}
              onChange={(e) => setTexts((t) => ({ ...t, [s.id]: e.target.value }))}
              // Saved when leaving a section (updateNoteDraft: autosave when leaving a section).
              onBlur={() => {
                if ((texts[s.id] ?? '') !== saved[s.id]) void save()
              }}
            />
          )}
        </Field>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" loading={saving && !signing} disabled={dirty.length === 0 || signing} onClick={() => void save()}>
          Save draft
        </Button>
        <Button loading={signing} onClick={() => setConfirm(true)}>
          Sign note
        </Button>
        <span role="status" className="text-sm text-ink-muted">
          {dirty.length > 0 ? 'Unsaved changes' : 'All changes saved'}
        </span>
      </div>
      <ConfirmDialog open={confirm} title="Sign this note?" confirmLabel="Sign note" onConfirm={() => void sign()} onCancel={() => setConfirm(false)}>
        <p className="text-ink">Once signed, the note is the legal record and can't be edited. Later changes are added as addenda. The visit's diagnoses are locked too.</p>
      </ConfirmDialog>
    </div>
  )
}

function SignedNote({ loaded, timeZone, onAmended }: { loaded: LoadedNote; timeZone: string; onAmended: (next: LoadedNote) => void }) {
  const { note } = loaded
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-ink">{note.title}</h3>
        <Badge tone="success">{note.status === 'amended' ? 'Signed, amended' : 'Signed'}</Badge>
        {note.cosignStatus === 'pending' ? <Badge tone="warning">Awaiting co-signature</Badge> : null}
        <span className="text-sm text-ink-muted">
          {note.signedBy?.displayName ?? note.author.displayName}
          {note.signedAt ? ` · ${formatDateTime(note.signedAt, timeZone)}` : ''}
        </span>
      </div>
      <dl className="space-y-3">
        {[...note.sections].sort(bySequence).map((s) => (
          <div key={s.id}>
            <dt className="text-sm font-semibold text-ink">{s.title}</dt>
            <dd className="whitespace-pre-wrap text-ink">{s.text || '—'}</dd>
          </div>
        ))}
      </dl>
      {note.addenda.length > 0 ? (
        <section aria-labelledby="addenda-title" className="space-y-3 border-t border-border pt-4">
          <h3 id="addenda-title" className="text-base font-semibold text-ink">
            Addenda
          </h3>
          <ol className="space-y-3">
            {note.addenda.map((a) => (
              <li key={a.id} className="rounded-lg border border-border p-3">
                <p className="whitespace-pre-wrap text-ink">{a.text}</p>
                <p className="mt-1 text-sm text-ink-muted">
                  {a.author.displayName} · {formatDateTime(a.signedAt, timeZone)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <AddendumForm loaded={loaded} onAdded={onAmended} />
    </div>
  )
}

function AddendumForm({ loaded, onAdded }: { loaded: LoadedNote; onAdded: (next: LoadedNote) => void }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const key = useRef<string | null>(null)

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) {
      setError('Write the addendum first.')
      return
    }
    if (!loaded.etag) return
    key.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await addNoteAddendum(loaded.note.id, { text: text.trim() }, { ...ifMatch(loaded.etag), 'Idempotency-Key': key.current })
      if (res.status === 200) {
        toast.show('Addendum signed')
        key.current = null
        setText('')
        onAdded({ note: res.data, etag: etagOf(res) })
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void add(e)} noValidate className="space-y-3 border-t border-border pt-4">
      <h3 className="text-base font-semibold text-ink">Add an addendum</h3>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <Field label="Addendum" hint="Signed as soon as you add it" error={error}>
        {(p) => (
          <Textarea
            {...p}
            value={text}
            limit={20000}
            onChange={(e) => {
              setText(e.target.value)
              setError(undefined)
              key.current = null
            }}
          />
        )}
      </Field>
      <Button type="submit" loading={busy}>
        Sign addendum
      </Button>
    </form>
  )
}
