// SHRI_HEALTH: "Draft with AI" never wipes or silently overwrites the clinician's sections
// (Vimal's rehearsal, 14 Nov). Each draft is a new note on the server (createNoteDraft), so the
// screen merges it with what the clinician already has, section by section:
//  - a section the clinician already wrote (typed, dictated, or an AI draft they accepted or
//    edited) keeps its text. A new AI suggestion for it is OFFERED (replace / keep mine), never
//    applied: `offers`;
//  - an empty section with a new AI suggestion is filled as before: the ghost draft to accept,
//    edit or reject (`drafted`);
//  - a section the new draft left empty keeps whatever it had.
// The dictation behind each draft is the whole visit's, in order (`useVisitDictation`), so a
// second draft covers everything said so far. "Clear dictation" is the only way to start over.

import { create } from 'zustand'

export type Provenance = 'typed' | 'dictated' | 'scribe' | 'carried'

export interface AiSuggestionText {
  suggestionId: string
  text: string
}

export interface MergeInput {
  /** What the screen shows now, by section key. */
  text: Record<string, string>
  provenance: Record<string, Provenance | undefined>
  /** The new draft's undecided AI suggestions, by section key. */
  suggestions: Record<string, AiSuggestionText>
  /** The new draft's sections as the server holds them (the AI text, or empty). */
  serverText: Record<string, string>
}

export interface MergeResult {
  text: Record<string, string>
  provenance: Record<string, Provenance | undefined>
  /** Empty sections the new draft fills: shown as the ghost draft. */
  drafted: string[]
  /** Sections the clinician already wrote that the new draft has a suggestion for. */
  offers: Record<string, AiSuggestionText>
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export function mergeDraft(input: MergeInput): MergeResult {
  const keys = new Set([...Object.keys(input.text), ...Object.keys(input.serverText), ...Object.keys(input.suggestions)])
  const text: Record<string, string> = {}
  const provenance: Record<string, Provenance | undefined> = {}
  const drafted: string[] = []
  const offers: Record<string, AiSuggestionText> = {}
  for (const k of keys) {
    const mine = input.text[k] ?? ''
    const suggestion = input.suggestions[k]
    if (norm(mine) !== '') {
      // The clinician's text stays, whatever the draft says.
      text[k] = mine
      // An accepted AI section becomes theirs to keep while a new suggestion waits beside it.
      provenance[k] = suggestion && input.provenance[k] === 'scribe' ? 'typed' : input.provenance[k]
      if (suggestion && norm(suggestion.text) !== '') offers[k] = suggestion
    } else if (suggestion && norm(suggestion.text) !== '') {
      // An empty section takes the new draft, as the ghost to decide.
      text[k] = ''
      provenance[k] = 'scribe'
      drafted.push(k)
    } else {
      text[k] = input.serverText[k] ?? mine
      provenance[k] = input.provenance[k]
    }
  }
  return { text, provenance, drafted, offers }
}

/** Whether the clinician's text and the AI's are the same words (a matching offer only needs a confirm). */
export const sameText = (a: string, b: string) => norm(a) === norm(b)

/* ---------------------------------------------------------------- the visit's dictation */

/**
 * Every "Draft with AI" dictation for a visit, in order. Kept in this tab's memory only, never
 * in browser storage (it is what the patient said); a reload starts the list again, and the
 * merge above still keeps every section already written.
 */
export const useVisitDictation = create<{
  takes: Record<string, string[]>
  add: (encounterId: string, text: string) => void
  clear: (encounterId: string) => void
}>()((set, get) => ({
  takes: {},
  add: (encounterId, text) => {
    const t = text.trim()
    if (t === '') return
    set({ takes: { ...get().takes, [encounterId]: [...(get().takes[encounterId] ?? []), t] } })
  },
  clear: (encounterId) => {
    const next = { ...get().takes }
    delete next[encounterId]
    set({ takes: next })
  },
}))

/** The visit's dictation so far and this take, as one transcript in the order it was said. */
export function cumulativeTranscript(earlier: string[] | undefined, current: string): string {
  return [...(earlier ?? []), current.trim()].filter((t) => t !== '').join('\n')
}

/* ------------------------------------------------------------------- the offers */

/** New AI suggestions for sections the clinician already wrote, by `encounterId:key`. */
export const useDraftOffers = create<{
  offers: Record<string, AiSuggestionText>
  /** Replaces the encounter's offers with a new draft's. */
  setFor: (encounterId: string, offers: Record<string, AiSuggestionText>) => void
  clear: (touchpointId: string) => void
}>()((set, get) => ({
  offers: {},
  setFor: (encounterId, offers) => {
    const kept = Object.fromEntries(Object.entries(get().offers).filter(([id]) => !id.startsWith(`${encounterId}:`)))
    for (const [k, o] of Object.entries(offers)) kept[`${encounterId}:${k}`] = o
    set({ offers: kept })
  },
  clear: (touchpointId) => {
    const next = { ...get().offers }
    delete next[touchpointId]
    set({ offers: next })
  },
}))
