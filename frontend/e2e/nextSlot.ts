import { expect, test, type APIRequestContext } from '@playwright/test'

// The next bookable time today at a facility, for tests that need a visit checked in today. The
// demo providers are bookable all day (#293), so a day's slots run to several pages: every page
// is read until the first free time after now. When none is free (a busy preview), an overbook
// slot is used, booked with `overbook: true`. In the clinic day's last minutes no visit fits
// before the providers' 23:59 (check-in needs today's visit), so the test is skipped, saying
// why, rather than failing. Synthetic data only.

export interface TodaySlot {
  providerId: string
  startAt: string
  overbook: boolean
}

export async function nextSlotToday(desk: APIRequestContext, facility: { id: string; timeZone: string }, appointmentTypeId: string): Promise<TodaySlot> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: facility.timeZone }).format(new Date())
  const after = Date.now() + 60_000
  let cursor: string | undefined
  let overbook: TodaySlot | undefined
  do {
    const res = await desk.get('/api/v1/slots', {
      params: { date: today, facilityId: facility.id, appointmentTypeId, limit: 100, ...(cursor ? { cursor } : {}) },
    })
    expect(res.status(), await res.text()).toBe(200)
    const page = (await res.json()) as { items: { providerId: string; startAt: string; overbook?: boolean }[]; nextCursor?: string }
    const later = page.items.filter((s) => Date.parse(s.startAt) > after)
    const free = later.find((s) => !s.overbook)
    if (free) return { providerId: free.providerId, startAt: free.startAt, overbook: false }
    const over = later.find((s) => s.overbook)
    if (!overbook && over) overbook = { providerId: over.providerId, startAt: over.startAt, overbook: true }
    cursor = page.nextCursor
  } while (cursor)
  test.skip(!overbook, `No bookable time is left today (${today}, ${facility.timeZone}): run after midnight there`)
  return overbook!
}
