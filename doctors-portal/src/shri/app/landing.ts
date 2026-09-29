import { can, PERSONA_SPECS, type PersonaId } from '@/atlas/personas'
import { screen, screenForPath } from '@/atlas/registry'
import { useSession } from '@/store/session'

import { canonical } from './paths'

/**
 * Where a persona lands after signing in, from the atlas (`PERSONA_SPECS`),
 * through the two moved addresses. A landing the registry has no screen for —
 * P-06's `/ed/board` — lands on My Day instead of on "No screen at this
 * address" (the gap the old build had).
 */
export function landingFor(persona: PersonaId): string {
  const to = canonical(PERSONA_SPECS[persona].landing)
  return to === '/' || screenForPath(to) ? to : '/'
}

/** Whether the persona may open a screen — the registry's own `permission`, default deny. */
export function mayOpen(persona: PersonaId, permission: string): boolean {
  return permission === 'public' || can(persona, permission)
}

/**
 * Whether the persona may open whatever is at an address — for GP-02's rule
 * that a link to a screen the persona cannot use is absent, never greyed. The
 * two moved addresses resolve through their screens; an address with no screen
 * behind it is not offered at all.
 */
export function mayOpenPath(persona: PersonaId, to: string): boolean {
  const path = to.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  const spec = path === '/' ? screen('S-06-01') : /^\/patient\/[^/]+$/.test(path) ? screen('S-06-11') : screenForPath(path)
  return spec !== undefined && mayOpen(persona, spec.permission)
}

/** `mayOpenPath` for the signed-in persona. */
export function useMayOpenPath(): (to: string) => boolean {
  const persona = useSession((s) => s.persona)
  return (to) => mayOpenPath(persona, to)
}
