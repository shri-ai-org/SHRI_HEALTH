/**
 * The reading room's own marks on a study, kept per study: annotations
 * (lengths, angles, ellipses, arrows, text, pen strokes), key images, a draft
 * report and every signed report or addendum. None of it changes the pixels;
 * none of it enters the record's report until a named reader signs text that
 * says so. Persisted with the rest of the session's clinical state; each
 * change is audited by the screen that makes it (`imaging/viewer/*`).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ToolKind = 'length' | 'angle' | 'ellipse' | 'arrow' | 'text' | 'pen'

export interface Annotation {
  id: string
  /** 1-based frame of the series it was drawn on. */
  frame: number
  tool: ToolKind
  /** In the exported frame's own pixels, so a mark stays on what it marks at any zoom, rotation or flip. */
  points: [number, number][]
  text?: string
  /** An ellipse's mean display value (0–255), sampled when it was drawn. */
  value?: number
  by: string
  at: string
}

export interface SignedText {
  id: string
  kind: 'Report' | 'Addendum'
  findings?: string
  impression: string
  by: string
  at: string
}

interface ImagingState {
  annotations: Record<string, Annotation[]>
  keyImages: Record<string, number[]>
  drafts: Record<string, { findings: string; impression: string; savedAt: string } | undefined>
  signed: Record<string, SignedText[]>
  setAnnotations: (studyId: string, list: Annotation[]) => void
  toggleKey: (studyId: string, frame: number) => boolean
  saveDraft: (studyId: string, findings: string, impression: string) => void
  sign: (studyId: string, entry: Omit<SignedText, 'id' | 'at'>) => SignedText
}

const stamp = () => new Date().toISOString()

export const useImaging = create<ImagingState>()(
  persist(
    (set, get) => ({
      annotations: {},
      keyImages: {},
      drafts: {},
      signed: {},
      setAnnotations: (studyId, list) => set({ annotations: { ...get().annotations, [studyId]: list } }),
      toggleKey: (studyId, frame) => {
        const now = get().keyImages[studyId] ?? []
        const on = !now.includes(frame)
        set({ keyImages: { ...get().keyImages, [studyId]: on ? [...now, frame].sort((a, b) => a - b) : now.filter((f) => f !== frame) } })
        return on
      },
      saveDraft: (studyId, findings, impression) => set({ drafts: { ...get().drafts, [studyId]: { findings, impression, savedAt: stamp() } } }),
      // Signing appends; a signed report is never overwritten, and the draft it came from is cleared.
      sign: (studyId, entry) => {
        const signed: SignedText = { ...entry, id: `${studyId}-${(get().signed[studyId]?.length ?? 0) + 1}`, at: stamp() }
        set({ signed: { ...get().signed, [studyId]: [...(get().signed[studyId] ?? []), signed] }, drafts: { ...get().drafts, [studyId]: undefined } })
        return signed
      },
    }),
    { name: 'shri.imaging', version: 1 },
  ),
)
