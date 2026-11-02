/**
 * S-06-04 · Ambient scribe — the overlay on S-06-03 and S-08-04
 * (`src/screens/m06/S0604.tsx`): the scribe listening while the consultation
 * happens, and the screen that answers "where did that note come from?".
 *
 * It LISTENS FOR REAL. Opening it raises the browser's microphone prompt, and
 * every line of the transcript is one the browser's recogniser heard. Pause
 * and Resume close and reopen the microphone and keep what was heard; the
 * clock counts only time spent listening. Where the browser cannot listen it
 * says so in one line and "Use this draft" stays off. Two guardrails are on
 * the surface: AI-101 keeps the raw transcript verbatim (one toggle away), and
 * AI-104's cleanup is a capital and a full stop per sentence. Lines sit under
 * the section they will feed. "Use this draft" hands back, per section, the
 * sentences routed to it; sections the clinician already wrote are left alone.
 */

import { Check, Globe, Info, Mic, MicOff, Pause, Play, RotateCcw, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { NoteSectionSeed } from '@/data/clinical'
import { formatClock } from '@/data/format'
import { LANGUAGES } from '@/data/kit'
import { SCRIBE_SECTION_KEYS, draftFromTranscript, routeSentence, splitSentences, tidySentence, useScribeDrafts, type ScribeSections } from '@/data/scribe'
import { useAI } from '@/store/ai'
import { useClinical } from '@/store/clinical'
import { useSession } from '@/store/session'

import { cn } from '../lib/cn'
import { useDictation } from '../logic/dictation'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { ConfidenceMark, Icon, Pill, PillTag, Toggle } from '../ui/primitives'

type SectionKey = NoteSectionSeed['key']

const SECTION_LABELS: Record<SectionKey, string> = { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' }

interface HeardLine {
  key: string
  atSec: number
  raw: string
  cleaned: string
  feeds: SectionKey
}

export function AmbientScribe({
  open,
  onClose,
  onFinish,
  patientId,
  patientName,
  sections,
}: {
  open: boolean
  onClose: () => void
  /** Hands back the keys it drafted and, for each, the text it heard. The text is also written to the note that aimed the scribe. */
  onFinish: (keys: SectionKey[], drafts: ScribeSections) => void
  patientId: string
  patientName: string
  /** The note's sections, for their labels. */
  sections: NoteSectionSeed[]
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={760}
      icon={Sparkles}
      title="Ambient scribe"
      subtitle={`${patientName} · the raw transcript is retained verbatim`}
    >
      <Session onClose={onClose} onFinish={onFinish} patientId={patientId} sections={sections} />
    </Dialog>
  )
}

/** Mounted only while the overlay is open, so closing it closes the microphone. */
function Session({ onClose, onFinish, patientId, sections }: { onClose: () => void; onFinish: (keys: SectionKey[], drafts: ScribeSections) => void; patientId: string; sections: NoteSectionSeed[] }) {
  const language = useSession((s) => s.language)
  const clearDisposition = useAI((s) => s.clearDisposition)
  const d = useDictation({ arbiterId: 'ambient-scribe' })
  const [showRaw, setShowRaw] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const { start } = d

  // Listening begins when the overlay opens — asking for the scribe is asking for the microphone.
  useEffect(() => {
    start()
  }, [start])

  /** Every settled phrase, split into sentences, each under the section it will feed. */
  const lines = useMemo<HeardLine[]>(
    () =>
      d.segments.flatMap((seg, i) =>
        splitSentences(seg.text).map((raw, j) => ({ key: `${i}-${j}`, atSec: seg.atSec, raw, cleaned: tidySentence(raw), feeds: routeSentence(raw) })),
      ),
    [d.segments],
  )

  // What has been heard so far, one recognised phrase per line — the words in flight included.
  const transcript = [...d.segments.map((s) => s.text), d.interim.trim()].filter(Boolean).join('\n')
  const drafts = useMemo(() => draftFromTranscript(transcript), [transcript])
  const drafted = SCRIBE_SECTION_KEYS.filter((k) => drafts[k] !== undefined)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [lines.length])

  const labelFor = (key: SectionKey) => sections.find((s) => s.key === key)?.label ?? SECTION_LABELS[key]
  const recording = d.phase === 'recording'
  const requesting = d.phase === 'requesting'
  const unavailable = d.phase === 'unavailable'
  const cannotListen = d.supportNotice !== null

  function adoptDraft() {
    if (drafted.length === 0) return
    d.stop()
    const encounterId = useScribeDrafts.getState().publish({
      patientId,
      sections: drafts,
      transcript,
      model: d.model,
      band: d.band,
      confidence: d.confidence,
      scored: d.scored,
      at: new Date().toISOString(),
    })
    if (encounterId) {
      // A new draft for a section that is still empty needs a new decision, not the last one.
      const note = useClinical.getState().note(encounterId)
      for (const k of drafted) if ((note.text[k] ?? '').trim() === '') clearDisposition(`${encounterId}:${k}`)
    }
    onFinish(drafted, drafts)
  }

  const status = recording ? 'Listening' : requesting ? 'Waiting for the microphone' : unavailable ? 'Not listening' : d.phase === 'review' ? 'Paused' : 'Starting'

  return (
    <div className="flex flex-col gap-[16px]">
      {/* The recording state, plainly. */}
      <div className={cn('flex flex-wrap items-center gap-[12px] rounded-[16px] bg-sh-inner px-[16px] py-[12px]', recording && 'inset-ring-2 inset-ring-sh-accent')}>
        <span
          className={cn(
            'inline-flex size-[36px] shrink-0 items-center justify-center rounded-full',
            recording ? 'bg-sh-crit-bg text-sh-crit-fg' : unavailable ? 'bg-sh-warn-bg text-sh-warn-fg' : d.phase === 'review' ? 'bg-sh-card text-sh-text-2' : 'bg-sh-accent text-sh-accent-ink',
          )}
          aria-hidden="true"
        >
          <Icon icon={unavailable ? MicOff : d.phase === 'review' ? Pause : Mic} size={17} />
        </span>
        <div className="min-w-0 flex-1 basis-[200px]">
          <p className="text-[14px] font-medium text-sh-text">
            {status}
            <span className="ml-[8px] tabular-nums text-sh-text-3">{formatClock(d.elapsedSec)}</span>
          </p>
          {requesting ? (
            <p role="status" className="text-[13px] text-sh-text-2">
              Allow microphone access in your browser’s prompt…
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-x-[8px] text-[13px] tabular-nums text-sh-text-3">
              {drafted.length} of {SCRIBE_SECTION_KEYS.length} sections drafted
              {drafted.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <ConfidenceMark band={d.band} score={d.scored ? d.confidence : undefined} />
                </>
              )}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-[8px]">
          <PillTag tone="neu" size="sm" icon={Globe}>
            {LANGUAGES.find((l) => l.code === language)?.label}
          </PillTag>
          {recording && (
            <Pill variant="control" size="md" icon={Pause} onClick={d.stop}>
              Pause
            </Pill>
          )}
          {(d.phase === 'review' || (unavailable && !cannotListen)) && (
            <Pill variant="control" size="md" icon={unavailable ? RotateCcw : Play} onClick={() => d.start({ resume: true })}>
              {unavailable ? 'Try again' : 'Resume'}
            </Pill>
          )}
        </div>
      </div>

      {d.notice && (
        <p role="status" className="flex items-start gap-[8px] rounded-[14px] bg-sh-warn-bg px-[12px] py-[10px] text-[13px] text-sh-warn-fg">
          <Icon icon={MicOff} size={14} className="mt-[2px] shrink-0" />
          {d.notice}
        </p>
      )}

      {/* The transcript, grouped under the section each run of lines feeds. AI-104 cleans it; the raw capture stays available. */}
      <div>
        <div className="mb-[8px] flex items-center justify-between gap-[8px]">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Transcript</h3>
          <span className="text-[12px] text-sh-text-3">{showRaw ? 'raw capture, as recognised' : 'cleaned · a capital and a full stop per sentence'}</span>
        </div>
        <div aria-live="polite" className="sh-scrollbar flex max-h-[288px] flex-col gap-[10px] overflow-y-auto rounded-[16px] bg-sh-inner p-[12px]">
          {lines.length === 0 && d.interim.trim() === '' && (
            <p className="py-[24px] text-center text-[13px] text-sh-text-3">
              {recording ? 'Listening — speak normally; the lines appear here as they are heard.' : unavailable ? 'Nothing was heard.' : 'Waiting for speech…'}
            </p>
          )}
          {lines.map((line, i) => {
            const newSection = line.feeds !== lines[i - 1]?.feeds
            return (
              <div key={line.key}>
                {newSection && <p className={cn('text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3', i > 0 && 'mt-[12px]')}>{labelFor(line.feeds)}</p>}
                <div className="flex gap-[12px]">
                  <span className="w-[40px] shrink-0 pt-[2px] text-[12px] tabular-nums text-sh-text-3">{formatClock(line.atSec)}</span>
                  <span className={cn('min-w-0 flex-1 text-[14px] text-sh-text', showRaw && 'font-mono text-[13px] text-sh-text-2')}>{showRaw ? line.raw : line.cleaned}</span>
                </div>
              </div>
            )
          })}
          {/* The words still in flight — quiet, and not yet in any draft section. */}
          {d.interim.trim() !== '' && (
            <div className="flex gap-[12px]">
              <span className="w-[40px] shrink-0 pt-[2px] text-[12px] tabular-nums text-sh-text-3">{formatClock(d.elapsedSec)}</span>
              <span className="min-w-0 flex-1 text-[14px] italic text-sh-text-3">{d.interim.trim()}…</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
        {drafted.length === 0 && (
          <p className="mt-[8px] flex items-start gap-[8px] px-[4px] text-[12px] text-sh-text-3">
            <Icon icon={Info} size={13} className="mt-[2px] shrink-0" />
            {cannotListen || unavailable ? 'Nothing to draft without speech. Close this and dictate or type each section instead.' : 'Use this draft turns on once something has been heard.'}
          </p>
        )}
      </div>

      <Why label="What is kept, and what happens if the speech service drops">
        <p>
          The raw transcript is kept with the draft. Every drafted sentence is one that was said — the scribe places sentences in a section by the words
          used, and does not reword, add or infer. It cannot tell who is speaking. If the speech service drops, what was already heard is kept, and
          typing is always available.
        </p>
      </Why>

      <footer className="flex flex-wrap items-center gap-[10px] border-t border-sh-line pt-[14px]">
        <span className="mr-auto flex items-center gap-[10px]">
          <Toggle checked={showRaw} onChange={setShowRaw} label="Show the raw capture" />
          <span className="text-[13px] text-sh-text-3">Show raw capture</span>
        </span>
        <Pill variant="control" size="lg" icon={X} onClick={onClose}>
          Cancel
        </Pill>
        <Pill
          variant="accent"
          size="lg"
          icon={Check}
          disabled={drafted.length === 0}
          title={drafted.length === 0 ? 'Nothing has been heard yet, so there is nothing to draft' : undefined}
          className="disabled:opacity-40"
          onClick={adoptDraft}
        >
          Use this draft
        </Pill>
      </footer>
    </div>
  )
}
