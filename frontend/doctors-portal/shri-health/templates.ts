// SHRI_HEALTH data layer: the practice's note templates (GET /note-templates) as rows of the
// Templates screen, read once through Suspense. A template's sections are its items. Order sets,
// their review dates and promotion have no service yet, so those rows never come from here.
import type { LibrarySet } from '../src/shri/logic/ordersets'

import { listNoteTemplates } from '../../src/api/generated/endpoints/practice-setup/practice-setup'
import type { NoteTemplate } from '../../src/api/generated/model'

import { read } from './resource'

async function load(): Promise<LibrarySet[]> {
  const all: NoteTemplate[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page += 1) {
    const res = await listNoteTemplates({ limit: 100, ...(cursor ? { cursor } : {}) })
    const data = res.data as { items: NoteTemplate[]; nextCursor?: string | null }
    all.push(...data.items)
    cursor = data.nextCursor ?? undefined
    if (!cursor) break
  }
  return all
    .filter((t) => t.active)
    .map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.personal ? 'Personal' : 'Facility-wide',
      // The owner's name isn't in the API; a practice template belongs to the practice.
      owner: t.personal ? 'Yours' : 'The practice',
      reviewDue: '—',
      items: [...(t.sections ?? [])].sort((a, b) => a.sequence - b.sequence).map((s) => s.title),
      usedThisMonth: 0,
    }))
}

/** The practice's active note templates, as the screen's rows. */
export function noteTemplateSets(): LibrarySet[] {
  return read('note-templates', load)
}
