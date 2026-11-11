/**
 * S-06-12 · Imaging reports — `/patient/:id/reports` (`src/screens/m06/record/
 * S0612.tsx`): every report on the record — imaging, discharge summaries,
 * operative notes, ECGs. Each is one line until opened: what it was, when, who
 * signed it, and the impression; the body is one tap away. An imaging report
 * with real pixels behind it opens the viewer; one without says so, rather
 * than pretending with somebody else's scan.
 */

import {
  Activity, Camera, ChevronDown, ChevronRight, DoorOpen, FileText, Gavel, HeartPulse, Radio, ScanLine, ScrollText, Syringe, type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { reportsFor, type RecordReport } from '@/data/record'

import { Card, Chip, CountBubble, Icon, Pill } from '../ui/primitives'
import { EmptyState } from '../ui/EmptyState'
import { Segmented } from '../ui/Segmented'

import { RecordFrame } from './RecordFrame'

type Filter = 'all' | 'imaging' | 'documents'

const KIND_ICON: Record<RecordReport['kind'], LucideIcon> = {
  Imaging: ScanLine,
  'Discharge summary': DoorOpen,
  'Operative note': Syringe,
  ECG: HeartPulse,
  Echocardiogram: HeartPulse,
  Ultrasound: Radio,
  'Medico-legal': Gavel,
  'Fetal monitoring': Activity,
  'Clinical photographs': Camera,
}

export function ReportsPage() {
  const { id } = useParams()
  return (
    <RecordFrame id={id} section="reports">
      {(p) => <Reports patient={p} />}
    </RecordFrame>
  )
}

function Reports({ patient: p }: { patient: Patient }) {
  const [filter, setFilter] = useState<Filter>('all')
  // Imaging first, then the other documents (discharge summaries, ECGs …) — each newest first.
  const every = reportsFor(p.id)
  const imaging = every.filter((r) => r.kind === 'Imaging')
  const docs = every.filter((r) => r.kind !== 'Imaging')
  const all = [...imaging, ...docs]
  const shown = filter === 'imaging' ? imaging : filter === 'documents' ? docs : all

  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Imaging reports
          <CountBubble className="bg-sh-control">{all.length}</CountBubble>
        </span>
      }
      right={
        <Segmented
          label="Which reports"
          value={filter}
          onChange={setFilter}
          options={[
            { key: 'all', label: 'All', count: all.length },
            { key: 'imaging', label: 'Imaging', icon: ScanLine, count: imaging.length },
            { key: 'documents', label: 'Documents', icon: FileText, count: docs.length },
          ]}
        />
      }
      headerClassName="flex-wrap gap-y-[10px]"
    >
      {shown.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          why={
            all.length === 0
              ? `No reports are on ${p.name}’s record yet. A scan, an ECG or a discharge summary would appear here once reported.`
              : 'Nothing in this group. Choose All to see every report.'
          }
        />
      ) : (
        <ul className="flex flex-col">
          {shown.map((r, i) => (
            <ReportRow key={r.id} report={r} first={i === 0} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function ReportRow({ report: r, first }: { report: RecordReport; first: boolean }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const hasBody = (r.body?.length ?? 0) > 0

  return (
    <li className={first ? 'pb-[14px]' : 'border-t border-sh-line py-[14px]'}>
      <div className="flex flex-wrap items-start gap-[12px]">
        <span className="inline-flex size-[36px] shrink-0 items-center justify-center rounded-[12px] bg-sh-inner text-sh-text-2" aria-hidden="true">
          <Icon icon={KIND_ICON[r.kind]} size={16} />
        </span>
        <div className="min-w-0 flex-1 basis-[280px]">
          <p className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
            <span className="text-[14px] font-semibold text-sh-text">{r.title}</span>
            <Chip word={r.kind} tone="neu" />
            {r.kind === 'Imaging' && r.by === 'Awaiting radiologist' && <Chip word="Awaiting report" tone="warn" />}
          </p>
          <p className="mt-[4px] text-[14px]/[1.5] text-sh-text-2">{r.summary}</p>
          <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
            {formatDate(r.at)} {formatTime(r.at)} · {r.by}
          </p>
          {open && hasBody && (
            <ul className="mt-[10px] flex flex-col gap-[4px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-[13px] text-sh-text-2">
              {r.body!.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          {hasBody && (
            <Pill variant="ghost" size="md" icon={open ? ChevronDown : ChevronRight} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? 'Less' : 'Full report'}
            </Pill>
          )}
          {r.studyId && (
            <Pill
              variant={r.viewable ? 'primary' : 'control'}
              size="md"
              icon={r.viewable ? ScanLine : FileText}
              onClick={() => navigate(`/radiology/study/${r.studyId}/view`)}
            >
              {r.viewable ? 'Open images' : 'Report only'}
            </Pill>
          )}
        </div>
      </div>
    </li>
  )
}
