/**
 * §7.5 Report viewer (column A) — every report on the patient's record, one at
 * a time, on the dark preview tile (`src/screens/m06/record/ReportViewer.tsx`).
 * A row of pills above the tile switches between them — the CT, the X-ray,
 * the ultrasound, the echo, a document — newest first, opening on the newest
 * study with images behind it.
 *
 * A study with images is the viewer itself, compact: a stack or a set of
 * images steps by wheel, slider, ‹ › or the arrow keys; a loop plays; a single
 * image zooms. A head CT keeps the model's verdict beneath while AI is on (no
 * model reads the other modalities). A study without images, or a document,
 * keeps the frame and says so, with its report. "Open in Imaging" opens the
 * chosen study at the image on screen — the annotation and reading tools live
 * there, not here.
 */

import { Activity, Brain, Camera, FileText, HeartPulse, ImageOff, Radio, ScanLine, Waves, type LucideIcon } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatDate, formatTime } from '@/data/format'
import { maybeImagingStudy, ncctFor, viewableStudyFor, type ImagingStudy } from '@/data/imaging'
import type { Patient } from '@/data/kit'
import { reportsFor, type RecordReport } from '@/data/record'
import { maybeStrokeCase } from '@/data/stroke'
import { overlaysFor, triageVerdict } from '@/data/strokeai'

import { cn } from '../lib/cn'
import { recordPath } from '../logic/record'
import { seriesViewFor } from '../logic/series'
import type { Tone } from '../mocks/types'
import { useAiActive } from '../state/ai'
import { NcctViewer, StudyViewer, ViewerPlaceholder } from '../ui/NcctViewer'
import { Card, Chip, Diamond, Icon, Pill, RoundButton } from '../ui/primitives'

import { TextLink } from './bits'

/** The frame's neutral icon, by what the report is. */
const KIND_ICON: Partial<Record<string, LucideIcon>> = { Imaging: ScanLine, Ultrasound: Waves, ECG: Activity, Echocardiogram: HeartPulse, 'Fetal monitoring': Activity, 'Clinical photographs': Camera }
const MODALITY_ICON: Record<ImagingStudy['modality'], LucideIcon> = { CT: ScanLine, 'X-ray': ScanLine, Ultrasound: Radio, MRI: Brain, Echo: HeartPulse }

const VERDICT_TONE: Record<'critical' | 'caution' | 'normal', Tone> = { critical: 'crit', caution: 'warn', normal: 'norm' }

/** "CT · 21-Sep", "US · 5-Sep", "ECG · 20-Sep" — short enough for a pill; the full title is its tooltip. */
function pillLabel(r: RecordReport, study: ImagingStudy | undefined): string {
  const day = formatDate(r.at).slice(0, 6)
  const what = study ? (study.modality === 'Ultrasound' ? 'US' : study.modality) : r.kind === 'Echocardiogram' ? 'Echo' : r.kind === 'Fetal monitoring' ? 'CTG' : r.kind === 'Clinical photographs' ? 'Photos' : r.kind
  return `${what} · ${day}`
}

