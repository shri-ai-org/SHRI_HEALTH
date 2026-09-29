/**
 * §7.5 Report viewer (column A) — the latest thing on file that can be looked
 * at (`src/screens/m06/record/ReportViewer.tsx`): the patient's own CT on the
 * dark preview tile, with the model's verdict beneath while AI is on; failing
 * that, the newest document report. With nothing on file the page does not
 * draw the card at all — the Reports tab's count says so, without a hole.
 *
 * The tile is the viewer itself, compact, as the old card had it: every slice
 * by wheel, slider, ‹ › or the arrow keys, the AI's marks drawn on the slices
 * they belong to while AI is on, the switch that lifts them off. It opens on
 * the middle of the first finding, or the middle of the stack.
 */

import { Activity, Brain, FileText, HeartPulse, ImageOff, ScanLine, Waves, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { formatDate, formatTime } from '@/data/format'
import { ncctFor, viewableStudyFor } from '@/data/imaging'
import type { Patient } from '@/data/kit'
import { reportsFor } from '@/data/record'
import { maybeStrokeCase } from '@/data/stroke'
import { overlaysFor, triageVerdict } from '@/data/strokeai'

import { recordPath } from '../logic/record'
import type { Tone } from '../mocks/types'
import { useAiActive } from '../state/ai'
import { NcctViewer, ViewerPlaceholder } from '../ui/NcctViewer'
import { Card, Chip, Diamond, Pill, RoundButton } from '../ui/primitives'

import { TextLink } from './bits'

/** The frame's neutral icon, by what the report is. */
const KIND_ICON: Partial<Record<string, LucideIcon>> = { Imaging: ScanLine, Ultrasound: Waves, ECG: Activity, Echocardiogram: HeartPulse }

const VERDICT_TONE: Record<'critical' | 'caution' | 'normal', Tone> = { critical: 'crit', caution: 'warn', normal: 'norm' }

export function ReportCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const aiActive = useAiActive()
  const navigate = useNavigate()
  const study = viewableStudyFor(p.id)
  const series = study ? ncctFor(study) : undefined

  if (study && series) {
    const c = maybeStrokeCase(series.strokeCaseId)
    const verdict = triageVerdict(series.truth, c)
    const overlays = aiActive ? overlaysFor(series.key, c) : []
    const first = overlays[0]
    const slice = first ? Math.round((first.from + first.to) / 2) : undefined
    return (
      <Card
        titleSize="sm"
        title="Report viewer"
        right={
          <span className="flex items-center gap-[8px]">
            {c && <RoundButton icon={Brain} size={36} iconSize={16} variant="control" label="Open in the Stroke-AI Console" onClick={() => navigate(`/stroke/ai-console?case=${c.id}`)} />}
            <Pill variant="control" size="md" icon={ScanLine} onClick={() => navigate(`/radiology/study/${study.id}/view`)}>
              Open in Imaging
            </Pill>
          </span>
        }
        className={className}
      >
        <NcctViewer key={series.key} study={series} overlays={overlays} initialSlice={slice} className="mx-auto w-full max-w-[360px]" compact />
        {aiActive ? (
          <p className="mt-[12px] flex flex-wrap items-center gap-[8px] text-[13px]">
            <Diamond />
            <span className="font-semibold text-sh-text">{verdict.headline}</span>
            <Chip word={verdict.priorityWord} tone={VERDICT_TONE[verdict.tone]} />
          </p>
        ) : (
          <p className="sh-clamp-2 mt-[12px] text-[13px] text-sh-text-2">{study.impression}</p>
        )}
        <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
          {study.reportedBy ?? 'Awaiting radiologist'} · {formatDate(study.acquiredAt)} {formatTime(study.acquiredAt)}
        </p>
      </Card>
    )
  }

  const report = reportsFor(p.id)[0]
  if (!report) {
    return (
      <Card titleSize="sm" title="Report viewer" className={className}>
        <ViewerPlaceholder fill icon={ImageOff} line="No imaging on file" className="mx-auto max-w-[360px]" />
      </Card>
    )
  }
  const imaging = report.studyId !== undefined
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Report viewer
          <Chip word={report.kind} tone="pend" />
        </span>
      }
      right={<TextLink onClick={() => navigate(recordPath(p, 'reports'))}>See all</TextLink>}
      className={className}
    >
      {/* The frame where the images would be: a report-only study says its images are not here; a document says it has none. */}
      <ViewerPlaceholder
        fill
        icon={KIND_ICON[report.kind] ?? FileText}
        line={imaging ? 'Report only — the images for this study are not in this demo.' : `A ${report.kind.toLowerCase()} — no images with this report`}
        className="mx-auto max-w-[360px]"
      />
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
    </Card>
  )
}
