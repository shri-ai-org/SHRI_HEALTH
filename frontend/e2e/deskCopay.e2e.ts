import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { nextSlotToday } from './nextSlot'

// Demo step 11's copay against the real API, on the front office's check-out sheet: the desk
// records the copay (cash, or check with its number), and the receipt PDF made in the same step
// opens from a one-time link (D104, D105). Setup through the root app's dev server, as the front
// desk: register, book today and check in a synthetic patient. Synthetic patients only.

const DESK_URL = 'http://localhost:5192'
const surname = () =>
  `Testcopay${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`

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

test('the desk records a cash copay and opens its receipt', async ({ page, request }) => {
  const appointment = await checkedInAppointment(request)
  await page.goto(`${DESK_URL}/patients/outpatients?flow=checkout&appointment=${appointment}`)
  const copay = page.getByTestId('copay')
  await expect(copay).toBeVisible({ timeout: 15_000 })
  await copay.getByLabel('Amount ($)').fill('25')
  await copay.getByLabel('Paid by').selectOption('cash')
  await copay.getByRole('button', { name: 'Record copay' }).click()
  await expect(page.getByTestId('copay-paid')).toHaveText('Copay paid · $25.00 · Cash')
  // The receipt opens from a one-time link to our own API (D105), never the object store. The
  // file is served as an attachment, so the link is checked where the API hands it over.
  const [link] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/download-url')),
    copay.getByRole('button', { name: 'Open receipt' }).click(),
  ])
  expect(link.status()).toBe(200)
  expect(((await link.json()) as { url: string }).url).toContain('/api/v1/files/')
})

test('a check needs its number, and a bad amount is refused before any request', async ({ page, request }) => {
  const appointment = await checkedInAppointment(request)
  const payments: string[] = []
  page.on('request', (r) => { if (r.url().includes('/payments') && r.method() === 'POST') payments.push(r.url()) })
  await page.goto(`${DESK_URL}/patients/outpatients?flow=checkout&appointment=${appointment}`)
  const copay = page.getByTestId('copay')
  await expect(copay).toBeVisible({ timeout: 15_000 })
  await copay.getByLabel('Amount ($)').fill('twenty')
  await copay.getByRole('button', { name: 'Record copay' }).click()
  await expect(copay.getByRole('alert')).toContainText('Enter the amount in dollars')
  await copay.getByLabel('Amount ($)').fill('30.5')
  await copay.getByLabel('Paid by').selectOption('check')
  await copay.getByRole('button', { name: 'Record copay' }).click()
  await expect(copay.getByRole('alert')).toContainText('Enter the check number')
  expect(payments).toEqual([])
  await copay.getByLabel('Check number').fill('1042')
  await copay.getByRole('button', { name: 'Record copay' }).click()
  await expect(page.getByTestId('copay-paid')).toHaveText('Copay paid · $30.50 · Check')
  expect(payments).toHaveLength(1)
})
