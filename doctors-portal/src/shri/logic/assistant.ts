/**
 * Ported from `src/shell/Assistant.tsx` — what the assistant is scoped to:
 * the screen it was asked from, the Z3 patient if that screen has one, and the
 * doctor's session the record answers read (`LiveContext`). The answers
 * themselves are the old build's (`resolveAnswer`, `suggestionsFor` in
 * `src/data/assistant.ts`), guardrails and all.
 */

import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { routeForSource, screen, screenForPath, type ScreenSpec } from '@/atlas/registry'
import type { AskContext, Citation } from '@/data/assistant'
import type { LiveContext } from '@/data/assistant-record'
import { maybeEncounter, maybeResult } from '@/data/clinical'
import { maybeImagingStudy } from '@/data/imaging'
import { patientByAnyId } from '@/data/kit'
import { maybeStrokeCase } from '@/data/stroke'
import { useAdmissions } from '@/store/admissions'
import { useAudit, type AuditRow } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { canonical } from '../app/paths'

/** The screen at an address — with this build's two moved addresses, My Day at `/` and the record at `/patient/:id`. */
export function screenAt(pathname: string): ScreenSpec | undefined {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return screen('S-06-01')
  if (/^\/patient\/[^/]+$/.test(path)) return screen('S-06-11')
  return screenForPath(path)
}

/**
 * Whether the assistant is offered here (§6.1): only where the screen's Z7b
 * line is GP-17. A wall has no operator at it; a modal screen is a moment,
 * not a place; and the assistant screens ARE the assistant — the bubble is
 * their entry point, not an element on them.
 */
export function assistantOfferedAt(pathname: string): boolean {
  const spec = screenAt(pathname)
  return spec ? spec.z7b === 'GP-17' : true
}

/**
 * The Z3 patient, if the calling screen had one. No Z3 ⇒ no patient scope.
 * Routes carry a UHID, or an id that names exactly one patient — an
 * encounter, a result, a study, a stroke case. Anything else names no
 * patient rather than guessing one: the wrong patient matters more than
 * convenience.
 */
export function patientAt(pathname: string): string | undefined {
  const spec = screenAt(pathname)
  if (!spec?.patientScoped) return undefined
  const route = spec.id === 'S-06-11' ? '/patient/:id' : spec.route
  if (!route) return undefined
  const at = route.split('/').filter(Boolean).indexOf(':id')
  const id = at >= 0 ? pathname.split('/').filter(Boolean)[at] : undefined
  if (!id) return undefined
  return (
    patientByAnyId(id)?.id ??
    maybeEncounter(id)?.patientId ??
    maybeResult(id)?.patientId ??
    maybeImagingStudy(id)?.patientId ??
    (route.startsWith('/stroke/case/') ? maybeStrokeCase(id)?.patientId : undefined)
  )
}

/** Audit rows written before this page load are history, not something the doctor has just done. */
const LOADED_AFTER = useAudit.getState().rows.at(-1)?.id

function recentAction(rows: AuditRow[], actorId: string): AuditRow | undefined {
  const start = LOADED_AFTER ? rows.findIndex((r) => r.id === LOADED_AFTER) + 1 : 0
  for (let i = rows.length - 1; i >= start; i -= 1) if (rows[i].actorId === actorId) return rows[i]
  return undefined
}

/** What the record answers read — the same session state My Day reads. */
export function useLiveContext(): LiveContext {
  const persona = useSession((s) => s.persona)
  const breakGlass = useSession((s) => s.breakGlassPatients)
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const seenAt = useClinical((s) => s.seenAt)
  const admissions = useAdmissions((s) => s.admissions)
  const rows = useAudit((s) => s.rows)
  const me = useCurrentStaff()
  return useMemo(() => {
    const recent = recentAction(rows, me.id)
    return { persona, breakGlass, acknowledgements, seenAt, admissions, recent: recent && { event: recent.event, subject: recent.subject } }
  }, [persona, breakGlass, acknowledgements, seenAt, admissions, rows, me.id])
}

/** The context an answer is resolved in, for the page the doctor is on. */
export function useAskContext(): AskContext & { spec?: ScreenSpec } {
  const { pathname } = useLocation()
  const live = useLiveContext()
  return useMemo(() => {
    const spec = screenAt(pathname)
    const patientId = patientAt(pathname)
    return { spec, screenId: spec?.id ?? 'S-06-01', patientId, patientScoped: Boolean(patientId), live }
  }, [pathname, live])
}

/**
 * A citation opens what it cites where this build has a screen for it, and
 * otherwise says it is documentation. `beforeOpen` lets the drawer get out of
 * the way on a narrow screen, where it would cover the page it just opened.
 */
export function useOpenSource(beforeOpen?: () => void): (c: Citation) => void {
  const navigate = useNavigate()
  const toast = useUI((s) => s.toast)
  return (c) => {
    const route = c.to ?? routeForSource(c.source)
    if (!route) {
      toast({ tone: 'info', title: c.label, detail: `${c.source} — documentation, not a screen in this build.` })
      return
    }
    beforeOpen?.()
    navigate(canonical(route))
  }
}
