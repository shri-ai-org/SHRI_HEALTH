// Development server only (VITE_PASSWORD_HELP_PREVIEW=on with VITE_FEATURE_PASSWORD_HELP=on; never
// a production build, where import.meta.env.DEV is false): synthetic requests, so the approval
// screen can be seen before the contract exists. Fictional people only. A username containing
// "conflict", "stale" or "gone" answers 409, 412 or 404, and a decline note over 200 characters
// answers 422, to show those states.
import type { DecisionOutcome, PasswordResetHandlers, ResetRequestRow } from './passwordResets'

const HOUR = 3_600_000

function rows(now: number): ResetRequestRow[] {
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString()
  const until = (hoursAgo: number) => new Date(now - hoursAgo * HOUR + 24 * HOUR).toISOString()
  return [
    { id: 'preview-1', version: '1', displayName: 'Jordan Example', role: 'Physician (MD)', realm: 'staff', username: 'jordan.example', requestedAt: at(0.5), expiresAt: until(0.5) },
    { id: 'preview-2', version: '1', displayName: 'Casey Sample', role: 'Patient', realm: 'patients', mobileLast4: '0142', requestedAt: at(2), expiresAt: until(2) },
    { id: 'preview-3', version: '1', displayName: 'Riley Test', role: 'Front desk (FD)', realm: 'staff', username: 'riley.conflict', requestedAt: at(5), expiresAt: until(5) },
    { id: 'preview-4', version: '1', displayName: 'Morgan Demo', role: 'Patient', realm: 'patients', username: 'morgan.stale', requestedAt: at(20), expiresAt: until(20) },
  ]
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function answer(row: ResetRequestRow): DecisionOutcome {
  const name = row.username ?? ''
  if (name.includes('conflict')) return { kind: 'conflict' }
  if (name.includes('stale')) return { kind: 'stale' }
  if (name.includes('gone')) return { kind: 'not-found' }
  return { kind: 'done' }
}

export function previewResetHandlers(): PasswordResetHandlers {
  let pending = rows(Date.now())
  return {
    async list() {
      await wait(300)
      return { kind: 'ok', items: pending }
    },
    async approve(row) {
      await wait(400)
      const out = answer(row)
      if (out.kind === 'done' || out.kind === 'conflict') pending = pending.filter((r) => r.id !== row.id)
      return out
    },
    async decline(row, note) {
      await wait(400)
      if (note && note.length > 200) return { kind: 'invalid', message: 'The note can be at most 200 characters.' }
      const out = answer(row)
      if (out.kind === 'done' || out.kind === 'conflict') pending = pending.filter((r) => r.id !== row.id)
      return out
    },
  }
}
