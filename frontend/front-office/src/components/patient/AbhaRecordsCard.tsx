import { useState } from 'react'
import type { CSSProperties, ElementType, ReactNode } from 'react'
import { ChevronDown, FileHeart, FileText, FlaskConical, Pill, ScanLine, Stethoscope } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import { formatDateKey } from '../../utils/dates'
import { cn } from '../../utils/cn'
import { getAbhaDemoProfile } from '../../domain/abhaDemoRecords'
import type { AbhaRecord, AbhaRecordType, AbhaResult } from '../../domain/abhaDemoRecords'
import type { Patient } from '../../types/patient'

const TYPE_ICON: Record<AbhaRecordType, ElementType> = {
  'Lab report': FlaskConical,
  Prescription: Pill,
  'Discharge summary': FileText,
  'Diagnostic report': ScanLine,
  Consultation: Stethoscope,
}

const TYPE_HUE: Record<AbhaRecordType, string> = {
  'Lab report': 'var(--color-hue-violet)',
  Prescription: 'var(--color-hue-green)',
  'Discharge summary': 'var(--color-hue-orange)',
  'Diagnostic report': 'var(--color-hue-cyan)',
  Consultation: 'var(--color-hue-blue)',
}

/** How many records show before "Show all". */
const FIRST_SHOWN = 4

/**
 * The patient's health records linked through ABHA — SIMULATED for the demo
 * (see domain/abhaDemoRecords): fictional records, never fetched from ABDM,
 * and kept apart from the hospital's own visits and bills. Shown only for a
 * patient with an ABHA linked.
 */
