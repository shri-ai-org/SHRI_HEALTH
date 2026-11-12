import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test'

import { portalPort } from '../playwright.config'

// Patient self-booking on the real API (D108, #288): the portal's Schedule page books a free time,
// a taken time reads the free times again, then the patient reschedules and cancels. The portal
// runs as SHRI_E2E_PORTAL_PATIENT, a synthetic patient whose clinic books online (the preview's
// seed patient); without it these tests skip. Each run cancels what it books. Synthetic data only.

const BASE = `http://localhost:${portalPort}`
const PORTAL = `${BASE}/portal`

test.skip(!process.env.SHRI_E2E_PORTAL_PATIENT, 'needs SHRI_E2E_PORTAL_PATIENT: a portal patient whose clinic books online')

interface Choice {
  facilityId: string
  typeId: string
  providerId: string
  day: string
  slots: { startAt: string; providerId: string }[]
}

async function json<T>(api: APIRequestContext, path: string): Promise<T> {
  const res = await api.get(`/api/v1${path}`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as T
}

/** The first bookable location, type and provider with at least three free times on one day. */
async function bookable(api: APIRequestContext): Promise<Choice> {
  const facilities = await json<{ items: { id: string }[] }>(api, '/portal/booking/facilities')
  for (const f of facilities.items) {
    const types = await json<{ items: { id: string }[] }>(api, `/portal/booking/appointment-types?facilityId=${f.id}`)
    for (const t of types.items) {
      for (let d = 2; d < 30; d++) {
        const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
        const slots = await json<{ items: { startAt: string; providerId: string }[] }>(
          api, `/portal/me/slots?facilityId=${f.id}&appointmentTypeId=${t.id}&date=${day}`)
        const providerId = slots.items[0]?.providerId
        const own = slots.items.filter((s) => s.providerId === providerId)
        if (providerId && own.length >= 3) return { facilityId: f.id, typeId: t.id, providerId, day, slots: own }
      }
    }
  }
  throw new Error('No location, type and day with three free times: is online booking on for the clinic?')
}

const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`

async function pickTime(page: Page, day: string) {
  await page.getByLabel(/Appointment preferred date/).fill(usDate(day))
  await page.getByRole('button', { name: /Preferred time/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Select preferred timing' })
  await dialog.locator('button[aria-pressed]').first().click()
  await expect(dialog).toHaveCount(0)
}

test('a patient books, meets a taken time, reschedules and cancels online', async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: BASE })
  const choice = await bookable(api)

  // Book: a taken time first (409 once), which reads the free times again; then the booking.
  let slotReads = 0
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/portal/me/slots')) slotReads++
  })
  let conflictOnce = true
  await page.route('**/api/v1/portal/me/appointments', async (route) => {
    if (route.request().method() === 'POST' && conflictOnce) {
      conflictOnce = false
      return route.fulfill({ status: 409, contentType: 'application/problem+json',
                            body: JSON.stringify({ type: 'about:blank', title: 'Conflict', status: 409, code: 'booking-conflict' }) })
    }
    return route.fallback()
  })
  await page.goto(`${PORTAL}/appointments/schedule`)
  await page.getByLabel(/Select a location/).selectOption(choice.facilityId)
  await page.getByLabel(/Select appointment type/).selectOption(choice.typeId)
  await page.getByLabel(/Select reason for visit/).selectOption('follow-up')
  await page.getByLabel(/Your providers/).selectOption(choice.providerId)
  await pickTime(page, choice.day)
  await page.getByRole('button', { name: 'Schedule', exact: true }).click()
  await expect(page.getByText('That time was just taken')).toBeVisible()
  const before = slotReads
  await pickTime(page, choice.day)
  expect(slotReads).toBeGreaterThan(before)
  await page.getByRole('button', { name: 'Schedule', exact: true }).click()
  await expect(page.getByText(/Appointment is scheduled successfully/)).toBeVisible()

  const upcoming = await json<{ items: { id: string; status: string; startAt: string; reasonCode?: string }[] }>(api, '/portal/me/appointments?when=upcoming')
  const mine = upcoming.items.filter((a) => a.status === 'booked' && choice.slots.some((s) => s.startAt === a.startAt))
  expect(mine).toHaveLength(1)
  expect(mine[0].reasonCode).toBe('follow-up')

  // Reschedule to another free time that day.
  await page.goto(`${PORTAL}/appointments/${mine[0].id}`)
  await page.getByRole('button', { name: 'Reschedule Appointment' }).click()
  await pickTime(page, choice.day)
  await page.getByRole('button', { name: 'Schedule', exact: true }).click()
  await expect(page.getByText(/Appointment is rescheduled successfully/)).toBeVisible()
  const after = await json<{ items: { id: string; status: string; startAt: string }[] }>(api, '/portal/me/appointments?when=upcoming')
  const moved = after.items.filter((a) => a.status === 'booked' && choice.slots.some((s) => s.startAt === a.startAt) && a.id !== mine[0].id)
  expect(moved).toHaveLength(1)

  // Cancel it, with a reason.
  await page.goto(`${PORTAL}/appointments/${moved[0].id}`)
  await page.getByRole('button', { name: 'Cancel Appointment' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cancel this appointment?' })
  await dialog.getByRole('textbox').fill('Feeling better.')
  await dialog.getByRole('button', { name: 'Cancel appointment' }).click()
  await expect(page.getByText('Your appointment is canceled')).toBeVisible()
  const gone = await json<{ status: string }>(api, `/portal/me/appointments/${moved[0].id}`)
  expect(gone.status).toBe('cancelled')
  await api.dispose()
})
