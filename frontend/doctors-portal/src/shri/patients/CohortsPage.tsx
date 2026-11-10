/**
 * S-05-10 · Patient cohorts — `/patients/cohorts`, the third tab of My
 * patients. The doctor segregates their patients for study or research: by
 * ICD-10 diagnosis (a code, a whole category, or a chapter; from any source in
 * the record or one; open problems only or all) and by demographics (age band,
 * sex, facility, payer, how they are being seen, ABHA linked).
 *
 * Every filter lives in the address, so a cohort survives a reload and can be
 * shared; a cohort can be saved under a name. The list shows each patient with
 * the codes that put them in it. No AI and no prediction: filters over the
 * record as it stands.
 *
 * Export is for study, so it is de-identified: a study ID, an age band (never
 * the age), sex, facility, payer, how seen, and the ICD-10 codes — no name,
 * UHID, ABHA or bed. Only a doctor holding `record.export` sees it, and each
 * export is on the audit trail with the filters and the count, never the
 * patients.
 */

import { Download, Layers, Save, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { can } from '@/atlas/personas'
import { encounterForPatient, type EncounterType } from '@/data/clinical'
import { NOW, formatDate } from '@/data/format'
import { ICD_CHAPTERS, icdCategory, icdCategoryLabel, icdChapter, icdLabel, icdMatches, normaliseIcd } from '@/data/icd10'
import { FACILITIES, PATIENTS, type Patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { csvRow, downloadText } from '../lib/download'
import { SOURCE_LABEL, useDiagnosesByPatient, type CodedDiagnosis, type DiagnosisSource } from '../logic/diagnoses'
import { recordPath } from '../logic/record'
import { useCohorts } from '../state/cohorts'
import { CheckboxRow, Field, Select, TextInput } from '../ui/forms'
import { IcdPicker } from '../ui/IcdPicker'
import { Card, Chip, CountBubble, Icon, Pill, RoundButton } from '../ui/primitives'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

import { MyPatientsFrame } from './MyPatientsFrame'

// ──────────────────────────────────────────────────────────── the filters

const AGE_BANDS = [
  { key: '0-17', label: '0–17', min: 0, max: 17 },
  { key: '18-39', label: '18–39', min: 18, max: 39 },
  { key: '40-59', label: '40–59', min: 40, max: 59 },
  { key: '60-74', label: '60–74', min: 60, max: 74 },
  { key: '75+', label: '75+', min: 75, max: 200 },
] as const
const SEXES = [
  { key: 'F', label: 'Female' },
  { key: 'M', label: 'Male' },
  { key: 'O', label: 'Other' },
] as const
const SEEN_AS: { key: EncounterType; label: string }[] = [
  { key: 'OP', label: 'Outpatient' },
  { key: 'IP', label: 'Inpatient' },
  { key: 'ED', label: 'Emergency' },
  { key: 'TELE', label: 'Teleconsult' },
]
const PAYERS = [...new Set(PATIENTS.map((p) => p.payer))].sort()
const SOURCES: (DiagnosisSource | 'any')[] = ['any', 'problem', 'note', 'admission', 'discharge', 'death']

interface Filters {
  /** ICD-10 codes or three-character categories. */
  dx: string[]
  chapter: string
  match: 'any' | 'all'
  /** Whether a code or category also matches the codes under it (I63 → I63.9). */
  sub: boolean
  src: DiagnosisSource | 'any'
  status: 'open' | 'any'
  age: string[]
  sex: string
  fac: string
  payer: string[]
  seen: string[]
  abha: boolean
}

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : [])

function readFilters(q: URLSearchParams): Filters {
  const src = q.get('src')
  return {
    dx: list(q.get('dx')).map(normaliseIcd),
    chapter: ICD_CHAPTERS.some((c) => c.id === q.get('chapter')) ? q.get('chapter')! : '',
    match: q.get('match') === 'all' ? 'all' : 'any',
    sub: q.get('sub') !== '0',
    src: (SOURCES as string[]).includes(src ?? '') ? (src as DiagnosisSource | 'any') : 'any',
    status: q.get('status') === 'open' ? 'open' : 'any',
    age: list(q.get('age')).filter((a) => AGE_BANDS.some((b) => b.key === a)),
    sex: SEXES.some((s) => s.key === q.get('sex')) ? q.get('sex')! : '',
    fac: FACILITIES.some((f) => f.code === q.get('fac')) ? q.get('fac')! : '',
    payer: list(q.get('payer')).filter((p) => (PAYERS as string[]).includes(p)),
    seen: list(q.get('seen')).filter((s) => SEEN_AS.some((x) => x.key === s)),
    abha: q.get('abha') === 'linked',
  }
}

/** Only what differs from "everyone" is written, so a plain address opens on every patient. */
function writeFilters(f: Filters): URLSearchParams {
  const q = new URLSearchParams()
  if (f.dx.length) q.set('dx', f.dx.join(','))
  if (f.chapter) q.set('chapter', f.chapter)
  if (f.match === 'all') q.set('match', 'all')
  if (!f.sub) q.set('sub', '0')
  if (f.src !== 'any') q.set('src', f.src)
  if (f.status === 'open') q.set('status', 'open')
  if (f.age.length) q.set('age', f.age.join(','))
  if (f.sex) q.set('sex', f.sex)
  if (f.fac) q.set('fac', f.fac)
  if (f.payer.length) q.set('payer', f.payer.join(','))
  if (f.seen.length) q.set('seen', f.seen.join(','))
  if (f.abha) q.set('abha', 'linked')
  return q
}

const bandOf = (age: number) => AGE_BANDS.find((b) => age >= b.min && age <= b.max)!
const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

/** The filters in words — for the screen, the saved cohort and the audit row. */
function describeFilters(f: Filters): string {
  const parts = [
    f.dx.length ? `ICD-10 ${f.dx.join(f.match === 'all' ? ' and ' : ' or ')}${f.sub ? '' : ' (exact codes)'}` : '',
    f.chapter ? `chapter ${f.chapter}` : '',
    f.src !== 'any' ? `from the ${SOURCE_LABEL[f.src].toLowerCase()}` : '',
    f.status === 'open' ? 'open diagnoses only' : '',
    f.age.length ? `age ${f.age.map((a) => AGE_BANDS.find((b) => b.key === a)!.label).join(', ')}` : '',
    f.sex ? SEXES.find((s) => s.key === f.sex)!.label.toLowerCase() : '',
    f.fac ? f.fac : '',
    f.payer.length ? f.payer.join(', ') : '',
    f.seen.length ? f.seen.map((s) => SEEN_AS.find((x) => x.key === s)!.label.toLowerCase()).join(', ') : '',
    f.abha ? 'ABHA linked' : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'every patient'
}

interface CohortRow {
  patient: Patient
  seen?: EncounterType
  /** The codes that put the patient in the cohort (every code, with no diagnosis filter) — one per code. */
  codes: { code: string; label: string; sources: DiagnosisSource[] }[]
}

function cohortOf(f: Filters, dx: Record<string, CodedDiagnosis[]>): CohortRow[] {
  const out: CohortRow[] = []
  for (const p of PATIENTS) {
    if (f.age.length && !f.age.includes(bandOf(p.age).key)) continue
    if (f.sex && p.sex !== f.sex) continue
    if (f.fac && p.facilityCode !== f.fac) continue
    if (f.payer.length && !f.payer.includes(p.payer)) continue
    if (f.abha && p.abhaStatus !== 'Linked') continue
    const seen = encounterForPatient(p.id)?.type
    if (f.seen.length && (!seen || !f.seen.includes(seen))) continue

    let pool = (dx[p.id] ?? []).filter((d) => (f.src === 'any' || d.source === f.src) && (f.status === 'any' || d.open))
    if (f.chapter) pool = pool.filter((d) => icdChapter(d.code)?.id === f.chapter)
    if (f.dx.length) {
      const hits = f.dx.map((want) => pool.filter((d) => icdMatches(d.code, want, f.sub)))
      if (f.match === 'all' ? hits.some((h) => h.length === 0) : hits.every((h) => h.length === 0)) continue
      pool = [...new Set(hits.flat())]
    } else if ((f.chapter || f.src !== 'any' || f.status === 'open') && pool.length === 0) continue

    const byCode = new Map<string, CohortRow['codes'][number]>()
    for (const d of pool) {
      const have = byCode.get(d.code)
      if (have) {
        if (!have.sources.includes(d.source)) have.sources.push(d.source)
      } else byCode.set(d.code, { code: d.code, label: d.label, sources: [d.source] })
    }
    out.push({ patient: p, seen, codes: [...byCode.values()] })
  }
  return out
}

// ──────────────────────────────────────────────────────────── the page

export function CohortsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const f = readFilters(params)
  const update = (patch: Partial<Filters>) => setParams(writeFilters({ ...f, ...patch }), { replace: true })
  const reset = () => setParams(new URLSearchParams(), { replace: true })
  const dx = useDiagnosesByPatient()
  const rows = useMemo(() => cohortOf(f, dx), [params, dx]) // eslint-disable-line react-hooks/exhaustive-deps

  const persona = useSession((s) => s.persona)
  const mayExport = can(persona, 'record.export')
  const me = useCurrentStaff()
  const audit = useAudit((s) => s.record)
  const toast = useUI((s) => s.toast)
  const described = describeFilters(f)
  const filtered = params.toString() !== ''

  function exportCsv() {
    // Study IDs in a shuffled order, so the file's order cannot be matched back to the list on screen.
    const shuffled = [...rows].sort(() => Math.random() - 0.5)
    const header = ['study_id', 'age_band', 'sex', 'facility', 'payer', 'seen_as', 'icd10_codes', 'icd10_categories', 'icd10_chapters', 'diagnosis_sources']
    const lines = shuffled.map((r, i) => {
      const codes = r.codes.map((c) => c.code)
      return csvRow([
        `P-${String(i + 1).padStart(3, '0')}`,
        bandOf(r.patient.age).label,
        r.patient.sex,
        r.patient.facilityCode,
        r.patient.payer,
        r.seen ? (SEEN_AS.find((s) => s.key === r.seen)?.label ?? r.seen) : '',
        codes.join('; '),
        [...new Set(codes.map(icdCategory))].join('; '),
        [...new Set(codes.map((c) => icdChapter(c)?.id).filter(Boolean))].join('; '),
        [...new Set(r.codes.flatMap((c) => c.sources.map((s) => SOURCE_LABEL[s])))].join('; '),
      ])
    })
    const day = NOW.toISOString().slice(0, 10)
    downloadText(`cohort-de-identified-${day}.csv`, [csvRow(header), ...lines].join('\n') + '\n')
    audit({ event: 'COHORT.EXPORTED', actor: me.name, actorId: me.id, detail: `${rows.length} ${rows.length === 1 ? 'patient' : 'patients'} · de-identified CSV · ${described}` })
    toast({ tone: 'success', title: `Cohort exported — ${rows.length} ${rows.length === 1 ? 'patient' : 'patients'}`, detail: 'De-identified: study IDs and age bands, no names, UHIDs or ABHA numbers. On the audit trail.' })
  }

  const columns: WorklistColumn<CohortRow>[] = [
    { key: 'patient', label: 'Patient', role: 'primary', cell: (r) => r.patient.name },
    {
      key: 'who',
      label: 'Age / sex',
      role: 'context',
      cell: (r) => (
        <span className="tabular-nums">
          {r.patient.age}/{r.patient.sex} · {r.patient.uhid}
        </span>
      ),
    },
    {
      key: 'codes',
      label: 'ICD-10',
      role: 'context',
      cell: (r) =>
        r.codes.length === 0 ? (
          <span className="text-sh-text-3">No coded diagnosis</span>
        ) : (
          <span className="flex flex-wrap gap-[4px]">
            {r.codes.map((c) => (
              <span key={c.code} title={`${c.label} — ${c.sources.map((s) => SOURCE_LABEL[s]).join(', ')}`}>
                <Chip word={`${c.code} ${c.label.length > 28 ? `${c.label.slice(0, 27)}…` : c.label}`} tone="pend" />
              </span>
            ))}
          </span>
        ),
    },
    { key: 'seen', label: 'Seen as', role: 'context', secondary: true, cell: (r) => (r.seen ? SEEN_AS.find((s) => s.key === r.seen)?.label : '—') },
    { key: 'where', label: 'Facility · payer', role: 'context', secondary: true, cell: (r) => `${r.patient.facilityCode} · ${r.patient.payer}` },
  ]

  return (
    <MyPatientsFrame
      tab="cohorts"
      screenId="S-05-10"
      sub={`Segregate patients by ICD-10 diagnosis and demographics, for study · ${rows.length} of ${PATIENTS.length}`}
      actions={
        mayExport && (
          <Pill variant="primary" size="xl" icon={Download} disabled={rows.length === 0} className="disabled:opacity-40" onClick={exportCsv}>
            Export de-identified CSV
          </Pill>
        )
      }
    >
      <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        <FilterPanel f={f} update={update} reset={reset} filtered={filtered} />

        <div className="flex min-w-0 flex-col gap-[16px]">
          <Summary rows={rows} described={described} />
          <Worklist
            rows={rows}
            columns={columns}
            rowKey={(r) => r.patient.id}
            onOpen={(r) => navigate(recordPath(r.patient, 'record'))}
            caption="Patients in this cohort"
            noun="patients"
            emptyWhy="No patient matches these filters. Remove one to widen the cohort."
            emptyAction={
              filtered ? (
                <Pill variant="control" size="lg" icon={X} onClick={reset}>
                  Clear the filters
                </Pill>
              ) : undefined
            }
          />
          <SavedCohorts query={params.toString()} described={described} />
        </div>
      </div>
    </MyPatientsFrame>
  )
}

// ──────────────────────────────────────────────────────────── pieces

function Toggles({ label, options, value, onChange }: { label: string; options: readonly { key: string; label: string }[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-[8px]">
      {options.map((o) => {
        const on = value.includes(o.key)
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggle(value, o.key))}
            className={cn(
              'inline-flex min-h-[44px] items-center rounded-full px-[14px] text-[13px] font-medium transition-colors duration-150',
              on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-inner text-sh-text hover:bg-sh-hover-strong',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function FilterPanel({ f, update, reset, filtered }: { f: Filters; update: (patch: Partial<Filters>) => void; reset: () => void; filtered: boolean }) {
  return (
    <Card
      titleSize="sm"
      title="Filters"
      right={
        filtered && (
          <Pill variant="ghost" size="md" icon={X} onClick={reset}>
            Clear
          </Pill>
        )
      }
      className="h-fit"
    >
      <div className="flex flex-col gap-[18px]">
        <section aria-labelledby="cohort-dx-h" className="flex flex-col gap-[10px]">
          <h3 id="cohort-dx-h" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
            Diagnosis · ICD-10
          </h3>
          {f.dx.length > 0 && (
            <ul className="flex flex-wrap gap-[6px]" aria-label="Diagnoses in the filter">
              {f.dx.map((code) => (
                <li key={code}>
                  <span className="inline-flex min-h-[44px] items-center gap-[6px] rounded-full bg-sh-accent-soft py-[4px] pl-[12px] pr-[4px] text-[13px] text-sh-text">
                    <span className="font-semibold tabular-nums">{code}</span>
                    <span className="max-w-[170px] truncate">{code.length === 3 && !code.includes('.') ? `${icdCategoryLabel(code)} (all)` : icdLabel(code)}</span>
                    <RoundButton icon={X} size={36} iconSize={14} variant="ghost" label={`Remove ${code}`} onClick={() => update({ dx: f.dx.filter((d) => d !== code) })} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <IcdPicker
            id="cohort-dx"
            categories
            selected={f.dx}
            onPick={(e) => update({ dx: f.dx.includes(normaliseIcd(e.code)) ? f.dx : [...f.dx, normaliseIcd(e.code)] })}
            placeholder="A code, a category or a word — I63, diabetes, stroke…"
            ariaLabel="Add an ICD-10 code or category to the filter"
            className="max-w-none"
          />
          {f.dx.length > 1 && (
            <Field label="Match" htmlFor="cohort-match">
              <Select id="cohort-match" value={f.match} onChange={(e) => update({ match: e.target.value as Filters['match'] })}>
                <option value="any">Any of these codes</option>
                <option value="all">All of these codes</option>
              </Select>
            </Field>
          )}
          <CheckboxRow checked={f.sub} onChange={(sub) => update({ sub })} className="-mx-[10px] w-auto text-[13px]">
            Include the codes under each (I63 also finds I63.9)
          </CheckboxRow>
          <Field label="ICD-10 chapter" htmlFor="cohort-chapter">
            <Select id="cohort-chapter" value={f.chapter} onChange={(e) => update({ chapter: e.target.value })}>
              <option value="">Any chapter</option>
              {ICD_CHAPTERS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} · {c.title} ({c.from}–{c.to})
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-[10px]">
            <Field label="Coded in" htmlFor="cohort-src">
              <Select id="cohort-src" value={f.src} onChange={(e) => update({ src: e.target.value as Filters['src'] })}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'any' ? 'Anywhere' : SOURCE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status" htmlFor="cohort-status">
              <Select id="cohort-status" value={f.status} onChange={(e) => update({ status: e.target.value as Filters['status'] })}>
                <option value="any">Open or resolved</option>
                <option value="open">Open only</option>
              </Select>
            </Field>
          </div>
        </section>

        <section aria-labelledby="cohort-demo-h" className="flex flex-col gap-[12px]">
          <h3 id="cohort-demo-h" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
            Demographics
          </h3>
          <div className="flex flex-col gap-[6px]">
            <span className="text-[13px] font-medium text-sh-text-2">Age</span>
            <Toggles label="Age bands" options={AGE_BANDS} value={f.age} onChange={(age) => update({ age })} />
          </div>
          <div className="flex flex-col gap-[6px]">
            <span className="text-[13px] font-medium text-sh-text-2">Sex</span>
            <Toggles label="Sex" options={SEXES} value={f.sex ? [f.sex] : []} onChange={(v) => update({ sex: v.filter((x) => x !== f.sex)[0] ?? '' })} />
          </div>
          <div className="flex flex-col gap-[6px]">
            <span className="text-[13px] font-medium text-sh-text-2">Seen as</span>
            <Toggles label="Seen as" options={SEEN_AS} value={f.seen} onChange={(seen) => update({ seen })} />
          </div>
          <Field label="Facility" htmlFor="cohort-fac">
            <Select id="cohort-fac" value={f.fac} onChange={(e) => update({ fac: e.target.value })}>
              <option value="">Every facility</option>
              {FACILITIES.map((fc) => (
                <option key={fc.code} value={fc.code}>
                  {fc.code} · {fc.short}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-[6px]">
            <span className="text-[13px] font-medium text-sh-text-2">Payer</span>
            <Toggles label="Payer" options={PAYERS.map((p) => ({ key: p, label: p }))} value={f.payer} onChange={(payer) => update({ payer })} />
          </div>
          <CheckboxRow checked={f.abha} onChange={(abha) => update({ abha })} className="-mx-[10px] w-auto text-[13px]">
            ABHA linked only
          </CheckboxRow>
        </section>
      </div>
    </Card>
  )
}

/** Counts as bars, each labelled with its number — one series, no legend; never colour alone. */
function CountBars({ label, rows, total }: { label: string; rows: { label: string; count: number }[]; total: number }) {
  return (
    <figure className="m-0 min-w-0">
      <figcaption className="mb-[8px] text-[12px] font-medium text-sh-text-2">{label}</figcaption>
      <ul className="flex flex-col gap-[6px]" aria-label={`${label}: ${rows.map((r) => `${r.label} ${r.count}`).join(', ')}`}>
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_28px] items-center gap-[8px] text-[12px]">
            <span className="truncate text-sh-text-2" title={r.label}>
              {r.label}
            </span>
            <span className="h-[10px] overflow-hidden rounded-full bg-sh-inner" aria-hidden="true">
              <span className="block h-full rounded-full bg-(--busy-edge)" style={{ width: `${total ? (r.count / total) * 100 : 0}%` }} />
            </span>
            <span className="text-right font-semibold tabular-nums text-sh-text">{r.count}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

function Summary({ rows, described }: { rows: CohortRow[]; described: string }) {
  const total = rows.length
  const sex = SEXES.map((s) => ({ label: s.label, count: rows.filter((r) => r.patient.sex === s.key).length })).filter((r) => r.count > 0 || r.label !== 'Other')
  const age = AGE_BANDS.map((b) => ({ label: b.label, count: rows.filter((r) => bandOf(r.patient.age).key === b.key).length }))
  const cats = new Map<string, number>()
  for (const r of rows) for (const cat of new Set(r.codes.map((c) => icdCategory(c.code)))) cats.set(cat, (cats.get(cat) ?? 0) + 1)
  const top = [...cats.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([cat, count]) => ({ label: `${cat} ${icdCategoryLabel(cat)}`, count }))
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          <Icon icon={Layers} size={17} className="text-sh-text-3" />
          This cohort
          <CountBubble className="bg-sh-control">{total}</CountBubble>
        </span>
      }
    >
      <p className="mb-[14px] text-[13px] text-sh-text-2">
        <span className="font-semibold text-sh-text">{total}</span> of {PATIENTS.length} patients · {described}
      </p>
      {total > 0 && (
        <div className="grid grid-cols-1 gap-[20px] sm:grid-cols-2 xl:grid-cols-3">
          <CountBars label="Sex" rows={sex} total={total} />
          <CountBars label="Age band" rows={age} total={total} />
          <CountBars label="Top ICD-10 categories" rows={top.length ? top : [{ label: 'No coded diagnosis', count: total }]} total={total} />
        </div>
      )}
    </Card>
  )
}

function SavedCohorts({ query, described }: { query: string; described: string }) {
  const [, setParams] = useSearchParams()
  const saved = useCohorts((s) => s.saved)
  const save = useCohorts((s) => s.save)
  const remove = useCohorts((s) => s.remove)
  const toast = useUI((s) => s.toast)
  const [name, setName] = useState('')

  function doSave() {
    if (!name.trim()) return
    const c = save(name, query, NOW.toISOString())
    setName('')
    toast({ tone: 'success', title: `Cohort saved — ${c.name}`, detail: `${described}. The filters are kept; the patients follow the record.` })
  }

  return (
    <Card titleSize="sm" title="Saved cohorts" right={saved.length > 0 && <CountBubble className="bg-sh-control">{saved.length}</CountBubble>}>
      <form
        className="flex flex-wrap items-end gap-[8px]"
        onSubmit={(e) => {
          e.preventDefault()
          doSave()
        }}
      >
        <Field label="Save these filters as" htmlFor="cohort-name" className="min-w-[220px] flex-1">
          <TextInput id="cohort-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stroke, over 60, ICH" />
        </Field>
        <Pill variant="primary" size="xl" icon={Save} type="submit" disabled={!name.trim()} className="disabled:opacity-40">
          Save cohort
        </Pill>
      </form>
      {saved.length > 0 && (
        <ul className="mt-[14px] flex flex-col" aria-label="Saved cohorts">
          {saved.map((c, i) => (
            <li key={c.id} className={cn('flex items-center gap-[10px] py-[8px]', i > 0 && 'border-t border-sh-line')}>
              <button
                type="button"
                onClick={() => setParams(new URLSearchParams(c.query), { replace: true })}
                className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center rounded-[12px] px-[8px] text-left transition-colors duration-150 hover:bg-sh-hover"
              >
                <span className="truncate text-[14px] font-medium text-sh-text">{c.name}</span>
                <span className="truncate text-[12px] text-sh-text-3">
                  {describeFilters(readFilters(new URLSearchParams(c.query)))} · saved {formatDate(new Date(c.savedAt))}
                </span>
              </button>
              <RoundButton icon={Trash2} size={36} iconSize={15} variant="ghost" label={`Delete the saved cohort ${c.name}`} className="text-sh-text-3 hover:text-sh-crit-fg" onClick={() => remove(c.id)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
