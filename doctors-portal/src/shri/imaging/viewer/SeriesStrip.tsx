/**
 * The workstation's study strip: every study of this patient's with images,
 * as a thumbnail with its modality, date and image count, the one open
 * highlighted, an earlier study of the same kind marked "prior". A click opens
 * that study in the workstation.
 */

import { Link } from 'react-router-dom'

import { formatDate } from '@/data/format'
import { imagingFor, type ImagingStudy } from '@/data/imaging'

import { cn } from '../../lib/cn'
import { seriesViewFor } from '../../logic/series'

export function SeriesStrip({ study }: { study: ImagingStudy }) {
  const all = imagingFor(study.patientId)
    .map((s) => ({ s, v: seriesViewFor(s) }))
    .filter((x) => x.v !== undefined)
  if (all.length < 2) return null
  return (
    <nav aria-label="This patient's studies" className="flex gap-[8px] overflow-x-auto pb-[2px]">
      {all.map(({ s, v }) => {
        const on = s.id === study.id
        const prior = !on && s.modality === study.modality && s.acquiredAt < study.acquiredAt
        const mid = v!.kind === 'stack' ? Math.max(1, Math.round(v!.frames / 2)) : 1
        return (
          <Link
            key={s.id}
            to={`/radiology/study/${s.id}/view`}
            aria-current={on ? 'page' : undefined}
            className={cn('flex w-[132px] shrink-0 flex-col overflow-hidden rounded-[14px] bg-sh-card text-left ring-2 transition-colors duration-150', on ? 'ring-sh-accent' : 'ring-transparent hover:bg-sh-hover')}
          >
            <span className="relative block aspect-[4/3] bg-black">
              <img src={v!.path(mid)} alt="" className="size-full object-contain" loading="lazy" />
              {prior && <span className="absolute left-[6px] top-[4px] rounded-[6px] bg-black/70 px-[5px] text-[10px] font-semibold text-(--on-image-ink)">prior</span>}
            </span>
            <span className="px-[8px] py-[6px]">
              <span className="block truncate text-[12px] font-medium text-sh-text">{s.description}</span>
              <span className="block text-[11px] tabular-nums text-sh-text-3">
                {formatDate(s.acquiredAt).slice(0, 6)} · {v!.frames} {v!.frames === 1 ? 'image' : 'images'}
              </span>
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
