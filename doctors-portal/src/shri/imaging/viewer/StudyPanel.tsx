/**
 * The workstation's study panel, beside the image: the reader's marks, the key
 * images, the report — the signed one read-only, a draft for a study still to
 * be reported, an addendum for one that is, each signed by a named reader and
 * appended, never overwriting — and the study's header, as a DICOM viewer
 * shows its tags. Everything here is the reader's; the report text is what a
 * person typed, never generated.
 */

import { FilePen, ListTree, PenLine, Signature, Star, Tags, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { formatDateTime } from '@/data/format'
import type { ImagingStudy } from '@/data/imaging'
import type { ImageSeries } from '@/data/imaging.generated'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import type { SeriesView } from '../../logic/series'
import { useImaging } from '../../state/imaging'
import { Field, TextArea } from '../../ui/forms'
import { KeyValue } from '../../ui/KeyValue'
import { Card, Icon, Pill } from '../../ui/primitives'
import { Segmented } from '../../ui/Segmented'

import { TOOL_LABEL, measure } from './tools'

type Tab = 'marks' | 'keys' | 'report' | 'tags'

export function StudyPanel({
  study,
  series,
  image,
  tags,
  onGo,
}: {
  study: ImagingStudy
  series: SeriesView
  /** The open-dataset series, where it is one — for its tags. */
  image?: ImageSeries
  /** Extra header rows (a head CT's slice thickness and kVp). */
  tags?: [string, string][]
  /** Jump the viewer to an image. */
  onGo?: (frame: number) => void
}) {
  const [tab, setTab] = useState<Tab>('marks')
  const annotations = useImaging((s) => s.annotations[study.id]) ?? []
  const keys = useImaging((s) => s.keyImages[study.id]) ?? []
  const setAnnotations = useImaging((s) => s.setAnnotations)
  const me = useCurrentStaff()
  const audit = useAudit((s) => s.record)

  return (
    <Card
      titleSize="sm"
      title="Study panel"
      right={
        <Segmented
          label="Study panel"
          value={tab}
          onChange={setTab}
          options={[
            { key: 'marks', label: 'Marks', icon: PenLine, count: annotations.length },
            { key: 'keys', label: 'Key', icon: Star, count: keys.length },
            { key: 'report', label: 'Report', icon: FilePen },
            { key: 'tags', label: 'Tags', icon: Tags },
          ]}
        />
      }
      headerClassName="flex-wrap gap-y-[10px]"
    >
      {tab === 'marks' &&
        (annotations.length === 0 ? (
          <p className="text-[14px] text-sh-text-2">No marks yet. Choose a tool above the image — length, angle, ellipse, arrow, text or pen — and draw on the image. Marks are kept with the study.</p>
        ) : (
          <ul aria-label="Marks on this study" className="flex flex-col divide-y divide-(--line)">
            {[...annotations]
              .sort((a, b) => a.frame - b.frame || a.at.localeCompare(b.at))
              .map((a) => (
                <li key={a.id} className="flex min-h-[44px] items-center gap-[8px] py-[6px] text-[13px]">
                  <button type="button" onClick={() => onGo?.(a.frame)} className="min-w-0 flex-1 rounded-[10px] px-[4px] py-[4px] text-left hover:bg-sh-hover">
                    <span className="block font-medium text-sh-text">
                      {TOOL_LABEL[a.tool]}
                      {measure(a, series.pixelSpacing, a.value) ? ` · ${measure(a, series.pixelSpacing, a.value)}` : ''}
                      {a.text ? ` · “${a.text}”` : ''}
                    </span>
                    <span className="block text-[12px] tabular-nums text-sh-text-3">
                      image {a.frame} · {a.by} · {formatDateTime(new Date(a.at))}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete the ${TOOL_LABEL[a.tool].toLowerCase()} on image ${a.frame}`}
                    onClick={() => {
                      setAnnotations(
                        study.id,
                        annotations.filter((x) => x.id !== a.id),
                      )
                      audit({ event: 'IMAGING.ANNOTATION_DELETED', actor: me.name, actorId: me.id, subject: study.id, detail: `${study.id} · image ${a.frame} · ${TOOL_LABEL[a.tool]} by ${a.by}` })
                    }}
                    className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover"
                  >
                    <Icon icon={Trash2} size={15} />
                  </button>
                </li>
              ))}
          </ul>
        ))}

      {tab === 'keys' &&
        (keys.length === 0 ? (
          <p className="text-[14px] text-sh-text-2">No key images. Press K, or the star in the toolbar, on the image that carries the finding.</p>
        ) : (
          <ul aria-label="Key images" className="flex flex-wrap gap-[8px]">
            {keys.map((k) => (
              <li key={k}>
                <button type="button" onClick={() => onGo?.(k)} className="group relative block overflow-hidden rounded-[12px] bg-black" aria-label={`Key image ${k}`}>
                  <img src={series.path(k)} alt="" className="size-[88px] object-contain" />
                  <span className="absolute bottom-[4px] left-[6px] text-[11px] font-semibold text-(--on-image-ink)">★ {k}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'report' && <ReportTab study={study} />}

      {tab === 'tags' && (
        <dl className="divide-y divide-(--line)">
          <KeyValue label="Modality">{image?.modality ?? study.modality}</KeyValue>
          <KeyValue label="Body part">{image?.bodyPart ?? study.description}</KeyValue>
          {image && <KeyValue label="View / sequence">{image.view}</KeyValue>}
          <KeyValue label="Study">
            {study.id} · {study.description}
          </KeyValue>
          <KeyValue label="Acquired">
            <span className="tabular-nums">{formatDateTime(study.acquiredAt)}</span>
          </KeyValue>
          <KeyValue label="Images">
            <span className="tabular-nums">{series.frames}</span>
            {image && image.seriesTotal > series.frames ? ` of ${image.seriesTotal} in the source series` : ''}
          </KeyValue>
          {image && (
            <KeyValue label="Matrix (source)">
              <span className="tabular-nums">
                {image.columns} × {image.rows}
              </span>
            </KeyValue>
          )}
          <KeyValue label="Pixel spacing (displayed)">
            <span className="tabular-nums">{series.pixelSpacing ? `${series.pixelSpacing[0].toFixed(3)} × ${series.pixelSpacing[1].toFixed(3)} mm` : 'not stated by the source — uncalibrated'}</span>
          </KeyValue>
          {image?.sliceThickness && <KeyValue label="Slice thickness">{image.sliceThickness} mm</KeyValue>}
          {image && <KeyValue label="Window at export">{image.window === 'auto' ? 'Automatic (percentile) or the file’s own' : image.window.replace('W', 'W ').replace('L', ' / L ')}</KeyValue>}
          {tags?.map(([k, v]) => (
            <KeyValue key={k} label={k}>
              {v}
            </KeyValue>
          ))}
          {image && (
            <KeyValue label="Source">
              <a href={image.source.url} target="_blank" rel="noreferrer" className="underline decoration-(--line-strong) underline-offset-2 hover:text-sh-text">
                {image.source.dataset}
              </a>{' '}
              · {image.source.licence} · de-identified
            </KeyValue>
          )}
          <KeyValue label="Report status">{study.status}</KeyValue>
        </dl>
      )}
    </Card>
  )
}

/**
 * The report: signed text read-only; a draft for a study not yet reported, or
 * an addendum for one that is; Sign appends, with the reader's name.
 */
function ReportTab({ study }: { study: ImagingStudy }) {
  const me = useCurrentStaff()
  const audit = useAudit((s) => s.record)
  const toast = useUI((s) => s.toast)
  const draft = useImaging((s) => s.drafts[study.id])
  const signed = useImaging((s) => s.signed[study.id]) ?? []
  const saveDraft = useImaging((s) => s.saveDraft)
  const sign = useImaging((s) => s.sign)
  const reported = study.status === 'Reported' || signed.some((x) => x.kind === 'Report')
  const kind = reported ? 'Addendum' : 'Report'
  const [findings, setFindings] = useState(draft?.findings ?? '')
  const [impression, setImpression] = useState(draft?.impression ?? '')
  const id = `report-${study.id}`

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="rounded-[14px] bg-sh-inner px-[14px] py-[12px]">
        <p className="flex items-center gap-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">
          <Icon icon={ListTree} size={13} /> {study.status === 'Reported' ? 'Signed report' : study.status === 'Preliminary' ? 'Preliminary report' : 'Not yet reported'}
        </p>
        {study.status !== 'Awaiting report' && <p className="mt-[6px] text-[14px] text-sh-text">{study.impression}</p>}
        <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
          {study.reportedBy ?? 'Awaiting radiologist'} · {formatDateTime(study.acquiredAt)}
        </p>
      </div>

      {signed.length > 0 && (
        <ul aria-label="Signed in this session" className="flex flex-col gap-[8px]">
          {signed.map((x) => (
            <li key={x.id} className="rounded-[14px] border border-sh-line px-[14px] py-[10px] text-[14px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-norm-fg">{x.kind} · signed</p>
              {x.findings && <p className="mt-[4px] text-sh-text-2">{x.findings}</p>}
              <p className="mt-[4px] font-medium text-sh-text">{x.impression}</p>
              <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-3">
                {x.by} · {formatDateTime(new Date(x.at))}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-[10px]">
        <p className="text-[13px] font-semibold text-sh-text">{kind === 'Report' ? 'Write the report' : 'Add an addendum'}</p>
        {kind === 'Report' && (
          <Field label="Findings" htmlFor={`${id}-findings`}>
            <TextArea id={`${id}-findings`} value={findings} onChange={(e) => setFindings(e.target.value)} />
          </Field>
        )}
        <Field label={kind === 'Report' ? 'Impression' : 'Addendum'} htmlFor={`${id}-impression`} hint="What you conclude, in your words — signed with your name.">
          <TextArea id={`${id}-impression`} value={impression} onChange={(e) => setImpression(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Pill
            variant="control"
            size="md"
            icon={FilePen}
            disabled={!findings.trim() && !impression.trim()}
            onClick={() => {
              saveDraft(study.id, findings.trim(), impression.trim())
              audit({ event: 'IMAGING.REPORT_DRAFTED', actor: me.name, actorId: me.id, subject: study.id, detail: `${study.id} · ${kind.toLowerCase()} saved as a draft` })
              toast({ tone: 'success', title: 'Draft saved', detail: `${study.id} · not part of the record until it is signed.` })
            }}
          >
            Save draft
          </Pill>
          <Pill
            variant="primary"
            size="md"
            icon={Signature}
            disabled={impression.trim().length < 10}
            onClick={() => {
              sign(study.id, { kind, findings: findings.trim() || undefined, impression: impression.trim(), by: me.name })
              audit({ event: kind === 'Report' ? 'IMAGING.REPORT_SIGNED' : 'IMAGING.ADDENDUM_SIGNED', actor: me.name, actorId: me.id, subject: study.id, detail: `${study.id} · ${kind.toLowerCase()} signed · ${impression.trim().slice(0, 80)}` })
              toast({ tone: 'success', title: `${kind} signed`, detail: `${study.id} · ${me.name}. Appended to the study; nothing earlier is changed.` })
              setFindings('')
              setImpression('')
            }}
          >
            Sign {kind.toLowerCase()}
          </Pill>
          <span className="text-[12px] text-sh-text-3">{draft ? `Draft saved ${formatDateTime(new Date(draft.savedAt))}` : 'Ten characters or more to sign.'}</span>
        </div>
      </div>
    </div>
  )
}
