import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { nextSlotToday } from './nextSlot'

// M11, the screen's part: the copay is taken once. A double click sends one request; a retry after
// a dropped connection sends the same Idempotency-Key; a second copay for the visit (the server's
// 409, #344/#348) shows a clear message and the paid state. Setup through the API as the front
// desk: register, book today and check in a synthetic patient. Synthetic patients only.

const DESK_URL = 'http://localhost:5192'
const surname = () =>
  `Testonce${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

async function checkedInAppointment(desk: APIRequestContext): Promise<string> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: surname(), given: ['Jordan'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  }), 201)
  const facility = (await ok<{ items: { id: string; timeZone: string }[] }>(await desk.get('/api/v1/booking/facilities'))).items[0]
  const typeId = (await ok<{ items: { id: string }[] }>(await desk.get('/api/v1/booking/appointment-types'))).items[0].id
  const slot = await nextSlotToday(desk, facility, typeId)
  const appointment = await ok<{ id: string }>(await desk.post('/api/v1/appointments', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { patientId: patient.id, providerId: slot.providerId, facilityId: facility.id, appointmentTypeId: typeId, startAt: slot.startAt, ...(slot.overbook ? { overbook: true } : {}) },
  }), 201)
  await ok(await desk.post(`/api/v1/appointments/${appointment.id}/check-in`,
                           { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))
  return appointment.id
}

test('a double click records one copay, and a retry after a dropped connection reuses its key', async ({ page, request }) => {
  const appointment = await checkedInAppointment(request)
  const keys: string[] = []
  let drop = true
  // The first request never reaches the server (a dropped connection); the retry goes through.
  await page.route('**/api/v1/patients/*/payments', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '')
    if (drop) {
      drop = false
      return route.abort('connectionreset')
    }
    return route.fallback()
  })
  await page.goto(`${DESK_URL}/patients/outpatients?flow=checkout&appointment=${appointment}`)
  const copay = page.getByTestId('copay')
  await expect(copay).toBeVisible({ timeout: 15_000 })
  await copay.getByLabel('Amount ($)').fill('25')
  await copay.getByRole('button', { name: 'Record copay' }).dblclick()
  await expect(copay.getByRole('alert')).toContainText('Check the connection and try again')
  expect(keys).toHaveLength(1)
  await copay.getByRole('button', { name: 'Record copay' }).click()
  await expect(page.getByTestId('copay-paid')).toHaveText('Copay paid · $25.00 · Cash')
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
})

test('a second copay for the visit shows the server’s refusal and the paid state', async ({ page, request }) => {
  const appointment = await checkedInAppointment(request)
  await page.goto(`${DESK_URL}/patients/outpatients?flow=checkout&appointment=${appointment}`)
  const copay = page.getByTestId('copay')
  await expect(copay).toBeVisible({ timeout: 15_000 })
  await copay.getByLabel('Amount ($)').fill('25')
  await copay.getByRole('button', { name: 'Record copay' }).click()
  await expect(page.getByTestId('copay-paid')).toHaveText('Copay paid · $25.00 · Cash')
  // The sheet opened again: the server refuses a second copay, and the screen says so plainly.
  await page.reload()
  await expect(copay).toBeVisible({ timeout: 15_000 })
  await copay.getByLabel('Amount ($)').fill('25')
  const [second] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/payments') && r.request().method() === 'POST'),
    copay.getByRole('button', { name: 'Record copay' }).click(),
  ])
  expect(second.status()).toBe(409)
  await expect(page.getByTestId('copay-already')).toHaveText('Copay paid · already recorded for this visit')
  await expect(copay.getByRole('alert')).toContainText('A copay is already recorded for this visit')
  await expect(copay.getByRole('button', { name: 'Record copay' })).toHaveCount(0)
})
