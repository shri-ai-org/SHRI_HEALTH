/**
 * After the call: what happened (how long, how much was written down), the
 * three things a doctor downloads — the video recording, the conversation, the
 * full visit record — with the other formats one click away, and the check
 * against Google Meet's own notes of the call (fetched from Google, or the file
 * uploaded), shown as Both heard / Only Google Meet / Only Shri.
 */

import { CheckCircle2, ChevronDown, PhoneOff, CloudDownload, Download, ExternalLink, FileText, Film, Loader, MessagesSquare, RefreshCw, Trash2, Upload, type LucideIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { Card, Icon, Pill } from '../ui/primitives'

import { fetchOfficialTranscript, googleConfigured } from './meet'
import { recordingBlob, removeRecording } from './recordingStore'
import {
  clockOf,
  fileStem,
  fullRecordText,
  liveTranscriptText,
  liveTranscriptVtt,
  parseOfficialFile,
  reconcile,
  reconciledText,
  saveFile,
  type RecordHeader,
} from './reconcile'
import { useTele, type RecordingInfo } from './teleStore'
import type { MatchStatus, OfficialEntry } from './teleTypes'

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`
const ext = (mime: string) => (mime.includes('mp4') ? 'mp4' : 'webm')
const minutes = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} sec` : `${Math.floor(s / 60)} min ${s % 60} sec`
}

function Tile({ icon, title, detail, onClick, disabled, busy }: { icon: LucideIcon; title: string; detail: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className="group flex items-center gap-[14px] rounded-[18px] border border-sh-line bg-sh-card p-[16px] text-left transition-colors hover:border-sh-line-strong hover:bg-sh-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex size-[44px] shrink-0 items-center justify-center rounded-[14px] bg-sh-accent-soft text-sh-accent-ink">
        <Icon icon={busy ? Loader : icon} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className="block text-[13px] text-sh-text-3">{detail}</span>
      </span>
      {!disabled && <Icon icon={Download} size={18} className="text-sh-text-3 group-hover:text-sh-text" />}
    </button>
  )
}

const MATCH: Record<MatchStatus, { word: string; cls: string }> = {
  matched: { word: 'Both heard', cls: 'bg-sh-norm-bg text-sh-norm-fg' },
  'official-only': { word: 'Only Google Meet', cls: 'bg-sh-pend-bg text-sh-pend-fg' },
  'live-only': { word: 'Only Shri', cls: 'bg-sh-warn-bg text-sh-warn-fg' },
}

