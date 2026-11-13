import { randomInt, randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import { frontOfficePort } from '../playwright.config'
import { nextSlotToday } from './nextSlot'

// Demo step 11 on the front office: a roomed visit can be checked out from Outpatients. No screen
// records "with provider" (the doctor goes straight to the visit), and the API checks out any
// checked-in visit (D98), so the row must offer Check out once the patient is roomed. Setup through
// the API: the front desk registers, books and checks in; the medical assistant rooms. Synthetic
// patients only.

const DESK = `http://localhost:${frontOfficePort}`
const surname = () => `Testroom${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

test('a roomed visit offers Check out on Outpatients, and the sheet opens', async ({ page, request }) => {
  const family = surname()
  const patient = await ok<{ id: string }>(await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family, given: ['Avery'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  }), 201)
  const facility = (await ok<{ items: { id: string; timeZone: string }[] }>(await request.get('/api/v1/booking/facilities'))).items[0]
  const typeId = (await ok<{ items: { id: string }[] }>(await request.get('/api/v1/booking/appointment-types'))).items[0].id
  const slot = await nextSlotToday(request, facility, typeId)
  const appointment = await ok<{ id: string }>(await request.post('/api/v1/appointments', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { patientId: patient.id, providerId: slot.providerId, facilityId: facility.id, appointmentTypeId: typeId, startAt: slot.startAt, ...(slot.overbook ? { overbook: true } : {}) },
  }), 201)
  await ok(await request.post(`/api/v1/appointments/${appointment.id}/check-in`, { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))

  // The medical assistant rooms the patient, straight against the API (development sign-in).
  const ma = await playwrightRequest.newContext({
    baseURL: process.env.SHRI_API_URL ?? 'https://localhost:8443', ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Dev-User': 'ma' },
  })
  const rooms = await ok<{ items: { id: string }[] }>(await ma.get('/api/v1/booking/locations', { params: { facilityId: facility.id } }))
  await ok(await ma.post(`/api/v1/appointments/${appointment.id}/status`, {
    headers: { 'Idempotency-Key': randomUUID() }, data: { status: 'roomed', roomLocationId: rooms.items[0].id },
  }))
  await ma.dispose()

  await page.goto(`${DESK}/patients/outpatients`)
  const row = page.getByRole('listitem').filter({ hasText: family })
  await expect(row.getByText('Roomed')).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: 'Check out' }).click()
  await expect(page.getByRole('dialog').getByText('Check out').first()).toBeVisible()
})
