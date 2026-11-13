import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'
import { nextSlotToday } from './nextSlot'

// Demo steps 8 and 11: signing the note on the doctors' portal also makes the after-visit summary
// (createAfterVisitSummary), so the front desk can print it at check-out. Setup through the API as
// the front desk: a new synthetic patient booked today and checked in. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

async function checkedInVisit(desk: APIRequestContext): Promise<string> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testavs${randomInt(100000, 999999)}`, given: ['Emery'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
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

test('signing the note makes the after-visit summary for the front desk', async ({ page, request }) => {
  const encounterId = await checkedInVisit(request)
  await page.goto(`${DOCTORS}/encounter/${encounterId}/note`)
  for (const [section, text] of [['Subjective', 'Sore throat for two days.'], ['Objective', 'Pharynx red, no exudate.'],
                                 ['Assessment', 'Viral pharyngitis.'], ['Plan', 'Fluids and rest; return if worse.']]) {
    await page.getByPlaceholder(`Type the ${section.toLowerCase()}, or press the microphone…`).fill(text)
  }
  // The visit's ICD-10 code, from the code index (any billable match).
  await page.getByRole('combobox', { name: 'Search ICD-10' }).fill('hypertension')
  await page.getByRole('option').first().click({ timeout: 15_000 })
  await expect(page.getByText('ICD-10 code needed')).toHaveCount(0)
  const avs = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/encounters/${encounterId}/after-visit-summary`), { timeout: 20_000 })
  await page.getByRole('button', { name: 'Sign', exact: true }).click()
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: /^Sign/ })
  if (await confirm.count()) await confirm.click()
  await avs
  // The desk's print link now finds a summary (once the background job finishes).
  await expect.poll(async () => (await request.get(`/api/v1/encounters/${encounterId}/after-visit-summary/download-url`)).status(),
    { timeout: 30_000 }).toBe(200)
})
