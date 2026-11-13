/**
 * SHRI_HEALTH: the record's Test results (S-06-13) and Imaging reports (S-06-12) with the API, and
 * the Overview's two cards that show them (D115: adapted from ResultsPartPage, ReportsPage,
 * ResultsCard and ReportCard in this folder, which keep the mock-up's sample screens). Read only,
 * from shri-health/results.ts; every time is the clinic's (D40).
 *   Test results    — each lab report, newest first: its name, when collected, the lab, and its
 *                     analytes in a table (value with unit or the lab's text, reference range, the
 *                     flag in a word), then the lab's conclusion.
 *   Imaging reports — each report, newest first: the study, when it was done, the radiology group,
 *                     the impression, and the full report. Text only: there are no images behind
 *                     these reports, so there is no viewer and no image area.
 */

import { FlaskConical, ScanLine, ScrollText } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import type { Patient } from '@/data/kit'

import { formatClinicDateTime } from '../../../shri-health/format'
import { usePatientImagingReports, usePatientLabResults, type ImagingReportRow, type LabAnalyte, type LabReport } from '../../../shri-health/results'
import { cn } from '../lib/cn'
import { recordPath } from '../logic/record'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, CountBubble, Icon } from '../ui/primitives'
import { RangeBar } from '../ui/RangeBar'
import { StatTile } from '../ui/StatTile'

import { ClinicalFlag, TextLink } from './bits'

const when = (at?: string) => (at ? formatClinicDateTime(at) : 'date not recorded')
const statusChip = (status: string) => (status === 'final' ? null : <Chip word={status} tone={status === 'amended' || status === 'corrected' ? 'warn' : 'neu'} />)

// ---- Test results (S-06-13) ----

