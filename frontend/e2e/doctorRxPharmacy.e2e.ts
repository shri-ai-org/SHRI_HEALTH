import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'
import { nextSlotToday } from './nextSlot'

// Demo step 9 on the doctors' portal: choosing the pharmacy changes the prescription, so its last
// safety check is stale; the screen checks again on the saved version, and Sign is not refused
// with safety-check-stale. Setup through the API as the front desk: a new synthetic patient with
// no allergies, booked today and checked in. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

async function checkedInVisit(desk: APIRequestContext): Promise<string> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testrx${randomInt(100000, 999999)}`, given: ['Harper'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  }), 201)
  const facility = (await ok<{ items: { id: string; timeZone: string }[] }>(await desk.get('/api/v1/booking/facilities'))).items[0]
  const typeId = (await ok<{ items: { id: string }[] }>(await desk.get('/api/v1/booking/appointment-types'))).items[0].id
  const slot = await nextSlotToday(desk, facility, typeId)
  const appointment = await ok<{ id: string }>(await desk.post('/api/v1/appointments', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { patientId: patient.id, providerId: slot.providerId, facilityId: facility.id, appointmentTypeId: typeId, startAt: slot.startAt, ...(slot.overbook ? { overbook: true } : {}) },
  }), 201)
  const checkIn = await ok<{ encounterId: string }>(await desk.post(`/api/v1/appointments/${appointment.id}/check-in`,
    { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))
  return checkIn.encounterId
}

test('choosing the pharmacy checks the prescription again, and Sign goes through', async ({ page, request }) => {
  const encounterId = await checkedInVisit(request)
  await page.goto(`${DOCTORS}/encounter/${encounterId}/rx`)
  await page.getByLabel('Search the formulary').fill('amoxicillin')
  await expect(page.getByLabel('Formulary matches').getByRole('button').first()).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Formulary matches').getByRole('button').first().click()

  // Complete the line: route and frequency, duration and quantity.
  await page.getByRole('textbox', { name: 'Dose (required)' }).fill('500 mg')
  await page.getByRole('combobox', { name: 'Route & frequency (required)' }).selectOption({ label: 'Oral · once daily' })
  await page.getByRole('combobox', { name: 'Duration (required)' }).selectOption({ label: '7 days' })
  await page.getByRole('textbox', { name: 'Quantity (required)' }).fill('7')
  await expect(page.getByText('1 incomplete')).toHaveCount(0, { timeout: 15_000 })
  // Let the line's own save and check finish first: the pharmacy is the last change before Sign.
  await page.waitForTimeout(2_000)
  await page.waitForLoadState('networkidle')

  // The pharmacy, chosen (again) from the directory: the change saves, then the check runs again.
  if (await page.getByRole('button', { name: 'Change' }).count()) await page.getByRole('button', { name: 'Change' }).click()
  await page.getByPlaceholder('Pharmacy name, or ZIP such as 62704').fill('Demo')
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/v1/prescriptions/'))
  await page.getByRole('button', { name: /Demo Pharmacy/ }).first().click()
  expect((await saved).status()).toBe(200)
  // The check runs again on the version just saved.
  await page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/safety-check'), { timeout: 10_000 })
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: 'Sign prescription' }).click()
  const signed = page.waitForResponse((r) => r.url().endsWith('/sign-and-send'))
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign prescription' }).click()
  const res = await signed
  expect(res.status(), await res.text()).toBe(200)
  await expect(page.getByText('Prescription signed')).toBeVisible()
})
