import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { frontOfficePort } from '../playwright.config'

// M10 (RUN_CHECK 29): booking no longer happens in one tap, always as "Annual physical" with no
// reason. With the real API the desk chooses the time, then the visit type and the reason, and
// books with "Book appointment"; the appointment carries that type and reason. Setup through the
// API as the front desk: a new synthetic patient. Synthetic data only.

const DESK = `http://localhost:${frontOfficePort}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

interface Booked { items: { appointmentType?: { id: string; name?: string }; appointmentTypeId?: string; reasonForVisit?: string }[] }

test('the desk books with a chosen visit type and reason, not in one tap', async ({ page, request }) => {
  const family = `Testbook${randomInt(100000, 999999)}`
  const patient = await ok<{ id: string }>(await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family, given: ['Harper'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  }), 201)
  const types = (await ok<{ items: { id: string; name: string; telehealth?: boolean }[] }>(await request.get('/api/v1/booking/appointment-types'))).items.filter((t) => !t.telehealth)
  test.skip(types.length < 2, 'needs two in-person visit types')
  const wanted = types[1]

  await page.goto(`${DESK}/patients/outpatients?flow=schedule`)
  await page.getByRole('combobox').first().fill(family)
  await page.getByRole('option', { name: new RegExp(family) }).first().click()

  // A time is chosen (the soonest), but nothing is booked until Book appointment.
  const book = page.getByRole('button', { name: 'Book appointment' })
  await expect(book).toBeVisible({ timeout: 30_000 })
  const before = await ok<Booked>(await request.get('/api/v1/appointments', { params: { patientId: patient.id, dateFrom: new Date().toISOString().slice(0, 10), dateTo: new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10) } }))
  expect(before.items).toEqual([])

  await page.getByLabel('Visit type').selectOption(wanted.id)
  await page.getByLabel('Reason for the visit').fill('Cough for a week')
  await book.click()
  await expect(book).toHaveCount(0, { timeout: 15_000 })

  const after = await ok<Booked>(await request.get('/api/v1/appointments', { params: { patientId: patient.id, dateFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), dateTo: new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10) } }))
  expect(after.items).toHaveLength(1)
  const [appt] = after.items
  expect(appt.appointmentType?.id ?? appt.appointmentTypeId).toBe(wanted.id)
  expect(appt.reasonForVisit).toBe('Cough for a week')
})