export function ReportCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const navigate = useNavigate()
  const reports = reportsFor(p.id)
  const [chosen, setChosen] = useState<string | undefined>(() => viewableStudyFor(p.id)?.id ?? reports[0]?.id)
  const [frame, setFrame] = useState<number | undefined>(undefined)

  if (reports.length === 0) {
    return (
      <Card titleSize="sm" title="Report viewer" className={className}>
        <ViewerPlaceholder fill icon={ImageOff} line="No imaging on file" className="mx-auto max-w-[360px]" />
      </Card>
    )
  }

  const report = reports.find((r) => r.id === chosen) ?? reports[0]
  const study = report.studyId ? maybeImagingStudy(report.studyId) : undefined
  const choose = (id: string) => {
    setChosen(id)
    setFrame(undefined)
  }

  function onTabsKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = reports.findIndex((r) => r.id === report.id)
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? reports.length - 1 : null
    if (next === null) return
    e.preventDefault()
    const r = reports[(next + reports.length) % reports.length]
    choose(r.id)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-report="${r.id}"]`)?.focus()
  }

  const open = study ? `/radiology/study/${study.id}/view${frame ? `?frame=${frame}` : ''}` : undefined

  return (
    <Card
      titleSize="sm"
      title="Report viewer"
      right={
        open ? (
          <Pill variant="control" size="md" icon={ScanLine} onClick={() => navigate(open)}>
            Open in Imaging
          </Pill>
        ) : (
          <TextLink onClick={() => navigate(recordPath(p, 'reports'))}>See all</TextLink>
        )
      }
      // min-w-0: the pill row scrolls inside the card and never widens the grid's first column.
      className={cn('min-w-0', className)}
    >
      {reports.length > 1 && (
        <div role="tablist" aria-label="Which report" onKeyDown={onTabsKey} className="-mt-[4px] mb-[12px] flex gap-[6px] overflow-x-auto pb-[2px]">
          {reports.map((r) => {
            const s = r.studyId ? maybeImagingStudy(r.studyId) : undefined
            const on = r.id === report.id
            return (
              <button
                key={r.id}
                type="button"
                role="tab"
                data-report={r.id}
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                title={`${r.title} · ${formatDate(r.at)}`}
                onClick={() => choose(r.id)}
                className={cn(
                  'inline-flex h-[44px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-full px-[12px] text-[13px] font-medium transition-colors duration-150',
                  on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-control text-sh-text-2 hover:bg-sh-hover-strong hover:text-sh-text',
                )}
              >
                <Icon icon={s ? MODALITY_ICON[s.modality] : (KIND_ICON[r.kind] ?? FileText)} size={14} />
                {pillLabel(r, s)}
              </button>
            )
          })}
        </div>
      )}

      <div role="tabpanel" aria-label={report.title} className="flex min-h-0 flex-1 flex-col">
        {study ? <StudyTile key={study.id} study={study} onFrame={setFrame} /> : <DocumentTile report={report} />}
      </div>
    </Card>
  )
}

/** A study: its images where they exist (the head CT with the model's verdict), else the frame and its report. */
function StudyTile({ study, onFrame }: { study: ImagingStudy; onFrame: (n: number) => void }) {
  const aiActive = useAiActive()
  const navigate = useNavigate()
  const ncct = ncctFor(study)
  const view = seriesViewFor(study)

  if (ncct) {
    const c = maybeStrokeCase(ncct.strokeCaseId)
    const verdict = triageVerdict(ncct.truth, c)
    const overlays = aiActive ? overlaysFor(ncct.key, c) : []
    const first = overlays[0]
    const slice = first ? Math.round((first.from + first.to) / 2) : undefined
    return (
      <>
        <NcctViewer key={ncct.key} study={ncct} overlays={overlays} initialSlice={slice} onSlice={onFrame} className="mx-auto w-full max-w-[360px]" compact />
        {aiActive ? (
          <p className="mt-[12px] flex flex-wrap items-center gap-[8px] text-[13px]">
            <Diamond />
            <span className="font-semibold text-sh-text">{verdict.headline}</span>
            <Chip word={verdict.priorityWord} tone={VERDICT_TONE[verdict.tone]} />
            {c && <RoundButton icon={Brain} size={36} iconSize={16} variant="control" label="Open in the Stroke-AI Console" onClick={() => navigate(`/stroke/ai-console?case=${c.id}`)} className="ml-auto" />}
          </p>
        ) : (
          <p className="sh-clamp-2 mt-[12px] text-[13px] text-sh-text-2">{study.impression}</p>
        )}
        <Byline study={study} />
      </>
    )
  }

  if (view) {
    return (
      <>
        <StudyViewer key={view.key} series={view} onSlice={onFrame} className="mx-auto w-full max-w-[360px]" compact />
        <p className="sh-clamp-2 mt-[12px] text-[13px] text-sh-text-2">{study.impression}</p>
        <Byline study={study} />
      </>
    )
  }

  return (
    <>
      <ViewerPlaceholder fill icon={MODALITY_ICON[study.modality]} line="Report only — no openly licensed image fits this study, so none is shown." className="mx-auto max-w-[360px]" />
      <div className="mt-[12px] text-[15px]/[1.3] font-medium text-sh-text">{study.description}</div>
      <p className="sh-clamp-3 mt-[6px] text-[14px]/[1.45] text-sh-text-2">{study.impression}</p>
      <Byline study={study} />
    </>
  )
}

function Byline({ study }: { study: ImagingStudy }) {
  return (
    <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
      {study.description} · {study.reportedBy ?? 'Awaiting radiologist'}
      {study.status === 'Preliminary' ? ' · preliminary' : ''} · {formatDate(study.acquiredAt)} {formatTime(study.acquiredAt)}
    </p>
  )
}

/** A document — ECG, echo, CTG, operative note: the frame where images would be, and the report. */
function DocumentTile({ report }: { report: RecordReport }) {
  return (
    <>
      <ViewerPlaceholder fill icon={KIND_ICON[report.kind] ?? FileText} line={`${report.kind} — no images with this report`} className="mx-auto max-w-[360px]" />
      <div className="mt-[12px] text-[15px]/[1.3] font-medium text-sh-text">{report.title}</div>
      <div className="mt-[2px] text-[12px] tabular-nums text-sh-text-3">
        {formatDate(report.at)} {formatTime(report.at)} · {report.by}
      </div>
      <p className="sh-clamp-3 mt-[8px] text-[14px]/[1.45] text-sh-text-2">{report.summary}</p>
      {report.body && report.body.length > 0 && (
        <ul className="mt-[10px] flex flex-col gap-[4px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-[13px] text-sh-text-2">
          {report.body.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  )
}