function Compare({ sid, header }: { sid: string; header: RecordHeader }) {
  const toast = useUI((s) => s.toast)
  const rec = useTele((s) => s.sessions[sid])
  const setOfficial = useTele((s) => s.setOfficial)
  const file = useRef<HTMLInputElement>(null)
  const [fetching, setFetching] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [filter, setFilter] = useState<MatchStatus | 'all'>('all')
  if (!rec) return null
  const official = rec.official
  const canFetch = googleConfigured() && Boolean(rec.meetCode)

  function apply(source: 'meet-api' | 'upload', entries: OfficialEntry[], links: { docUrl?: string; recordingUrl?: string } = {}) {
    setOfficial(sid, { source, entries, reconciled: reconcile(rec.segments, entries), ...links })
    setPending(null)
    toast({ tone: 'success', title: 'Compared with Google Meet', detail: `${entries.length} lines from Google Meet, ${rec.segments.length} from Shri.` })
  }

  async function fetchIt() {
    setFetching(true)
    setPending(null)
    try {
      const r = await fetchOfficialTranscript(rec.meetCode!, rec.startedAt)
      if (r.entries.length) apply('meet-api', r.entries, { docUrl: r.docUrl, recordingUrl: r.recordingUrl })
      else setPending(r.pending ?? 'Google Meet has no notes for this call yet.')
    } catch (e) {
      toast({ tone: 'caution', title: 'Could not get Google Meet’s notes', detail: (e as Error).message })
    } finally {
      setFetching(false)
    }
  }

  async function upload(f: File) {
    try {
      const entries = parseOfficialFile(f.name, await f.text(), rec.startedAt)
      if (!entries.length) throw new Error('No lines of conversation were found in it. In Google Docs choose File → Download → Plain text (.txt).')
      apply('upload', entries)
    } catch (e) {
      toast({ tone: 'caution', title: `Could not read ${f.name}`, detail: (e as Error).message })
    }
  }

  const counts = { matched: 0, 'official-only': 0, 'live-only': 0 }
  official?.reconciled.forEach((r) => (counts[r.status] += 1))
  const rows = official?.reconciled.filter((r) => filter === 'all' || r.status === filter) ?? []
  const stem = fileStem(header.patient, rec.startedAt)

  return (
    <Card titleSize="sm" title="Check against Google Meet’s notes">
      {!official && (
        <div className="flex max-w-[640px] flex-col gap-[8px] text-[14px] text-sh-text-2">
          <p>
            Paid Google Workspace accounts get Google Meet’s own written notes of the call (a transcript) in Google Drive, a few minutes after the call. Bring them here to
            check nothing was missed: Google names who spoke, and Shri understands Tamil.
          </p>
          <p className="rounded-[12px] bg-sh-inner px-[12px] py-[8px] text-[13px]">
            <span className="font-semibold text-sh-text">On a free Google account</span> Google Meet does not save notes. Nothing is missing: the live transcript above is the
            full conversation — use <span className="font-medium">Download as text</span>.
          </p>
        </div>
      )}
      {pending && <p className="mt-[10px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[13px] text-sh-warn-fg">{pending}</p>}

      {official && (
        <>
          <div className="flex flex-wrap items-center gap-[8px]" role="group" aria-label="Show">
            {(['all', 'matched', 'official-only', 'live-only'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
                className={cn(
                  'h-[32px] rounded-full px-[12px] text-[13px] font-medium transition-colors',
                  filter === k ? 'bg-sh-primary text-sh-on-primary' : k === 'all' ? 'bg-sh-control text-sh-text' : MATCH[k].cls,
                )}
              >
                {k === 'all' ? `All ${official.reconciled.length}` : `${MATCH[k].word} ${counts[k]}`}
              </button>
            ))}
            {official.docUrl && (
              <a className="ml-auto inline-flex items-center gap-[4px] text-[13px] text-sh-accent-ink underline" href={official.docUrl} target="_blank" rel="noreferrer">
                Google’s notes <ExternalLink size={12} />
              </a>
            )}
            {official.recordingUrl && (
              <a className="inline-flex items-center gap-[4px] text-[13px] text-sh-accent-ink underline" href={official.recordingUrl} target="_blank" rel="noreferrer">
                Google’s recording <ExternalLink size={12} />
              </a>
            )}
          </div>
          <ol aria-label="Compared conversation" className="mt-[12px] flex max-h-[420px] flex-col divide-y divide-sh-line overflow-y-auto rounded-[16px] border border-sh-line">
            {rows.map((r, i) => (
              <li key={i} className="flex gap-[12px] px-[14px] py-[10px]" data-status={r.status}>
                <span className="w-[44px] shrink-0 pt-[2px] text-[12px] tabular-nums text-sh-text-3">{r.startMs ? clockOf(r.startMs).slice(0, 5) : ''}</span>
                <span className="min-w-0 flex-1 text-[14px] leading-[1.5]">
                  <span className="font-semibold">{r.speaker}</span> {r.text}
                  {r.status === 'matched' && (r.score ?? 1) < 0.6 && r.live.length > 0 && (
                    <span className="block text-[13px] text-sh-text-3">Shri heard: {r.live.map((l) => l.text).join(' ')}</span>
                  )}
                </span>
                <span className={cn('h-fit shrink-0 rounded-full px-[8px] py-[2px] text-[11px] font-medium', MATCH[r.status].cls)}>{MATCH[r.status].word}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="mt-[14px] flex flex-wrap gap-[8px]">
        {canFetch && (
          <Pill variant="primary" size="lg" icon={fetching ? Loader : official ? RefreshCw : CloudDownload} disabled={fetching} onClick={() => void fetchIt()}>
            {fetching ? 'Getting them…' : official ? 'Get them again' : 'Get notes from Google Meet'}
          </Pill>
        )}
        <Pill variant={canFetch ? 'control' : 'primary'} size="lg" icon={Upload} onClick={() => file.current?.click()}>
          {canFetch ? 'Or upload the file' : 'Upload Google Meet notes'}
        </Pill>
        <input
          ref={file}
          type="file"
          accept=".txt,.vtt,.srt,.sbv,.json,text/plain,text/vtt,application/json"
          className="hidden"
          aria-label="Google Meet notes file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void upload(f)
          }}
        />
        {official && (
          <Pill variant="control" size="lg" icon={Download} onClick={() => saveFile(`${stem}-checked.txt`, reconciledText(header, official.reconciled))}>
            Download the check
          </Pill>
        )}
      </div>
    </Card>
  )
}

export function AfterVisit({
  sid,
  header,
  note,
  firstName,
  done,
  onDone,
  onReopen,
  onNewCall,
}: {
  sid: string
  header: RecordHeader
  note: string
  firstName: string
  done: boolean
  onDone: () => void
  onReopen: () => void
  onNewCall: () => void
}) {
  const toast = useUI((s) => s.toast)
  const rec = useTele((s) => s.sessions[sid])
  const setRecording = useTele((s) => s.setRecording)
  const [busy, setBusy] = useState<string | null>(null)
  if (!rec) return null
  const segs = rec.segments
  const all = rec.recordings ?? []
  const videos = all.filter((r) => !r.removed)
  /** A part's own lines: from its start to the next part's. */
  const linesOf = (v: RecordingInfo) => {
    const next = all.find((x) => x.startedAt > v.startedAt)?.startedAt ?? Infinity
    return segs.filter((l) => l.startMs >= v.startedAt - 2000 && l.startMs < next)
  }
  const partName = (i: number) => (videos.length > 1 ? `-part-${i + 1}` : '')
  const stem = fileStem(header.patient, rec.startedAt)
  const lasted = (rec.endedAt ?? rec.segments.at(-1)?.endMs ?? rec.startedAt) - rec.startedAt

  async function downloadVideo(v: RecordingInfo, i: number) {
    setBusy(v.key)
    try {
      const blob = await recordingBlob(v.key, v.mime)
      if (!blob) throw new Error('Nothing was recorded on this computer.')
      saveFile(`${stem}${partName(i)}.${ext(v.mime)}`, blob)
    } catch (e) {
      toast({ tone: 'caution', title: 'Could not download the recording', detail: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-[16px]">
      <Card className="p-[24px]">
        <div className="flex flex-wrap items-center gap-[14px]">
          <span className={cn('flex size-[48px] items-center justify-center rounded-full', done ? 'bg-sh-norm-bg text-sh-norm-fg' : 'bg-sh-inner text-sh-text-2')}>
            <Icon icon={done ? CheckCircle2 : PhoneOff} size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[20px] font-semibold">{done ? `Visit with ${firstName} done` : `Call with ${firstName} ended`}</h2>
            <p className="text-[14px] text-sh-text-3" data-visit-summary>
              {new Date(rec.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at {clockOf(rec.startedAt).slice(0, 5)} · {minutes(lasted)} ·{' '}
              {rec.consent === 'given' ? `${segs.length} lines of conversation saved` : 'not recorded — the patient said no'}
            </p>
          </div>
          <Pill variant="control" size="lg" onClick={onNewCall}>
            Start a new call
          </Pill>
        </div>

        {done ? (
          <p className="mt-[16px] flex flex-wrap items-center gap-[10px] rounded-[14px] bg-sh-norm-bg px-[14px] py-[10px] text-[14px] text-sh-norm-fg">
            <Icon icon={CheckCircle2} size={16} />
            Marked done. It shows as Done on Video visits.
            <button type="button" className="ml-auto text-[13px] underline" onClick={onReopen}>
              Reopen
            </button>
          </p>
        ) : (
          <div className="mt-[16px] flex flex-wrap items-center gap-[12px] rounded-[14px] border border-sh-line bg-sh-inner px-[14px] py-[12px]">
            <span className="min-w-[200px] flex-1 text-[14px] text-sh-text-2">Finished your notes? Mark the visit done so it leaves the waiting list.</span>
            <Pill variant="primary" size="lg" icon={CheckCircle2} onClick={onDone}>
              Mark visit as done
            </Pill>
          </div>
        )}

        <h3 className="mt-[24px] text-[15px] font-semibold">Download</h3>
        <div className="mt-[10px] grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-[10px]">
          {videos.length ? (
            videos.map((v, i) => (
              <Tile
                key={v.key}
                icon={Film}
                title={videos.length > 1 ? `Video recording ${i + 1} of ${videos.length}` : 'Video recording'}
                detail={`${v.video ? 'Picture and sound' : 'Sound only'} · ${mb(v.bytes)}`}
                busy={busy === v.key}
                onClick={() => void downloadVideo(v, i)}
              />
            ))
          ) : (
            <Tile icon={Film} title="Video recording" detail={all.length ? 'Deleted from this computer' : 'This call was not recorded'} disabled onClick={() => undefined} />
          )}
          <Tile
            icon={MessagesSquare}
            title="Conversation"
            detail={segs.length ? 'Everything said, as text' : 'Nothing was written down'}
            disabled={!segs.length}
            onClick={() => saveFile(`${stem}-conversation.txt`, liveTranscriptText(header, segs))}
          />
          <Tile
            icon={FileText}
            title="Full visit record"
            detail="Your notes and the conversation, one file"
            onClick={() => saveFile(`${stem}-full-record.txt`, fullRecordText(header, note, segs, rec.official?.reconciled))}
          />
        </div>

        <details className="group mt-[12px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-[4px] text-[13px] text-sh-text-3 hover:text-sh-text">
            Other formats <Icon icon={ChevronDown} size={13} className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
            <Pill variant="control" size="md" disabled={!segs.length} onClick={() => saveFile(`${stem}-conversation.json`, JSON.stringify({ ...header, segments: segs }, null, 2), 'application/json')}>
              Conversation (JSON)
            </Pill>
            {videos.map((v, i) => (
              <Pill key={v.key} variant="control" size="md" disabled={!linesOf(v).length} onClick={() => saveFile(`${stem}${partName(i)}.vtt`, liveTranscriptVtt(linesOf(v), v.startedAt), 'text/vtt')}>
                Subtitles for video{videos.length > 1 ? ` ${i + 1}` : ''} (.vtt)
              </Pill>
            ))}
            {videos.length > 0 && (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-[6px] text-[13px] text-sh-text-3 hover:text-sh-crit-fg"
                onClick={() => {
                  if (!window.confirm('Delete the video from this computer? Download it first if you need it.')) return
                  for (const v of videos) void removeRecording(v.key).then(() => setRecording(sid, { ...v, removed: true }))
                }}
              >
                <Icon icon={Trash2} size={13} />
                Delete video from this computer
              </button>
            )}
          </div>
        </details>
        {videos.length > 0 && <p className="mt-[12px] text-[13px] text-sh-text-3">The video is kept on this computer only. Download it to keep it safe.</p>}
      </Card>

      {rec.consent === 'given' && <Compare sid={sid} header={header} />}
    </div>
  )
}