export function AbhaRecordsCard({ patient, today }: { patient: Patient; today: string }) {
  const [type, setType] = useState<AbhaRecordType | 'All'>('All')
  const [openId, setOpenId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const profile = getAbhaDemoProfile(patient, today)
  if (!profile || !patient.abhaId) return null

  const types = [...new Set(profile.records.map((r) => r.type))]
  const filtered = profile.records.filter((r) => type === 'All' || r.type === type)
  const shown = showAll ? filtered : filtered.slice(0, FIRST_SHOWN)

  return (
    <Card accentTone="teal" className="min-w-0">
      <CardHeader icon={FileHeart} iconTone="teal" title="ABHA Health Records" />

      {/* The ABHA identity, compact — name, age and sex are already in the header above. */}
      <dl className="flex flex-wrap gap-x-6 gap-y-1.5 border-b border-border-soft px-5 py-3 text-sm">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <dt className="text-xs text-ink-subtle">ABHA</dt>
          <dd className="truncate font-medium text-ink">{patient.abhaId}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-ink-subtle">Blood group</dt>
          <dd className="font-medium text-ink">{profile.bloodGroup}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-ink-subtle">Records</dt>
          <dd className="font-medium text-success-fg">
            Linked · {profile.records.length}
          </dd>
        </div>
      </dl>

      {/* Record type — narrows the list. */}
      <div className="flex flex-wrap gap-1.5 px-5 pt-3" role="radiogroup" aria-label="Record type">
        {(['All', ...types] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={type === option}
            onClick={() => {
              setType(option)
              setShowAll(false)
            }}
            className={cn(
              'focus-ring min-h-8 rounded-full border px-3 text-xs font-medium transition-colors',
              type === option ? 'border-primary-600 bg-primary-600 text-on-primary' : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <ul className="flex flex-col gap-1.5 px-3 pb-3 pt-2 sm:px-4">
        {shown.map((record) => (
          <RecordRow key={record.id} record={record} open={openId === record.id} onToggle={() => setOpenId((id) => (id === record.id ? null : record.id))} />
        ))}
      </ul>
      {filtered.length > FIRST_SHOWN ? (
        <button
          type="button"
          onClick={() => setShowAll((all) => !all)}
          className="focus-ring mx-5 mb-3 rounded text-xs font-semibold text-primary-text hover:underline"
        >
          {showAll ? 'Show fewer' : `Show all ${filtered.length}`}
        </button>
      ) : null}
    </Card>
  )
}

function RecordRow({ record, open, onToggle }: { record: AbhaRecord; open: boolean; onToggle: () => void }) {
  const Icon = TYPE_ICON[record.type]
  return (
    <li className={cn('rounded-xl transition-colors', open ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="focus-ring flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left">
        <span
          style={{ '--tone': TYPE_HUE[record.type] } as CSSProperties}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--tone)_14%,var(--color-surface-1))] text-[var(--tone)]"
        >
          <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{record.title}</span>
          <span className="block truncate text-xs text-ink-muted">
            {record.type} · {record.source}
          </span>
        </span>
        <time className="shrink-0 text-2xs tabular-nums text-ink-subtle" dateTime={record.date}>
          {formatDateKey(record.date)}
        </time>
        <span className="flex shrink-0 items-center gap-0.5 text-xs font-semibold text-primary-text">
          <span className="hidden sm:inline">{open ? 'Hide' : 'View details'}</span>
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} strokeWidth={2} aria-hidden="true" />
        </span>
      </button>
      {open ? <RecordDetails record={record} /> : null}
    </li>
  )
}

/** One record's details, in labelled sections — only the sections the record has. */
function RecordDetails({ record }: { record: AbhaRecord }) {
  return (
    <div className="flex flex-col gap-3 px-2 pb-3 sm:pl-13">

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {record.stay ? (
          <Fact label="Admitted – discharged">
            {formatDateKey(record.stay.admitted)} – {formatDateKey(record.stay.discharged)}
          </Fact>
        ) : null}
        {record.collected ? (
          <Fact label="Sample collected – reported">
            {formatDateKey(record.collected)} – {formatDateKey(record.date)}
          </Fact>
        ) : null}
        {!record.stay && !record.collected ? <Fact label="Date">{formatDateKey(record.date)}</Fact> : null}
        <Fact label="Source">{record.source}</Fact>
        {record.clinician ? (
          <Fact label="Clinician">
            {record.clinician.name} · {record.clinician.department}
          </Fact>
        ) : null}
        {record.reason ? <Fact label="Reason">{record.reason}</Fact> : null}
      </dl>

      {record.findings?.length ? (
        <Section title="Clinical findings">
          <Bullets items={record.findings} />
        </Section>
      ) : null}

      {record.results?.length ? (
        <Section title="Results">
          <div className="overflow-x-auto rounded-lg border border-border-soft">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <thead className="bg-surface-2/60 text-2xs uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">Test</th>
                  <th className="px-3 py-1.5 font-semibold">Result</th>
                  <th className="px-3 py-1.5 font-semibold">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {record.results.map((result) => (
                  <ResultRow key={result.test} result={result} />
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {record.assessment ? (
        <Section title="Clinical assessment">
          <p className="text-sm text-ink">{record.assessment}</p>
        </Section>
      ) : null}

      {record.medications?.length || record.treatment?.length ? (
        <Section title="Treatment">
          {record.medications?.length ? (
            <div className="overflow-x-auto rounded-lg border border-border-soft">
              <table className="w-full min-w-[26rem] text-left text-sm">
                <thead className="bg-surface-2/60 text-2xs uppercase tracking-wide text-ink-subtle">
                  <tr>
                    <th className="px-3 py-1.5 font-semibold">Medicine</th>
                    <th className="px-3 py-1.5 font-semibold">Strength</th>
                    <th className="px-3 py-1.5 font-semibold">Schedule</th>
                    <th className="px-3 py-1.5 font-semibold">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft">
                  {record.medications.map((med) => (
                    <tr key={med.drug}>
                      <td className="px-3 py-1.5 font-medium text-ink">{med.drug}</td>
                      <td className="px-3 py-1.5 tabular-nums text-ink">{med.strength}</td>
                      <td className="px-3 py-1.5 text-ink">
                        <span className="font-medium tabular-nums">{med.schedule}</span> <span className="text-xs text-ink-muted">· {med.scheduleNote}</span>
                      </td>
                      <td className="px-3 py-1.5 text-ink">{med.duration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {record.treatment?.length ? <Bullets items={record.treatment} /> : null}
        </Section>
      ) : null}

      {record.advice?.length ? (
        <Section title={record.type === 'Consultation' && !record.medications ? 'Advice & investigations' : 'Advice'}>
          <Bullets items={record.advice} />
        </Section>
      ) : null}

      {record.followUp ? (
        <Section title="Follow-up">
          <p className="text-sm text-ink">{record.followUp}</p>
        </Section>
      ) : null}

      <div className="rounded-lg border border-border-soft bg-surface-1 px-3 py-2">
        <p className="text-2xs font-semibold uppercase tracking-wide text-ink-subtle">Summary</p>
        <p className="mt-0.5 text-sm text-ink">{record.summary}</p>
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</h4>
      {children}
    </section>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

/** A result outside its range is shown bolder, with its flag in words. */
function ResultRow({ result }: { result: AbhaResult }) {
  return (
    <tr>
      <td className="px-3 py-1.5 text-ink">{result.test}</td>
      <td className={cn('px-3 py-1.5 tabular-nums', result.flag ? 'font-semibold text-warning-fg' : 'text-ink')}>
        {result.value}
        {result.unit ? <span className="font-normal text-ink-muted"> {result.unit}</span> : null}
        {result.flag ? <span className="ml-1.5 text-2xs font-bold uppercase">{result.flag}</span> : null}
      </td>
      <td className="px-3 py-1.5 text-xs text-ink-muted">{result.reference}</td>
    </tr>
  )
}
