import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'
import { nextSlotToday } from './nextSlot'

// M8 (RUN_CHECK 27): the note's ICD-10 code survives a reload, so Sign isn't disabled again. A code
// picked from the index is added to the visit's diagnoses (the contract codes the encounter, not
// the note) and comes back after the reload. Setup through the API as the front desk: a new
// synthetic patient booked today and checked in. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

async function checkedInVisit(desk: APIRequestContext): Promise<string> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testicd${randomInt(100000, 999999)}`, given: ['Emery'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
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

test("the note's ICD-10 code comes back after a reload, so Sign stays possible", async ({ page, request }) => {
  const encounterId = await checkedInVisit(request)
  await page.goto(`${DOCTORS}/encounter/${encounterId}/note`)
  for (const [section, text] of [['Subjective', 'Headache for three days.'], ['Objective', 'BP 152/94.'],
                                 ['Assessment', 'Hypertension.'], ['Plan', 'Start treatment; recheck in two weeks.']]) {
    await page.getByPlaceholder(`Type the ${section.toLowerCase()}, or press the microphone…`).fill(text)
  }
  await page.getByRole('combobox', { name: 'Search ICD-10' }).fill('hypertension')
  await page.getByRole('option', { disabled: false }).first().click({ timeout: 15_000 })
  const coded = page.getByText(/^Coded [A-Z][0-9]/).first()
  await expect(coded).toBeVisible()
  const code = (await coded.innerText()).match(/Coded ([A-Z][0-9A-Z.]+)/)?.[1]
  expect(code).toBeTruthy()
  // The code is the visit's diagnosis on the server (read through the encounter).
  await expect.poll(async () => {
    const e = await (await request.get(`${DOCTORS}/api/v1/encounters/${encounterId}`)).json() as { diagnoses?: { code: { code: string }; verificationStatus: string }[] }
    return (e.diagnoses ?? []).filter((d) => d.verificationStatus !== 'entered-in-error').map((d) => d.code.code)
  }, { timeout: 15_000 }).toContain(code)
  // Let the sections' saves finish, then reload: the code is back and Sign isn't blocked by it.
  await page.waitForLoadState('networkidle')
  await page.reload()
  await expect(page.getByText(new RegExp(`^Coded ${code!.replace('.', '\\.')}`)).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('ICD-10 code needed')).toHaveCount(0)
})
