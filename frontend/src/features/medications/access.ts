import { useEffect, useState } from 'react'
import { getMe } from '../../api/generated/endpoints/platform/platform'
import { useSignedInSession } from '../../api/session'

/** What this user may do with prescriptions on this screen. Hiding is for clarity; the server still checks every call. */
export interface PrescribingAccess {
  /** False until the decision is known, so the screen doesn't flash a notice while `GET /me` loads. */
  known: boolean
  create: boolean
  check: boolean
  sign: boolean
  discard: boolean
  override: boolean
}

const NONE: Omit<PrescribingAccess, 'known'> = { create: false, check: false, sign: false, discard: false, override: false }

/**
 * Prescribing is MD and APP only in the MVP (D110): the medications service refuses anyone else,
 * even though core still grants RN some `prescriptions:*` permissions. So a role check comes first,
 * then each action needs its own permission from `GET /me` (`prescriptions:create`,
 * `…:safety-check`, `…:sign-and-send`, `…:entered-in-error`, `alerts:override`). It fails closed:
 * outside a session, for any other role, or when `GET /me` can't be read, every action is hidden.
 */
export function usePrescribingAccess(): PrescribingAccess {
  const session = useSignedInSession()
  const prescriber = session?.user.roles.some((r) => r === 'MD' || r === 'APP') ?? false
  const userId = session?.user.id ?? null
  // The permission set for this user, or 'failed' when `GET /me` couldn't be read.
  const [granted, setGranted] = useState<{ userId: string; permissions: Set<string> | 'failed' } | null>(null)

  useEffect(() => {
    if (!prescriber || userId === null) return
    let current = true
    getMe()
      .then((res) => {
        if (current) setGranted({ userId, permissions: res.status === 200 ? new Set(res.data.permissions) : 'failed' })
      })
      .catch(() => {
        if (current) setGranted({ userId, permissions: 'failed' })
      })
    return () => {
      current = false
    }
  }, [prescriber, userId])

  if (!prescriber) return { known: true, ...NONE }
  if (granted === null || granted.userId !== userId) return { known: false, ...NONE }
  if (granted.permissions === 'failed') return { known: true, ...NONE }
  const has = (p: string) => (granted.permissions as Set<string>).has(p)
  return {
    known: true,
    create: has('prescriptions:create'),
    check: has('prescriptions:safety-check'),
    sign: has('prescriptions:sign-and-send'),
    discard: has('prescriptions:entered-in-error'),
    override: has('alerts:override'),
  }
}
