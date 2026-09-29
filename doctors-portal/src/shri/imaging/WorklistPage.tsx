/**
 * S-15-01 · Imaging worklist — `/radiology/worklist` (`src/screens/m15/
 * S1501.tsx`): "Every study on the record, the AI-flagged ones first — pick a
 * patient, then open the scan."
 *
 * The patients with imaging, their study, when it was done, and the AI flag
 * derived from that series' own labels. Nothing opens until a row is chosen.
 * With the AI on the list is in AI-404's order (bleed, then mass effect;
 * awaiting before reported; then newest) with newest-first one choice away;
 * with it off, newest first and no flags. The filter is in the address.
 */

import { Check, Clock, Image, Radio, ScanLine, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatDate, formatTime } from '@/data/format'
import { IMAGING_STUDIES, aiFlagFor, type ImagingStudy } from '@/data/imaging'
import { patient } from '@/data/kit'

import { ScreenFrame } from '../app/ScreenFrame'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { Icon, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

type Filter = 'all' | 'flagged' | 'awaiting' | 'reported'
const FILTERS: readonly Filter[] = ['all', 'flagged', 'awaiting', 'reported']
const FLAG_RANK = { critical: 0, caution: 1, normal: 2 } as const

export function WorklistPage() {
  const navigate = useNavigate()
  const aiActive = useAiActive()
  const [scope, setScope] = useScope(FILTERS, 'all')
  const [aiSort, setAiSort] = useState(true)
  // With the AI off there is no flag to filter by.
  const filter: Filter = !aiActive && scope === 'flagged' ? 'all' : scope

  const flagged = IMAGING_STUDIES.filter((s) => {
    const f = aiFlagFor(s)
    return f && f.tone !== 'normal'
  })
  const awaiting = IMAGING_STUDIES.filter((s) => s.status === 'Awaiting report')
  const reported = IMAGING_STUDIES.filter((s) => s.status === 'Reported')

  const rows = useMemo(() => {
    const base = filter === 'flagged' ? flagged : filter === 'awaiting' ? awaiting : filter === 'reported' ? reported : IMAGING_STUDIES
    const byTime = [...base].sort((a, b) => b.acquiredAt.getTime() - a.acquiredAt.getTime())
    if (!aiActive || !aiSort) return byTime
    // AI order: flagged first (bleed, then mass effect), awaiting before reported, then newest.
    return byTime.sort((a, b) => {
      const fa = aiFlagFor(a)
      const fb = aiFlagFor(b)
      const ra = fa ? FLAG_RANK[fa.tone] : 3
      const rb = fb ? FLAG_RANK[fb.tone] : 3
      if (ra !== rb) return ra - rb
      if (a.status !== b.status) return a.status === 'Awaiting report' ? -1 : 1
      return b.acquiredAt.getTime() - a.acquiredAt.getTime()
    })
  }, [filter, aiActive, aiSort, flagged, awaiting, reported])

  const columns: WorklistColumn<ImagingStudy>[] = [
    {
      key: 'when',
      label: 'Acquired',
      role: 'lead',
      cell: (s) => (
        <span className="flex flex-col leading-tight tabular-nums">
          <span>{formatTime(s.acquiredAt)}</span>
          <span className="text-[11px] font-normal text-sh-text-2">{formatDate(s.acquiredAt).slice(0, 6)}</span>
        </span>
      ),
    },
    { key: 'patient', label: 'Patient', role: 'primary', cell: (s) => patient(s.patientId).name },
    {
      key: 'who',
      label: 'Age / sex',
      role: 'context',
      cell: (s) => {
        const p = patient(s.patientId)
        return (
          <span className="tabular-nums">
            {p.age}/{p.sex} · {p.uhid}
          </span>
        )
      },
    },
    {
      key: 'study',
      label: 'Study',
      role: 'context',
      cell: (s) => (
        <span className="inline-flex items-center gap-[6px]">
          <Icon icon={s.modality === 'CT' ? ScanLine : s.modality === 'X-ray' ? Image : Radio} size={13} />
          {s.id} · {s.description}
          {!s.ncctKey && ' · report only'}
        </span>
      ),
    },
    {
      key: 'flag',
      label: 'AI flag',
      role: 'status',
      cell: (s) => {
        const f = aiActive ? aiFlagFor(s) : undefined
        if (!f) return null
        return (
          <PillTag tone={f.tone === 'critical' ? 'crit' : f.tone === 'caution' ? 'warn' : 'norm'} size="xs" icon={f.tone === 'normal' ? Check : TriangleAlert} className="font-semibold">
            {f.label}
          </PillTag>
        )
      },
    },
    {
      key: 'status',
      label: 'Report',
      role: 'status',
      cell: (s) =>
        s.status === 'Awaiting report' ? (
          <PillTag tone="warn" size="xs" icon={Clock} className="font-semibold">
            Awaiting report
          </PillTag>
        ) : (
          <PillTag tone="neu" size="xs" icon={Check} className="font-semibold">
            Reported
          </PillTag>
        ),
    },
  ]

  return (
    <ScreenFrame screenId="S-15-01" sub={`${IMAGING_STUDIES.length} studies · ${aiActive ? `${flagged.length} flagged by AI · ` : ''}${awaiting.length} awaiting a report`}>
      <div className="max-w-[1024px]">
        <Worklist
          rows={rows}
          columns={columns}
          rowKey={(s) => s.id}
          rowLabel={(s) => `${patient(s.patientId).name} — ${s.id} · ${s.description}`}
          onOpen={(s) => navigate(`/radiology/study/${s.id}/view`)}
          aiSort={aiActive ? aiSort : false}
          onSortChange={setAiSort}
          sortCapability="AI-404"
          aiSortLabel="AI flag, then newest"
          deterministicLabel="Newest first"
          caption="Imaging studies on the record"
          noun="studies"
          emptyWhy="No studies match this filter. Choose All to see every study on the record."
          filters={
            <Segmented
              label="Which studies"
              value={filter}
              onChange={setScope}
              options={[
                { key: 'all' as const, label: 'All', count: IMAGING_STUDIES.length },
                ...(aiActive ? [{ key: 'flagged' as const, label: 'AI-flagged', count: flagged.length }] : []),
                { key: 'awaiting' as const, label: 'Awaiting report', count: awaiting.length },
                { key: 'reported' as const, label: 'Reported', count: reported.length },
              ]}
            />
          }
        />
      </div>
    </ScreenFrame>
  )
}
