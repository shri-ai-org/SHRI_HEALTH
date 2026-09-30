/**
 * S-15-04 · Imaging — `/radiology/study/:id/view` (`src/screens/m15/
 * S1504.tsx`): "The viewer, with the AI overlay a radiologist will actually
 * leave on."
 *
 * An overlay a radiologist switches off on the first study is worse than none,
 * so the switch is prominent, the unmarked image is always one control away,
 * and the findings sit beside the image rather than on it. REAL PIXELS: an
 * imported CQ500 head CT, windowed at import and served as PNG slices; the
 * findings come from that study's own ground-truth labels, so the words cannot
 * contradict the image. The same viewer and report the Stroke-AI Console uses.
 *
 * Beside the image: the AI read (G3 — attested, not merely confirmed), the
 * full clinical report, a reading note dictated first and saved with the
 * study, and questions about this scan answered with citations.
 *
 * Where the old screen fell short:
 *   · "Attested" showed after ANY decision on the read — a rejection included;
 *     here it shows only when the read was accepted, and a rejection says so;
 *   · the two panes of "Original beside overlay" moved separately; here they
 *     share one slice;
 *   · an unknown address fell back to Vikram Malhotra's study; here it says
 *     there is no such study;
 *   · saving a reading note wrote no audit row; here it does;
 *   · the questions were answered in the assistant drawer; here they are
 *     answered in the card, with their citations, beside the scan they ask
 *     about.
 */

