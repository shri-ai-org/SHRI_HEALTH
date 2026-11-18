// SHRI_HEALTH: who may see the front office's Administration area (Vimal on #85, 18 Nov): the
// navigation entry is shown only to the administrator (role ADM), and each screen inside it only
// with its read permission, from GET /me (the server checks every read regardless).
import { useEffect, useState } from 'react'

import { getMe } from '../../../src/api/generated/endpoints/platform/platform'
import { useSession } from '../../../src/api/session'

/** The admin screens and the permission each one reads with (the contract's x-permission). */
export const ADMIN_SECTIONS = [
  { path: 'users', label: 'Users and roles', permission: 'roles:read' },
  { path: 'audit', label: 'Audit trail', permission: 'audit-events:read' },
  { path: 'fhir', label: 'FHIR R4 view', permission: 'patients:read' },
  { path: 'integrations', label: 'Partner messages', permission: 'integration-messages:read' },
] as const

export type AdminSection = (typeof ADMIN_SECTIONS)[number]

let mePermissions: Promise<ReadonlySet<string>> | null = null
let readFor: string | null = null

/** The signed-in user's permissions, read once per user (an empty set if the read fails: fail closed). */
function permissionsFor(userId: string): Promise<ReadonlySet<string>> {
  if (!mePermissions || readFor !== userId) {
    readFor = userId
    mePermissions = getMe().then(
      (res) => new Set(res.status === 200 ? res.data.permissions : []),
      () => new Set<string>(),
    )
  }
  return mePermissions
}

/** The sections a set of permissions opens, in menu order. */
export function sectionsFor(permissions: ReadonlySet<string>): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => permissions.has(s.permission))
}

export interface AdminAccess {
  /** The signed-in user is the administrator: the navigation shows the Administration entry. */
  isAdmin: boolean
  /** Their permissions once read; null while reading or for anyone who isn't the administrator. */
  permissions: ReadonlySet<string> | null
}

export function useAdminAccess(): AdminAccess {
  const { state } = useSession()
  const user = state.status === 'signed-in' ? state.session.user : null
  const isAdmin = Boolean(user?.roles.includes('ADM'))
  const [permissions, setPermissions] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    if (!user || !isAdmin) return
    let live = true
    void permissionsFor(user.id).then((p) => live && setPermissions(p))
    return () => {
      live = false
    }
  }, [user, isAdmin])
  return { isAdmin, permissions: isAdmin ? permissions : null }
}
