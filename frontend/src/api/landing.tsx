/**
 * Where each signed-in role lands (demo, 12 Nov). The front office is the default app at `/`; a
 * user whose roles belong only in the doctors' portal (MD, APP, RN, with no front-office role) is
 * forwarded to `/clinician/` as soon as the session is read, before the front office renders, so
 * there is no flash of it. The decision is by role, from the signed-in session, never by username.
 *
 * Only our own app path: the target is a fixed path under this build's base (`BASE_URL`), never a
 * value from the address or the server, so this can't be used as an open redirect. A user who may
 * use the front office (any front-office role, alone or with a clinician role) stays where they
 * are, deep links included. ADM stays on `/` until an admin app exists.
 */
import { useLayoutEffect, type ReactNode } from 'react'
import { useSession } from './session'

/** Roles whose app is the doctors' portal. */
const CLINICIAN_ROLES: readonly string[] = ['MD', 'APP', 'RN']
/** Roles that use the front office (ADM included until it has an app of its own). */
const FRONT_OFFICE_ROLES: readonly string[] = ['FD', 'MA', 'ADM', 'BIL', 'CO', 'SUP']

/** True when these roles belong in the doctors' portal and not in the front office. */
export function belongsInClinicianApp(roles: readonly string[]): boolean {
  return roles.some((r) => CLINICIAN_ROLES.includes(r)) && !roles.some((r) => FRONT_OFFICE_ROLES.includes(r))
}

/** The doctors' portal next to this build: `<base>clinician/` (deploy kit: `${SHRI_BASE_PATH}/clinician/`). */
export function clinicianAppPath(base: string = import.meta.env.BASE_URL): string {
  return `${base.endsWith('/') ? base : `${base}/`}clinician/`
}

/**
 * Inside `<SessionProvider>` (it renders children only once signed in): forwards a clinician-only
 * user to the doctors' portal at once and renders nothing meanwhile; anyone else sees the children.
 * Already under the clinician path (a server that fell back to the front office there), it stays,
 * so it can never loop.
 */
export function FrontOfficeLanding({ children }: { children: ReactNode }) {
  const { state } = useSession()
  const target = clinicianAppPath()
  const forward =
    state.status === 'signed-in' &&
    belongsInClinicianApp(state.session.user.roles) &&
    !window.location.pathname.startsWith(target)
  useLayoutEffect(() => {
    if (forward) window.location.replace(target)
  }, [forward, target])
  return forward ? null : children
}
