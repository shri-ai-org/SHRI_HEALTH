import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Badge, EmptyState, ErrorState, Spinner, TextInput, problemCopy, type BadgeTone } from '../../design-system'
import type { Resource } from './api/useResource'
import type { AppointmentStatus, Occurrence } from './api/types'
import { accentFor } from './accent'
import { Link, useRouter } from './router'

export const PORTAL_NAME = 'Shri Health patient portal'

/**
 * Every page starts with this. On a new page, focus moves to the heading and the tab title changes,
 * so screen-reader and keyboard users hear where they landed (WCAG 2.4.2, 2.4.3).
 */
export function PageHeader({ title, description, back, actions }: { title: string; description?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null)
  const { path } = useRouter()
  const Icon = accentFor(path).icon
  useEffect(() => {
    document.title = `${title} · ${PORTAL_NAME}`
    heading.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <header className="portal-banner relative mb-6 overflow-hidden rounded-2xl bg-linear-to-r from-(--accent) to-(--accent-2) px-5 py-5 text-white shadow-card-lg sm:px-7 sm:py-6">
      {/* Soft decorative circles; purely visual. */}
      <span aria-hidden="true" className="pointer-events-none absolute -top-10 -right-10 size-40 rounded-full bg-white/10" />
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-16 right-24 size-32 rounded-full bg-white/10" />
      {back ? (
        <Link to={back.to} className="relative -ml-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-medium text-white underline-offset-2 hover:underline">
          <ChevronLeft aria-hidden="true" size={16} />
          {back.label}
        </Link>
      ) : null}
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span aria-hidden="true" className="hidden size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20 ring-1 ring-white/30 sm:flex">
            <Icon size={24} />
          </span>
          <div className="min-w-0">
            <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold text-white outline-none sm:text-3xl">
              {title}
            </h1>
            {description ? <div className="mt-1 max-w-2xl text-sm text-white">{description}</div> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap gap-2 text-ink">{actions}</div> : null}
      </div>
    </header>
  )
}

export function Card({ title, titleAs: H = 'h2', actions, children, className = '' }: { title?: string; titleAs?: 'h2' | 'h3'; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`overflow-hidden rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card ${className}`} {...(title ? { 'aria-label': title } : {})}>
      {title ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--accent-line) border-l-4 border-l-(--accent) bg-(--accent-soft) px-4 py-3 sm:px-5">
          <H className="text-base font-semibold text-(--accent-text)">{title}</H>
          {actions}
        </div>
      ) : null}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  )
}

/** Loading, error with Retry and reference, or the content: one failed panel never blanks the page. */
export function AsyncPanel<T>({ resource, label, children }: { resource: Resource<T>; label: string; children: (data: T) => ReactNode }) {
  if (resource.status === 'loading') {
    return (
      <div className="flex justify-center py-10">
        <Spinner label={`Loading ${label}`} />
      </div>
    )
  }
  if (resource.status === 'error') {
    const copy = problemCopy(resource.problem)
    return <ErrorState title={`Couldn't load ${label}`} description={copy.message} reference={resource.problem.requestId} onRetry={resource.reload} />
  }
  return <>{children(resource.data)}</>
}

/**
 * Listed at the top of a form after a failed submit, with links that move focus to each field
 * (WCAG 3.3.1). Focus moves to the summary so the user hears what to fix.
 */
