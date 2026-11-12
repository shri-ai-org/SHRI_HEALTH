// SHRI_HEALTH data layer for My Day: the signed-in provider's own day and week (GET /me's
// practitionerId, #221). Today's bookings come from the status board and the open times from the
// slots; the week counts the provider's bookings per day. Each read runs when the screen opens.
import { useEffect, useState } from 'react'

import { getStatusBoard, listAppointments, listSlots } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { AppointmentSummary, Slot, StatusBoardItem } from '../../src/api/generated/model'

import { clinicDate, clinicNow } from './format'
import { signedInUser, userFacility } from './opd'

export type Loaded<T> = { status: 'loading' } | { status: 'not-a-provider' } | { status: 'failed' } | { status: 'done'; value: T }

export interface ProviderDay {
  /** Today's bookings, by start time, without cancelled ones. */
  items: StatusBoardItem[]
  /** Open times still ahead today. */
  slots: Slot[]
}

/** YYYY-MM-DD of a clinic-time Date. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function useLoaded<T>(key: string, load: (facilityId: string, providerId: string) => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string; loaded: Loaded<T> }>({ key, loaded: { status: 'loading' } })
  useEffect(() => {
    let current = true
    const settle = (loaded: Loaded<T>) => current && setState({ key, loaded })
    userFacility()
      .then(async (facility) => {
        const providerId = signedInUser()?.practitionerId
        if (!facility || !providerId) return settle({ status: 'not-a-provider' })
        settle({ status: 'done', value: await load(facility.id, providerId) })
      })
      .catch(() => settle({ status: 'failed' }))
    return () => {
      current = false
    }
    // `load` is a fresh closure every render; the key names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state.key === key ? state.loaded : { status: 'loading' }
}

/** The provider's day today. */
export function useProviderDay(): Loaded<ProviderDay> {
  const date = isoDay(clinicNow())
  return useLoaded(`day:${date}`, async (facilityId, providerId) => {
    const [board, open] = await Promise.all([
      getStatusBoard({ facilityId, date, view: 'staff', providerId, limit: 100 }),
      listSlots({ facilityId, date, providerId, limit: 100 }),
    ])
    const now = Date.now()
    return {
      items: (board.data as { items: StatusBoardItem[] }).items.filter((i) => i.status !== 'cancelled').sort((a, b) => a.startAt.localeCompare(b.startAt)),
      slots: (open.data as { items: Slot[] }).items.filter((s) => new Date(s.startAt).getTime() > now),
    }
  })
}

/** How many bookings the provider has on each day of the week from `monday` (YYYY-MM-DD → count). */
export function useProviderWeek(monday: Date): Loaded<Map<string, number>> {
  const from = isoDay(monday)
  const to = isoDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6))
  return useLoaded(`week:${from}`, async (facilityId, providerId) => {
    const counts = new Map<string, number>()
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const res = await listAppointments({ facilityId, providerId, dateFrom: from, dateTo: to, limit: 100, ...(cursor ? { cursor } : {}) })
      const data = res.data as { items: AppointmentSummary[]; nextCursor?: string | null }
      for (const a of data.items) {
        if (a.status === 'cancelled') continue
        const day = isoDay(clinicDate(a.startAt))
        counts.set(day, (counts.get(day) ?? 0) + 1)
      }
      cursor = data.nextCursor ?? undefined
      if (!cursor) break
    }
    return counts
  })
}