export function ApiResults({ patient: p }: { patient: Patient }) {
  const labs = usePatientLabResults(p.id)
  const reports = labs.items
  const outside = reports.flatMap((r) => r.analytes).filter((a) => a.outside)
  const critical = outside.filter((a) => a.flag?.includes('Critical'))

  if (labs.denied) {
    return (
      <Card titleSize="sm" title="Test results">
        <EmptyState icon={FlaskConical} why="Your role can't read test results." />
      </Card>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-3">
        <StatTile label="Reports on file" value={reports.length} sub={reports[0] ? `latest ${when(reports[0].collectedAt ?? reports[0].issuedAt)}` : 'none yet'} />
        <StatTile
          label="Outside range"
          value={outside.length}
          tone={critical.length > 0 ? 'crit' : outside.length > 0 ? 'warn' : 'norm'}
          sub={critical.length > 0 ? `${critical.length} critical` : outside.length > 0 ? 'high, low or abnormal' : 'all within range'}
        />
        <StatTile label="Analytes" value={reports.reduce((n, r) => n + r.analytes.length, 0)} sub="across every report" />
      </div>

      {reports.length === 0 ? (
        <Card titleSize="sm" title="Test results">
          <EmptyState icon={FlaskConical} why={`No test results are on ${p.name}’s record yet.`} />
        </Card>
      ) : (
        reports.map((r) => <LabReportCard key={r.id} report={r} />)
      )}
    </>
  )
}

function LabReportCard({ report: r }: { report: LabReport }) {
  return (
    <Card
      aria-label={r.name}
      titleSize="sm"
      title={
        <span className="inline-flex flex-wrap items-center gap-[10px]">
          {r.name}
          {statusChip(r.status)}
        </span>
      }
    >
      <p className="-mt-[6px] mb-[12px] text-[12px] tabular-nums text-sh-text-3">
        Collected {when(r.collectedAt)}
        {r.performer && ` · ${r.performer}`}
        {r.issuedAt && ` · reported ${when(r.issuedAt)}`}
      </p>
      <div className="-mx-[4px] overflow-x-auto px-[4px]">
        <table className="w-full min-w-[560px] table-fixed border-collapse text-left text-[13px]">
          {/* The same columns on every report, so the tables line up down the page. */}
          <colgroup>
            <col className="w-[44%]" />
            <col className="w-[18%]" />
            <col className="w-[26%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
              <th scope="col" className="pb-[8px] pr-[12px] font-semibold">Analyte</th>
              <th scope="col" className="pb-[8px] pr-[12px] font-semibold">Result</th>
              <th scope="col" className="pb-[8px] pr-[12px] font-semibold">Reference range</th>
              <th scope="col" className="pb-[8px] font-semibold">Flag</th>
            </tr>
          </thead>
          <tbody>
            {r.analytes.map((a) => (
              <AnalyteRow key={a.id} a={a} />
            ))}
          </tbody>
        </table>
      </div>
      {r.conclusion && <p className="mt-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-[13px]/[1.5] text-sh-text-2">{r.conclusion}</p>}
    </Card>
  )
}

function AnalyteRow({ a }: { a: LabAnalyte }) {
  const bounded = a.numeric !== undefined && a.low !== undefined && a.high !== undefined
  return (
    <tr className="border-t border-sh-line align-middle">
      <th scope="row" className="py-[10px] pr-[12px] font-medium text-sh-text">{a.name}</th>
      <td className="py-[10px] pr-[12px]">
        <span className="text-[15px] font-semibold tabular-nums text-sh-text">{a.value}</span>
        {a.unit && <span className="ml-[4px] text-[12px] text-sh-text-3">{a.unit}</span>}
      </td>
      <td className="py-[10px] pr-[12px] tabular-nums text-sh-text-2">
        <span className="flex items-center gap-[8px]">
          {bounded && <RangeBar value={a.numeric!} low={a.low!} high={a.high!} label={`${a.name} ${a.value} ${a.unit ?? ''}, reference ${a.range}`} />}
          {a.range || '—'}
        </span>
      </td>
      <td className="py-[10px]">{a.flag ? <ClinicalFlag flag={a.flag} /> : <span className="text-sh-text-3">—</span>}</td>
    </tr>
  )
}

/** The Overview's Test results card: the latest few analytes, newest report first. */
export function ApiResultsCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const navigate = useNavigate()
  const labs = usePatientLabResults(p.id)
  const latest = labs.items.flatMap((r) => r.analytes.map((a) => ({ a, at: r.collectedAt ?? r.issuedAt }))).slice(0, 6)
  const outside = labs.items.flatMap((r) => r.analytes).filter((a) => a.outside).length
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Test results
          {outside > 0 && <Chip num={String(outside)} word="outside range" tone="warn" />}
        </span>
      }
      right={labs.items.length > 0 ? <TextLink onClick={() => navigate(recordPath(p, 'results'))}>See all</TextLink> : undefined}
      className={className}
    >
      {labs.denied ? (
        <EmptyState compact icon={FlaskConical} why="Your role can't read test results." />
      ) : latest.length === 0 ? (
        <EmptyState compact icon={FlaskConical} why="No results yet" />
      ) : (
        <ul className="-mx-[4px] flex min-h-0 flex-1 flex-col gap-[6px] overflow-y-auto px-[4px] pb-[2px]" aria-label="Latest results">
          {latest.map(({ a, at }) => (
            <li key={a.id} className="grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-[2px] rounded-[14px] bg-sh-inner px-[12px] py-[7px]">
              <span className="truncate text-[13px] font-medium text-sh-text" title={a.name}>{a.name}</span>
              <span className="flex items-center justify-end gap-[6px]">
                <span className="text-[14px] font-semibold tabular-nums text-sh-text">
                  {a.value}
                  {a.unit && <span className="text-[11px] font-normal text-sh-text-3"> {a.unit}</span>}
                </span>
                {a.flag && a.flag !== 'Normal' && <ClinicalFlag flag={a.flag} />}
              </span>
              <span className="col-span-2 truncate text-[11px] tabular-nums text-sh-text-3">
                {a.range ? `ref ${a.range} · ` : ''}
                {when(at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---- Imaging reports (S-06-12) ----

export function ApiReports({ patient: p }: { patient: Patient }) {
  const imaging = usePatientImagingReports(p.id)
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Imaging reports
          {!imaging.denied && <CountBubble className="bg-sh-control">{imaging.items.length}</CountBubble>}
        </span>
      }
    >
      {imaging.denied ? (
        <EmptyState icon={ScrollText} why="Your role can't read imaging reports." />
      ) : imaging.items.length === 0 ? (
        <EmptyState icon={ScrollText} why={`No imaging reports are on ${p.name}’s record yet.`} />
      ) : (
        <ul className="flex flex-col" aria-label="Imaging reports">
          {imaging.items.map((r, i) => (
            <ImagingLine key={r.id} report={r} first={i === 0} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function ImagingLine({ report: r, first }: { report: ImagingReportRow; first: boolean }) {
  return (
    <li className={first ? 'pb-[16px]' : 'border-t border-sh-line py-[16px]'} aria-label={r.name}>
      <div className="flex items-start gap-[12px]">
        <span className="inline-flex size-[36px] shrink-0 items-center justify-center rounded-[12px] bg-sh-inner text-sh-text-2" aria-hidden="true">
          <Icon icon={ScanLine} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
            <span className="text-[14px] font-semibold text-sh-text">{r.name}</span>
            {statusChip(r.status)}
          </p>
          <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
            Studied {when(r.studiedAt)}
            {r.performer && ` · ${r.performer}`}
            {r.issuedAt && ` · reported ${when(r.issuedAt)}`}
          </p>
          {r.impression && (
            <div className="mt-[10px] rounded-[14px] border-l-[3px] border-sh-primary bg-sh-inner px-[14px] py-[10px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Impression</p>
              <p className="mt-[4px] text-[14px]/[1.5] font-medium text-sh-text">{r.impression}</p>
            </div>
          )}
          {r.text && (
            <div className="mt-[10px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Full report</p>
              <p className="mt-[4px] whitespace-pre-line text-[13px]/[1.55] text-sh-text-2">{r.text}</p>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/** The Overview's imaging card: the latest report's impression, as text. */
export function ApiReportCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const navigate = useNavigate()
  const imaging = usePatientImagingReports(p.id)
  const latest = imaging.items[0]
  return (
    <Card
      titleSize="sm"
      title="Imaging reports"
      right={latest ? <TextLink onClick={() => navigate(recordPath(p, 'reports'))}>See all</TextLink> : undefined}
      className={cn('min-w-0', className)}
    >
      {imaging.denied ? (
        <EmptyState compact icon={ScrollText} why="Your role can't read imaging reports." />
      ) : !latest ? (
        <EmptyState compact icon={ScrollText} why="No imaging reports" />
      ) : (
        <div>
          <p className="text-[15px]/[1.3] font-medium text-sh-text">{latest.name}</p>
          <p className="mt-[2px] text-[12px] tabular-nums text-sh-text-3">
            {when(latest.studiedAt)}
            {latest.performer && ` · ${latest.performer}`}
          </p>
          {latest.impression && (
            <div className="mt-[10px] rounded-[14px] border-l-[3px] border-sh-primary bg-sh-inner px-[14px] py-[10px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Impression</p>
              <p className="mt-[4px] text-[14px]/[1.5] text-sh-text">{latest.impression}</p>
            </div>
          )}
          {imaging.items.length > 1 && (
            <p className="mt-[10px] text-[12px] text-sh-text-3">
              {imaging.items.length - 1} earlier {imaging.items.length === 2 ? 'report' : 'reports'} on the Imaging reports tab
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