export function ErrorSummary({ errors }: { errors: Array<{ fieldId: string; message: string }> }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (errors.length > 0) box.current?.focus()
  }, [errors])
  if (errors.length === 0) return null
  return (
    <div ref={box} tabIndex={-1} role="alert" className="rounded-lg border border-critical-fg/30 bg-critical-bg px-4 py-3 text-critical-fg outline-none">
      <p className="text-sm font-semibold">
        {errors.length === 1 ? 'There is 1 thing to fix' : `There are ${errors.length} things to fix`}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
        {errors.map((e) => (
          <li key={e.fieldId}>
            <a
              href={`#${e.fieldId}`}
              className="underline"
              onClick={(ev) => {
                ev.preventDefault()
                document.getElementById(e.fieldId)?.focus()
              }}
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function DefinitionList({ items }: { items: Array<{ term: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {items.map((i) => (
        <div key={i.term} className="contents">
          <dt className="text-sm font-medium text-ink-subtle">{i.term}</dt>
          <dd className="text-sm text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Downloads a Blob with a filename, for documents and the health summary. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** `Tuesday, November 3` in the facility's zone: the way people talk about appointment days. */
export function formatLongDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(instant))
}

/** `Nov 3, 2026` for record dates (calendar dates, no zone shift). */
export function formatShortDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function formatInstantShort(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(instant))
}

const APPOINTMENT_STATUS: Record<AppointmentStatus, { label: string; tone: BadgeTone }> = {
  booked: { label: 'Scheduled', tone: 'primary' },
  arrived: { label: 'Arrived', tone: 'info' },
  'checked-in': { label: 'Checked in', tone: 'success' },
  fulfilled: { label: 'Completed', tone: 'neutral' },
  cancelled: { label: 'Canceled', tone: 'warning' },
  noshow: { label: 'Missed', tone: 'warning' },
}

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  const s = APPOINTMENT_STATUS[status]
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export const OCCURRENCE: Record<Occurrence, string> = {
  unknown: 'Unknown or N/A',
  first: 'First',
  chronic: 'Chronic/Recurrent',
  'acute-on-chronic': 'Acute on Chronic',
  'early-recurrence': 'Early Recurrence (<2 Months)',
  'late-recurrence': 'Late Recurrence (2-12 Months)',
  'delayed-recurrence': 'Delayed Recurrence (> 12 Months)',
}

/** Client-side paging, as the old portal's lists did: a page of rows plus the pager state. */
export function usePaged<T>(rows: T[], pageSize: number) {
  const [page, setPage] = useState(0)
  const last = Math.max(0, Math.ceil(rows.length / pageSize) - 1)
  const current = Math.min(page, last)
  return { rows: rows.slice(current * pageSize, current * pageSize + pageSize), page: current, last, setPage, total: rows.length, pageSize }
}

/** The old pager: "Showing 1 to 5 of 12 records" with first, previous, next and last. */
export function Pager({ page, last, setPage, total, pageSize, noun = 'records' }: { page: number; last: number; setPage: (n: number) => void; total: number; pageSize: number; noun?: string }) {
  if (total <= pageSize) return null
  const from = page * pageSize + 1
  const to = Math.min(total, from + pageSize - 1)
  const btn = 'tap-target inline-flex items-center justify-center rounded-lg border border-(--accent-line) bg-surface-1 text-(--accent-text) hover:bg-(--accent-soft) disabled:opacity-40'
  return (
    <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-ink-muted" aria-live="polite">
        Showing {from} to {to} of {total} {noun}
      </p>
      <div className="flex gap-1">
        <button type="button" className={btn} disabled={page === 0} onClick={() => setPage(0)} aria-label="First page">
          <ChevronsLeft aria-hidden="true" size={16} />
        </button>
        <button type="button" className={btn} disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
          <ChevronLeft aria-hidden="true" size={16} />
        </button>
        <button type="button" className={btn} disabled={page === last} onClick={() => setPage(page + 1)} aria-label="Next page">
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        <button type="button" className={btn} disabled={page === last} onClick={() => setPage(last)} aria-label="Last page">
          <ChevronsRight aria-hidden="true" size={16} />
        </button>
      </div>
    </nav>
  )
}

/** The search box above the old lists. */
export function SearchBox({ value, onChange, label = 'Search' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const id = useId()
  return (
    <div className="w-full max-w-xs">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <TextInput id={id} type="search" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export function matches(q: string, ...fields: Array<string | undefined>): boolean {
  const needle = q.trim().toLowerCase()
  return !needle || fields.some((f) => f?.toLowerCase().includes(needle))
}

export interface TableColumn<Row> {
  header: string
  cell: (row: Row) => ReactNode
  /** The column that names the row (a header cell for screen readers). */
  rowHeader?: boolean
  numeric?: boolean
}

/** A plain list table; scrolls inside its box on narrow screens, never the page. */
export function Table<Row>({ caption, columns, rows, rowKey, empty = 'No data to display' }: { caption: string; columns: TableColumn<Row>[]; rows: Row[]; rowKey: (r: Row) => string; empty?: string }) {
  if (!rows.length) return <EmptyState title={empty} />
  return (
    <div className="overflow-x-auto rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-(--accent-soft)">
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className={`border-b-2 border-(--accent-line) px-3 py-3 text-xs font-bold tracking-wide text-(--accent-text) uppercase ${c.numeric ? 'text-right' : ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-border-soft last:border-0 hover:bg-surface-2">
              {columns.map((c) =>
                c.rowHeader ? (
                  <th key={c.header} scope="row" className="px-3 py-2.5 font-medium text-ink">
                    {c.cell(r)}
                  </th>
                ) : (
                  <td key={c.header} className={`px-3 py-2.5 text-ink ${c.numeric ? 'text-right tabular-nums' : ''}`}>
                    {c.cell(r)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The link style used for record names in the old tables. */
export const tableLink = 'font-semibold text-(--accent-text) underline-offset-2 hover:underline'