import { Brain, Check, Columns2, FileText, List, MessageSquare, PhoneCall, Save, ScanLine, Send, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { promptsFor, resolveAnswer, type AssistantAnswer } from '@/data/assistant'
import { formatDateTime, formatTime } from '@/data/format'
import { imageFor, maybeImagingStudy, ncctFor, type ImagingStudy } from '@/data/imaging'
import type { ImageSeries } from '@/data/imaging.generated'
import { patient } from '@/data/kit'
import { NCCT_WINDOW, type NcctStudy } from '@/data/ncct.generated'
import { IMAGING_TRIAGE, maybeStrokeCase } from '@/data/stroke'
import { ncctFindings, overlaysFor, triageVerdict } from '@/data/strokeai'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { NCCT_MODEL, citationLink, criticalFindingFor } from '../logic/imaging'
import { imageView } from '../logic/series'
import { RecordDoors } from '../record/RecordDoors'
import { StrokeAIReport } from '../stroke/StrokeAIReport'
import { useAiActive, useForcedState } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { Disclosure, Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { TextInput } from '../ui/forms'
import { KeyValue } from '../ui/KeyValue'
import { NcctViewer, StudyViewer } from '../ui/NcctViewer'
import { Card, ConfidenceMark, Diamond, Pill, PillTag } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

import { EscalateDialog } from './EscalateDialog'

export function StudyViewerPage() {
  const { id } = useParams()
  const record = maybeImagingStudy(id ?? '')
  const series = record ? ncctFor(record) : undefined
  const image = record ? imageFor(record) : undefined
  if (!record) return <StudyNotFound id={id} />
  if (image) return <ImageStudy key={record.id} study={record} image={image} />
  if (!series) return <ReportOnly study={record} />
  return <Viewer key={record.id} record={record} study={series} />
}

/** An address that names no study. Says so, rather than opening someone else's scan. */
function StudyNotFound({ id }: { id?: string }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  return (
    <ScreenFrame
      screenId="S-15-04"
      sub="No study at this address."
      actions={
        may('/radiology/worklist') && (
          <Pill variant="primary" size="xl" icon={List} iconSize={17} onClick={() => navigate('/radiology/worklist')}>
            Imaging worklist
          </Pill>
        )
      }
    >
      <Card className="max-w-[640px]">
        <EmptyState icon={ScanLine} why={`There is no study “${id ?? ''}” on the record. The imaging worklist lists every study there is.`} />
      </Card>
    </ScreenFrame>
  )
}

/** The report as the radiologist wrote it: impression, findings, who and when. */
function ReportBody({ study: s }: { study: ImagingStudy }) {
  return (
    <Card titleSize="sm" title="Report" right={<span className="text-[12px] text-sh-text-2">{s.status}</span>}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Impression</p>
      <p className="mt-[4px] text-[17px]/[1.5] text-sh-text">{s.impression}</p>
      {s.findings && (
        <ul className="mt-[12px] flex flex-col gap-[4px] text-[14px] text-sh-text-2">
          {s.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <p className="mt-[12px] text-[12px] tabular-nums text-sh-text-2">
        {s.reportedBy ?? 'Awaiting radiologist'} · {formatDateTime(s.acquiredAt)}
      </p>
    </Card>
  )
}

/**
 * A study backed by an open-dataset image — X-ray, ultrasound, MRI, echo, a
 * CT beyond the head. The image and its report; no AI read, because no model
 * reads these here. Where the pixels came from is on the frame and in the rail.
 */
function ImageStudy({ study: s, image }: { study: ImagingStudy; image: ImageSeries }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const p = patient(s.patientId)
  const view = imageView(image, s.description)
  const worklist = '/radiology/worklist'
  return (
    <ScreenFrame
      screenId="S-15-04"
      patient={p}
      sub={`${s.id} · ${s.description} · acquired ${formatDateTime(s.acquiredAt)}`}
      chips={
        <PillTag tone="neu" size="sm" icon={ScanLine}>
          {image.modality} · {image.view}
        </PillTag>
      }
      actions={
        may(worklist) && (
          <Pill variant="card" size="xl" icon={List} iconSize={17} onClick={() => navigate(worklist)}>
            Worklist
          </Pill>
        )
      }
      rail={
        <div className="flex flex-col gap-[16px]">
          <Card titleSize="sm" title="Study">
            <dl className="divide-y divide-(--line)">
              <KeyValue label="Acquired">
                <span className="tabular-nums">{formatDateTime(s.acquiredAt)}</span>
              </KeyValue>
              <KeyValue label="Series">
                {image.bodyPart} · {image.view}
              </KeyValue>
              <KeyValue label={image.frames > 1 ? 'Frames' : 'Matrix'}>
                <span className="tabular-nums">{image.frames > 1 ? `${image.frames} ${image.kind === 'loop' ? 'frames' : 'slices'}` : `${image.columns} × ${image.rows}`}</span>
              </KeyValue>
              <KeyValue label="Report">{s.status}</KeyValue>
              <KeyValue label="Source">
                <a href={image.source.url} target="_blank" rel="noreferrer" className="underline decoration-(--line-strong) underline-offset-2 hover:text-sh-text">
                  {image.source.dataset}
                </a>{' '}
                · {image.source.licence} · de-identified
              </KeyValue>
            </dl>
          </Card>
          <RecordDoors patient={p} exclude={['imaging']} label={null} />
        </div>
      }
      railTitle="Study"
    >
      <div className="grid grid-cols-1 gap-[20px] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:items-start">
        <div className="min-w-0">
          <StudyViewer series={view} />
        </div>
        <div className="flex min-w-0 flex-col gap-[16px]">
          <ReportBody study={s} />
          <Card titleSize="sm" title="AI read">
            <p className="text-[14px] text-sh-text-2">No model reads {image.modality === 'X-ray' ? 'X-rays' : image.modality === 'MRI' ? 'MRI' : image.modality === 'Echo' ? 'echocardiograms' : image.modality === 'CT' ? 'CT outside the head' : 'ultrasound'} here — the report above is the radiologist's alone.</p>
          </Card>
        </div>
      </div>
    </ScreenFrame>
  )
}

/** A study whose report is on the record but whose pixels are not in this demo. */
function ReportOnly({ study: s }: { study: ImagingStudy }) {
  const p = patient(s.patientId)
  return (
    <ScreenFrame
      screenId="S-15-04"
      patient={p}
      sub={`${s.id} · ${s.description} · acquired ${formatDateTime(s.acquiredAt)}`}
      chips={
        <PillTag tone="neu" size="sm" icon={FileText}>
          report only
        </PillTag>
      }
    >
      <div className="flex max-w-[768px] flex-col gap-[20px]">
        <ReportBody study={s} />
        <Alert tone="info" title="Images for this study are not in this demo">
          The report is on the record; no openly licensed image fits this study, so none is shown in its place.
        </Alert>
        <RecordDoors patient={p} />
      </div>
    </ScreenFrame>
  )
}

interface Turn {
  q: string
  answer: AssistantAnswer
}

function Viewer({ record, study }: { record: ImagingStudy; study: NcctStudy }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const dispositions = useAI((s) => s.dispositions)
  const saveVoiceNote = useClinical((s) => s.saveVoiceNote)
  const voiceNotes = useClinical((s) => s.voiceNotes)

  const studyId = record.id
  const c = maybeStrokeCase(study.strokeCaseId)
  const p = patient(record.patientId)
  const findings = useMemo(() => ncctFindings(study.truth, c), [study, c])
  const verdict = triageVerdict(study.truth, c)
  const overlays = useMemo(() => overlaysFor(study.key, c), [study, c])
  const deliveredAt = c?.imaging.deliveredAt ?? new Date(record.acquiredAt.getTime() + 4 * 60000)
  const model = c?.imaging.lvo ? IMAGING_TRIAGE.model : NCCT_MODEL
  const band = forced === 'AI-LOW' ? ('LOW' as const) : ('HIGH' as const)

  const [sideBySide, setSideBySide] = useState(false)
  // One slice for both panes, so the original and the marked image are always the same cut.
  const firstMark = overlays[0]
  const [slice, setSlice] = useState(firstMark ? Math.round((firstMark.from + firstMark.to) / 2) : Math.max(1, Math.round(study.slices / 2)))
  const [escalate, setEscalate] = useState(false)
  const [note, setNote] = useState('')
  const [noteMeta, setNoteMeta] = useState<{ model: string; band: string } | null>(null)
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])

  const criticalFinding = criticalFindingFor(findings, c)
  const touchpointId = `imaging:${studyId}:report`
  const decision = dispositions[touchpointId]
  const attested = decision?.disposition === 'Accepted' || decision?.disposition === 'Accepted with edits'
  /** Only this study's reading notes — a patient with two scans keeps them apart. */
  const savedNotes = (voiceNotes[p.id] ?? []).filter((n) => n.body.startsWith(`${studyId} ·`))
  const worklist = '/radiology/worklist'
  const consoleTo = c ? `/stroke/ai-console?case=${c.id}` : undefined

  function ask(q: string) {
    const text = q.trim()
    if (text.length < 3) return
    const answer = resolveAnswer(text, { screenId: 'S-15-04', patientId: p.id, patientScoped: true })
    setTurns((t) => [...t, { q: text, answer }])
    setQuestion('')
  }

  function saveNote() {
    const body = note.trim()
    if (!body) return
    saveVoiceNote({ patientId: p.id, body: `${studyId} · ${body}`, by: me.name, model: noteMeta?.model ?? 'typed', band: noteMeta?.band ?? 'HIGH' })
    audit({ event: 'IMAGING.NOTE_SAVED', actor: me.name, actorId: me.id, subject: p.id, detail: `${studyId} · ${noteMeta ? 'dictated' : 'typed'} · draft` })
    toast({ tone: 'success', title: 'Reading note saved', detail: `${p.name} · ${studyId} · draft, not part of the report until you sign one.` })
    setNote('')
    setNoteMeta(null)
  }

  return (
    <>
      <ScreenFrame
        screenId="S-15-04"
        patient={p}
        sub={`${studyId} · ${record.description} · ${study.slices} of ${study.seriesTotal} slices · acquired ${formatDateTime(record.acquiredAt)}`}
        chips={
          <>
            <PillTag tone="neu" size="sm" icon={ScanLine}>
              brain window W {NCCT_WINDOW.width} / L {NCCT_WINDOW.level}
            </PillTag>
            {attested && (
              <PillTag tone="norm" size="sm" icon={Check}>
                Attested
              </PillTag>
            )}
            {decision?.disposition === 'Rejected' && (
              <PillTag tone="warn" size="sm" icon={X}>
                AI read rejected
              </PillTag>
            )}
          </>
        }
        actions={
          <>
            {may(worklist) && (
              <Pill variant="card" size="xl" icon={List} iconSize={17} onClick={() => navigate(worklist)}>
                Worklist
              </Pill>
            )}
            <Pill variant="card" size="xl" icon={Columns2} iconSize={17} aria-pressed={sideBySide} onClick={() => setSideBySide((v) => !v)}>
              {sideBySide ? 'Single view' : 'Original beside overlay'}
            </Pill>
            {consoleTo && may(consoleTo) && (
              <Pill variant="primary" size="xl" icon={Brain} iconSize={17} onClick={() => navigate(consoleTo)}>
                Stroke-AI console
              </Pill>
            )}
          </>
        }
        rail={
          <div className="flex flex-col gap-[16px]">
            <Card titleSize="sm" title="Study">
              <dl className="divide-y divide-(--line)">
                <KeyValue label="Acquired">
                  <span className="tabular-nums">{formatDateTime(record.acquiredAt)}</span>
                </KeyValue>
                <KeyValue label="Series">
                  {study.seriesDescription} · {study.sliceThickness} mm · {study.kvp} kVp
                </KeyValue>
                <KeyValue label="Matrix">
                  <span className="tabular-nums">
                    {study.rows} × {study.columns}
                  </span>
                </KeyValue>
                <KeyValue label="Case">{c ? c.caseNo : 'Not a stroke case'}</KeyValue>
                <KeyValue label="Report">{record.status}</KeyValue>
                <KeyValue label="Source">
                  <span className="tabular-nums">{study.sourcePatientId}</span> · de-identified
                </KeyValue>
              </dl>
            </Card>
            <Why label="Why this viewer works this way">
              <p>The unmarked image is always one click away — an overlay you cannot remove is an overlay you switch off for good.</p>
              <p className="mt-[8px]">The model marks a region and names itself on the frame. It never writes a diagnosis on the image, and nothing it reports enters the record until a named clinician attests to it.</p>
              <p className="mt-[8px] text-sh-text-3">
                The reading room defaults to the night theme — {me.name} reads on a diagnostic workstation, and large white fields in a darkened room cost contrast sensitivity.
              </p>
            </Why>
            <RecordDoors patient={p} exclude={['imaging']} label={null} />
          </div>
        }
        railTitle="Study"
      >
        {/* The one operative alert: a critical finding that needs a person told — until the read has been decided. */}
        {aiActive && criticalFinding && !decision && (
          <Alert
            tone="warn"
            role="alert"
            title={`${criticalFinding.label} — ${criticalFinding.value}`}
            action={
              <Pill variant="tone" tone="crit" size="md" icon={PhoneCall} onClick={() => setEscalate(true)}>
                Escalate
              </Pill>
            }
          >
            Flagged as a finding that needs a named clinician told, not left in a report queue. The escalation reaches a person, and it records who.
          </Alert>
        )}

        <div className="grid grid-cols-1 gap-[20px] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:items-start">
          {/* The image — real pixels, the same viewer the stroke console uses. */}
          <div className="flex min-w-0 flex-col gap-[16px]">
            <div className={cn('grid grid-cols-1 gap-[12px]', sideBySide && 'md:grid-cols-2')}>
              {sideBySide && (
                <div className="min-w-0">
                  <p className="mb-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Original</p>
                  <NcctViewer study={study} overlays={[]} slice={slice} onSlice={setSlice} compact />
                </div>
              )}
              <div className="min-w-0">
                {sideBySide && (
                  <p className="mb-[6px] flex items-center gap-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">
                    <Diamond /> With overlay
                  </p>
                )}
                <NcctViewer study={study} overlays={aiActive ? overlays : []} slice={slice} onSlice={setSlice} compact={sideBySide} />
              </div>
            </div>

            {/* The reading note: spoken first, saved with the study. */}
            <Card>
              <VoiceField
                id={`imaging-note-${studyId}`}
                label="Reading note"
                rows={4}
                value={note}
                onChange={setNote}
                onDictated={(meta) => setNoteMeta({ model: meta.model, band: meta.band ?? 'HIGH' })}
                placeholder="What you see, and what you want the team to know…"
                typedPlaceholder="What you see, and what you want the team to know…"
                hint="Saved as a draft against the study. It becomes part of the record only when the report is signed."
              />
              <div className="mt-[12px] flex flex-wrap items-center gap-x-[8px] gap-y-[10px]">
                <Pill variant="primary" size="lg" icon={Save} disabled={note.trim() === ''} className="disabled:opacity-40" onClick={saveNote}>
                  Save note
                </Pill>
                {note.trim() !== '' && (
                  <Pill variant="ghost" size="lg" icon={X} onClick={() => setNote('')}>
                    Discard
                  </Pill>
                )}
                {savedNotes.length > 0 && (
                  <span className="ml-auto text-[12px] tabular-nums text-sh-text-2">
                    {savedNotes.length} saved {savedNotes.length === 1 ? 'note' : 'notes'} · latest {formatTime(new Date(savedNotes[savedNotes.length - 1].at))}
                  </span>
                )}
              </div>
              {savedNotes.length > 0 && (
                <ul className="mt-[12px] divide-y divide-(--line)">
                  {savedNotes
                    .slice(-3)
                    .reverse()
                    .map((n) => (
                      <li key={n.id} className="py-[8px] text-[14px]">
                        <p className="text-sh-text">{n.body}</p>
                        <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-2">
                          {n.by} · {formatTime(new Date(n.at))} · {n.model === 'typed' ? 'typed' : 'dictated'}
                        </p>
                      </li>
                    ))}
                </ul>
              )}
            </Card>
          </div>

          {/* The read, the report, and the questions. */}
          <div className="flex min-w-0 flex-col gap-[16px]">
            {aiActive ? (
              <Card
                titleSize="sm"
                title={
                  <span className="inline-flex items-center gap-[8px]">
                    <Diamond /> AI read
                  </span>
                }
                right={<span className="text-[12px] tabular-nums text-sh-text-2">delivered {formatTime(deliveredAt)}</span>}
              >
                <p className={cn('font-semibold', verdict.tone === 'critical' ? 'text-sh-crit-fg' : verdict.tone === 'caution' ? 'text-sh-warn-fg' : 'text-sh-norm-fg')}>{verdict.headline}</p>
                <p className="mt-[4px] text-[14px] text-sh-text-2">{verdict.detail}</p>
                <dl className="mt-[12px] divide-y divide-(--line)">
                  {findings.map((f) => (
                    <div key={f.label} className="flex min-h-[44px] flex-wrap items-center justify-between gap-[8px] py-[10px]">
                      <dt className="min-w-0">
                        <span className={cn('text-[14px] text-sh-text', f.critical && 'font-semibold text-sh-warn-fg')}>{f.label}</span>
                        <span className="block text-[12px] text-sh-text-2">{f.gloss}</span>
                      </dt>
                      <dd className="flex items-center gap-[8px]">
                        <span className={cn('font-semibold tabular-nums text-sh-text', f.reassuring && 'text-sh-norm-fg', f.critical && 'text-sh-crit-fg')}>{f.value}</span>
                        <ConfidenceMark band={f.band} score={f.confidence} />
                      </dd>
                    </div>
                  ))}
                </dl>
                <AIActionBar
                  className="mt-[12px]"
                  touchpointId={touchpointId}
                  capabilityId="AI-404"
                  gate="G3"
                  band={band}
                  score={band === 'LOW' ? undefined : 0.94}
                  subject={p.id}
                  explain={{
                    touchpointId,
                    capabilityId: 'AI-404',
                    claim: verdict.detail,
                    confidence: 0.94,
                    band,
                    computedAt: formatTime(deliveredAt),
                    inputs: [
                      { label: `Study ${studyId}, ${study.slices} slices`, source: `Acquired ${formatDateTime(record.acquiredAt)}` },
                      { label: 'Ground-truth labels of the imported series', source: study.sourcePatientId },
                      ...(c ? [{ label: 'Case clock and last known well', source: 'S-18-06 · M-18.10' }] : []),
                    ],
                    evidence: findings.map((f) => `${f.label}: ${f.value} — ${f.gloss}`),
                    model,
                    limits: IMAGING_TRIAGE.limits,
                  }}
                />
                {attested && <p className="mt-[10px] rounded-[12px] bg-sh-norm-bg px-[12px] py-[8px] text-[13px] font-medium text-sh-norm-fg">Attested by {decision.by}. It is now part of the report.</p>}
                {decision?.disposition === 'Rejected' && (
                  <p className="mt-[10px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[13px] font-medium text-sh-warn-fg">
                    Rejected by {decision.by}{decision.reason ? ` — ${decision.reason}` : ''}. The read does not enter the report.
                  </p>
                )}
              </Card>
            ) : (
              <Card titleSize="sm" title="AI read">
                <p className="font-semibold text-sh-text">No automated read</p>
                <p className="mt-[6px] text-[14px] text-sh-text-2">The AI is off, so this study sits in the standard reporting queue in arrival order. You lose the prioritisation, not the study.</p>
              </Card>
            )}

            {/* The full report — a document, folded. A stroke case gets the stroke report; any other CT, the radiology report. */}
            {c ? (
              <Card titleSize="sm" title="Clinical report" right={<span className="text-[12px] text-sh-text-2">{c.caseNo}</span>}>
                <Disclosure label="the full report">
                  <StrokeAIReport strokeCase={c} study={study} />
                </Disclosure>
              </Card>
            ) : (
              <Card titleSize="sm" title="Radiology report" right={<span className="text-[12px] text-sh-text-2">{record.status}</span>}>
                <p className="text-[14px]/[1.55] text-sh-text">{record.impression}</p>
                {record.findings && (
                  <ul className="mt-[8px] flex flex-col gap-[4px] text-[14px] text-sh-text-2">
                    {record.findings.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-[8px] text-[12px] tabular-nums text-sh-text-2">{record.reportedBy ?? 'Awaiting radiologist'}</p>
              </Card>
            )}

            {/* Questions about THIS scan, answered with their citations. */}
            {aiActive && (
              <Card
                titleSize="sm"
                title={
                  <span className="inline-flex items-center gap-[8px]">
                    <Diamond /> Ask about this scan
                  </span>
                }
              >
                <ul className="flex flex-wrap gap-x-[8px] gap-y-[10px]">
                  {promptsFor('S-15-04').map((q) => (
                    <li key={q}>
                      <Pill variant="control" size="md" icon={MessageSquare} onClick={() => ask(q)}>
                        {q}
                      </Pill>
                    </li>
                  ))}
                </ul>
                {turns.length > 0 && (
                  <ol aria-label="Answers" className="mt-[12px] flex flex-col gap-[12px]">
                    {turns.map((t, i) => (
                      <li key={`${i}-${t.q}`} className="flex flex-col gap-[6px]">
                        <p className="self-end rounded-[14px] bg-sh-primary px-[12px] py-[8px] text-[13px] text-sh-on-primary">{t.q}</p>
                        <div className="rounded-[14px] bg-sh-inner px-[12px] py-[10px] text-[13px] text-sh-text">
                          <p>{t.answer.body}</p>
                          {t.answer.routedTo && (
                            <p className="mt-[6px] text-[12px] text-sh-text-2">
                              Routed to {t.answer.routedTo.name} ({t.answer.routedTo.capability}, {t.answer.routedTo.gate}) — {t.answer.routedTo.where}
                            </p>
                          )}
                          {t.answer.citations.length > 0 && (
                            <ul className="mt-[8px] flex flex-wrap gap-[6px]">
                              {t.answer.citations.map((ci) => {
                                const to = citationLink(ci)
                                return (
                                  <li key={ci.n}>
                                    {to && may(to) ? (
                                      <button type="button" onClick={() => navigate(to)} className="inline-flex min-h-[32px] items-center rounded-full bg-sh-card px-[10px] text-[12px] font-medium text-sh-text hover:bg-sh-hover">
                                        [{ci.n}] {ci.label}
                                      </button>
                                    ) : (
                                      <span className="inline-flex min-h-[32px] items-center rounded-full bg-sh-card px-[10px] text-[12px] text-sh-text-2" title={ci.source}>
                                        [{ci.n}] {ci.label}
                                      </span>
                                    )}
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                <form
                  className="mt-[12px] flex gap-[8px]"
                  onSubmit={(e) => {
                    e.preventDefault()
                    ask(question)
                  }}
                >
                  <TextInput value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={`Ask about ${p.name.split(' ')[0]}’s scan…`} aria-label="Ask the assistant about this scan" />
                  <Pill type="submit" variant="accent" size="lg" icon={Send} disabled={question.trim().length < 3} className="disabled:opacity-40">
                    Ask
                  </Pill>
                </form>
                <p className="mt-[8px] text-[12px] text-sh-text-2">Answers come from cited documentation. A clinical question is routed to the capability that owns it — the assistant never reads the scan for you.</p>
              </Card>
            )}
          </div>
        </div>
      </ScreenFrame>

      {/* S-15-06, the modal it is specified to be. */}
      <EscalateDialog open={escalate} patientId={p.id} finding={criticalFinding ? `${criticalFinding.label} — ${criticalFinding.value}` : ''} studyId={studyId} onClose={() => setEscalate(false)} />
    </>
  )
}

