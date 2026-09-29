/**
 * The ambient scribe's drafting step — from what was heard to four sections.
 *
 * S-06-04 listens through the browser's own speech recogniser (see
 * `components/dictation.tsx`). What comes back is the clinician's speech as
 * text, often with no punctuation at all, and certainly with no idea which
 * part of a SOAP note each sentence belongs in. This module does the one thing
 * left: it routes each sentence to a section by the words clinicians use to
 * open one ("on examination", "impression", "plan"), and by the vocabulary of
 * each section (a pressure is objective; "since last night" is history).
 *
 * WHAT IT DOES NOT DO, deliberately: reword, summarise, add or infer. Every
 * sentence in a draft is a sentence that was said, tidied only to start with a
 * capital and end with a full stop. A draft section is therefore its own
 * evidence — the Why? drawer can quote it back verbatim. Anything it cannot
 * place goes to Subjective, the section a clinician reads first, rather than
 * being dropped.
 *
 * THE HAND-OFF. The scribe is an overlay opened by the note it drafts for, but
 * the two screens that host it (S-06-03, S-08-04) only pass the section KEYS
 * on. So the drafted TEXT travels through `useScribeDrafts`: "Draft with AI"
 * on the note aims the scribe at that encounter, and "Use this draft" writes
 * the text there. It is persisted, because the note's `scribe` provenance and
 * its C-41 decisions are persisted too — a reload must not turn an undecided
 * draft into a section with nothing to decide on.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { ConfidenceBand } from '@/atlas/confidence'

import type { SectionKey } from './clinical'

export type ScribeSections = Partial<Record<SectionKey, string>>

export const SCRIBE_SECTION_KEYS: SectionKey[] = ['subjective', 'objective', 'assessment', 'plan']

// ─────────────────────────────────────────────────────────── Joining speech

/** Recognised phrases arrive with and without a leading space; join them with exactly one. */
export function joinSpeech(a: string, b: string): string {
  const x = a.trim()
  const y = b.trim()
  if (!x) return y
  if (!y) return x
  return `${x} ${y}`
}

// ────────────────────────────────────────────────────────────── Sentences

/**
 * Words a clinician uses to OPEN a section when speaking a note. Chrome's
 * recogniser adds no full stops, so in unpunctuated speech these are also the
 * only reliable sentence boundaries. A header word after an article ("the
 * plan with the family", "discussed the diagnosis") is not a header.
 */
const HEADER =
  /\s+(?=(?<!\b(?:the|a|an|our|this|my|your|his|her|their|of|no)\s)(?:on examination|examination shows|my impression|impression|assessment|diagnosis|plan)\b)/i

/**
 * Sentences, in the order spoken. Punctuation splits where the recogniser
 * gave any; a line break splits between recognised phrases; a spoken section
 * header splits a run of words that has no punctuation at all.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\n+/)) {
    for (const chunk of line.split(/(?<=[.!?])\s+/)) {
      const s = chunk.trim()
      if (s === '') continue
      if (/[.!?,;]/.test(s)) out.push(s)
      else out.push(...s.split(HEADER).map((p) => p.trim()).filter(Boolean))
    }
  }
  return out
}

/** AI-104's lightest touch: a capital to start, a full stop to end. Nothing else changes. */
export function tidySentence(s: string): string {
  const t = s.trim()
  if (t === '') return ''
  const cased = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(cased) ? cased : `${cased}.`
}

// ────────────────────────────────────────────────────────────────── Routing

/** A sentence that STARTS with one of these belongs to that section outright. */
const OPENERS: [RegExp, SectionKey][] = [
  [/^(plan|management|advice|advised|to do)\b/i, 'plan'],
  [/^(impression|my impression|assessment|diagnosis|differential|likely|probably|consistent with)\b/i, 'assessment'],
  [/^(on examination|examination|o\/?e|vitals|observations|bp|blood pressure|pulse|temperature|sats|saturation|spo2)\b/i, 'objective'],
  [/^(complains?|complaint|history|presents?|presenting|patient (reports|says|complains|feels)|reports|feels|since)\b/i, 'subjective'],
]

