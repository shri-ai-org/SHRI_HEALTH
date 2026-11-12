import { randomInt, randomUUID } from 'node:crypto'
import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test'

import { nextSlotToday } from './nextSlot'

// Demo step 10 against the real API: the doctor asks for a revisit on a checked-in visit, changes
// it, and withdraws it, on the doctors' portal (S-06-19, /encounter/:id/follow-up). The front desk
// (the root app's dev server, `request`) registers, books and checks in a synthetic patient first;
// the doctors' portal's dev server signs in as the development physician (playwright.config.ts).
// Synthetic patients only.

const DOCTORS_URL = 'http://localhost:5191'
const surname = () =>
  `Testfollowup${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

/** Register, book the next free slot today and check in, as the front desk: the encounter's ID. */
async function checkedInVisit(desk: APIRequestContext): Promise<string> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: surname(), given: ['Rowan'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  }), 201)
  const facilities = await ok<{ items: { id: string; timeZone: string }[] }>(await desk.get('/api/v1/booking/facilities'))
  const facility = facilities.items[0]
  const types = await ok<{ items: { id: string }[] }>(await desk.get('/api/v1/booking/appointment-types'))
  const appointmentTypeId = types.items[0].id
  const slot = await nextSlotToday(desk, facility, appointmentTypeId)
  const appointment = await ok<{ id: string }>(await desk.post('/api/v1/appointments', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { patientId: patient.id, providerId: slot.providerId, facilityId: facility.id,
            appointmentTypeId, startAt: slot.startAt, ...(slot.overbook ? { overbook: true } : {}) },
  }), 201)
  const checkIn = await ok<{ encounterId: string }>(await desk.post(
    `/api/v1/appointments/${appointment.id}/check-in`,
    { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))
  return checkIn.encounterId
}

test('the doctor asks for a revisit, changes it and withdraws it', async ({ page, request }) => {
  const encounter = await checkedInVisit(request)
  await page.goto(`${DOCTORS_URL}/encounter/${encounter}/follow-up`)
  await expect(page.getByTestId('fu-status')).toHaveText('No revisit asked for yet.')

  // Ask: 2 weeks.
  const form = page.getByRole('form', { name: 'Follow-up' })
  await form.getByRole('spinbutton').fill('2')
  await form.getByRole('combobox').first().selectOption('week')
  await form.getByLabel('Note for the front desk (optional)').fill('Recheck blood pressure.')
  await form.getByRole('button', { name: 'Ask for a follow-up' }).click()
  await expect(page.getByTestId('fu-notice')).toContainText('Follow-up saved')
  await expect(page.getByTestId('fu-status')).toContainText('2 weeks')
  await expect(page.getByTestId('fu-status')).toContainText('Asked for')

  // The API agrees, as the desk reads it at check-out.
  const doctor = await apiRequest.newContext({ baseURL: DOCTORS_URL })
  const read = await ok<{ followUp: { interval: { value: number; unit: string }; note: string; status: string } }>(
    await doctor.get(`/api/v1/encounters/${encounter}`))
  expect(read.followUp).toMatchObject({ interval: { value: 2, unit: 'week' }, note: 'Recheck blood pressure.', status: 'open' })

  // Change it to 1 month.
  await form.getByRole('spinbutton').fill('1')
  await form.getByRole('combobox').first().selectOption('month')
  await form.getByRole('button', { name: 'Change the follow-up' }).click()
  await expect(page.getByTestId('fu-status')).toContainText('1 month')

  // Withdraw it, with a reason.
  const withdraw = page.getByRole('form', { name: 'Withdraw' })
  await withdraw.getByLabel('Reason for withdrawing').fill('Patient moving out of state.')
  await withdraw.getByRole('button', { name: 'Withdraw' }).click()
  await expect(page.getByTestId('fu-status')).toContainText('Withdrawn.')
  await expect(page.getByRole('form', { name: 'Follow-up' })).toHaveCount(0)
  await doctor.dispose()
})

test('a stale page is told the visit changed, and shows the current request', async ({ page, request }) => {
  const encounter = await checkedInVisit(request)
  await page.goto(`${DOCTORS_URL}/encounter/${encounter}/follow-up`)
  await expect(page.getByTestId('fu-status')).toHaveText('No revisit asked for yet.')
  // Someone else (another tab) asks for 3 days meanwhile.
  const doctor = await apiRequest.newContext({ baseURL: DOCTORS_URL })
  const res = await doctor.get(`/api/v1/encounters/${encounter}`)
  const etag = res.headers()['etag']
  const put = await doctor.put(`/api/v1/encounters/${encounter}/follow-up`, {
    headers: { 'If-Match': etag }, data: { interval: { value: 3, unit: 'day' } } })
  expect(put.status(), await put.text()).toBe(200)
  // This page's If-Match is now stale: 412, then it reads the visit again.
  const form = page.getByRole('form', { name: 'Follow-up' })
  await form.getByRole('spinbutton').fill('2')
  await form.getByRole('button', { name: 'Ask for a follow-up' }).click()
  await expect(page.getByTestId('fu-notice')).toContainText('Someone changed this visit')
  await expect(page.getByTestId('fu-status')).toContainText('3 days')
  await doctor.dispose()
})

test('the front desk cannot ask for a follow-up (403)', async ({ request }) => {
  const encounter = await checkedInVisit(request)
  const res = await request.get(`/api/v1/encounters/${encounter}`)
  const put = await request.put(`/api/v1/encounters/${encounter}/follow-up`, {
    headers: { 'If-Match': res.headers()['etag'] ?? '"0"' }, data: { interval: { value: 2, unit: 'week' } } })
  expect([403]).toContain(put.status())
})

test('a link that is not a visit ID makes no request', async ({ page }) => {
  const calls: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/v1/encounters')) calls.push(r.url()) })
  await page.goto(`${DOCTORS_URL}/encounter/..%2F..%2Fpatients%2Fsearch/follow-up`)
  await expect(page.getByRole('alert')).toContainText('This link does not name a visit.')
  expect(calls).toEqual([])
})