/** The vocabulary of each section, scored when no opener decides it. */
const CUES: Record<SectionKey, RegExp[]> = {
  subjective: [
    /\bcomplain(s|ed|ing|t)?\b/i,
    /\bhistory\b/i,
    /\bfe(el|els|eling|lt)\b/i,
    /\bsince\b/i,
    /\breport(s|ed|ing)?\b/i,
    /\bsays?\b/i,
    /\bdenies\b/i,
    /\bno (fever|pain|cough|vomiting)\b/i,
  ],
  objective: [
    /\bbp\b/i,
    /\bblood pressure\b/i,
    /\bpulse\b/i,
    /\bheart rate\b/i,
    /\brespiratory rate\b/i,
    /\btemp(erature)?\b/i,
    /\bsat(s|uration|urations|urating)?\b/i,
    /\bspo2\b/i,
    /\bsp ?o2\b/i,
    /\bexam(ination|ined)?\b/i,
    /\bon examination\b/i,
    /\bchest\b/i,
    /\babdomen\b/i,
    /\bcrackles?\b/i,
    /\bauscultation\b/i,
    /\bmm ?hg\b/i,
  ],
  assessment: [
    /\bimpression\b/i,
    /\bdiagnos(is|ed|e)\b/i,
    /\blikely\b/i,
    /\bconsistent with\b/i,
    /\bassessment\b/i,
    /\bdifferential\b/i,
    /\bsuggestive of\b/i,
  ],
  plan: [
    /\bplan\b/i,
    /\bstart(ing)?\b/i,
    /\bstop(ping)?\b/i,
    /\bcontinue\b/i,
    /\badvi(se|sed|ce)\b/i,
    /\breview\b/i,
    /\bfollow[- ]?up\b/i,
    /\border(ed)?\b/i,
    /\brepeat\b/i,
    /\brefer(ral|red)?\b/i,
    /\bprescribe(d)?\b/i,
    /\bdischarge\b/i,
  ],
}

/** Ties go to the section that is costliest to miss: the plan, then the assessment. */
const TIE_ORDER: SectionKey[] = ['plan', 'assessment', 'subjective', 'objective']

/** The section one sentence belongs in. Unplaceable sentences are Subjective, never dropped. */
export function routeSentence(sentence: string): SectionKey {
  const s = sentence.trim()
  for (const [re, key] of OPENERS) if (re.test(s)) return key
  let best: SectionKey = 'subjective'
  let bestScore = 0
  for (const key of TIE_ORDER) {
    const score = CUES[key].filter((re) => re.test(s)).length
    if (score > bestScore) {
      best = key
      bestScore = score
    }
  }
  return best
}

/**
 * The live transcript, drafted. Only sections that received a sentence are
 * returned, so an absent key means "nothing was said for this section".
 */
export function draftFromTranscript(text: string): ScribeSections {
  const bySection: Record<SectionKey, string[]> = { subjective: [], objective: [], assessment: [], plan: [] }
  for (const sentence of splitSentences(text)) {
    const tidy = tidySentence(sentence)
    if (tidy !== '') bySection[routeSentence(sentence)].push(tidy)
  }
  const out: ScribeSections = {}
  for (const key of SCRIBE_SECTION_KEYS) if (bySection[key].length > 0) out[key] = bySection[key].join(' ')
  return out
}

// ───────────────────────────────────────────────────────────── The hand-off

export interface ScribeDraft {
  patientId: string
  sections: ScribeSections
  /** The transcript it was drafted from, verbatim — AI-101's retention rule. */
  transcript: string
  model: string
  band: ConfidenceBand
  confidence: number
  /** False where the recogniser reported no score: show the band, never a number. */
  scored: boolean
  /** ISO timestamp of the hand-off. */
  at: string
}

interface ScribeState {
  /** The note that opened the scribe — set by "Draft with AI". */
  target: { encounterId: string; patientId: string } | null
  /** Drafted text per encounter. */
  drafts: Record<string, ScribeDraft>
  aim: (encounterId: string, patientId: string) => void
  /** Writes the draft to the aimed note. Returns that note's encounter id, or null if nothing was aimed here. */
  publish: (draft: ScribeDraft) => string | null
}

export const useScribeDrafts = create<ScribeState>()(
  persist(
    (set, get) => ({
      target: null,
      drafts: {},
      aim: (encounterId, patientId) => set({ target: { encounterId, patientId } }),
      publish: (draft) => {
        const target = get().target
        if (!target || target.patientId !== draft.patientId) return null
        set({ drafts: { ...get().drafts, [target.encounterId]: draft } })
        return target.encounterId
      },
    }),
    { name: 'indostates.scribe', partialize: (s) => ({ drafts: s.drafts }) },
  ),
)
