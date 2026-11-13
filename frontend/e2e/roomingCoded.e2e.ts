import { randomInt, randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort, frontOfficeMaPort } from '../playwright.config'
import { nextSlotToday } from './nextSlot'

// M3 (RUN_CHECK 23): rooming records allergies and medications coded in RxNorm, so a live
// patient's prescription gets its alerts. The medical assistant picks "Amoxicillin" and an
// oxycodone product from the drug list on the rooming sheet; the doctor's amoxicillin draft then
// gets the allergy alert and a Roxicodone (oxycodone) draft the duplicate-medication alert (fixed
// rules, D99). Drugs in the preview's RxNorm fixture and in the full release alike.
// A free-text allergy is kept but raises nothing, and the sheet says so. Setup through the API as
// the front desk: a new synthetic patient, booked today and checked in. Synthetic data only.

const ROOMING = `http://localhost:${frontOfficeMaPort}`
const DOCTOR = `http://localhost:${doctorsPort}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

async function checkedIn(desk: APIRequestContext): Promise<{ patientId: string; appointmentId: string; encounterId: string }> {
  const patient = await ok<{ id: string }>(await desk.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testroom${randomInt(100000, 999999)}`, given: ['Harper'] }, birthDate: `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
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
  return { patientId: patient.id, appointmentId: appointment.id, encounterId: checkIn.encounterId }
}

/** The doctor's draft of the first RxNorm product matching `q`, then its safety check's alert kinds. */
async function alertsFor(md: APIRequestContext, visit: { patientId: string; encounterId: string }, q: string): Promise<string[]> {
  const drug = (await ok<{ items: { system: string; code: string; display: string }[] }>(await md.get('/api/v1/codes', { params: { system: 'rxnorm', q, limit: 1 } }))).items[0]
  const rx = await ok<{ id: string }>(await md.post('/api/v1/prescriptions', {
    data: { patientId: visit.patientId, encounterId: visit.encounterId, medication: { codings: [{ system: drug.system, code: drug.code, display: drug.display }], text: drug.display } },
  }), 201)
  const checked = await ok<{ alerts: { kind: string }[] }>(await md.post(`/api/v1/prescriptions/${rx.id}/safety-check`, { headers: { 'Idempotency-Key': randomUUID() } }))
  return checked.alerts.map((a) => a.kind)
}

test('rooming records coded allergies and medications, so prescribing raises its alerts', async ({ page, request }) => {
  const visit = await checkedIn(request)
  await page.goto(`${ROOMING}/patients/outpatients?flow=rooming&appointment=${visit.appointmentId}`)
  const allergies = page.locator('#rooming-allergies')
  await expect(allergies).toContainText("doesn't trigger prescribing alerts")

  // The allergy, picked from the drug list as an ingredient.
  await page.locator('#rooming-allergy').fill('amoxicillin')
  await page.getByRole('button', { name: 'Find add an allergy' }).click()
  const match = page.locator('#rooming-allergy-match')
  await expect(match).toBeVisible({ timeout: 30_000 })
  await expect(match.locator('option:checked')).toHaveText(/^amoxicillin$/i)
  await allergies.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(allergies.getByRole('listitem').filter({ hasText: /^amoxicillin$/i })).toBeVisible()

  // A medication, picked from the drug list.
  const meds = page.locator('#rooming-medications')
  await page.locator('#rooming-med').fill('oxycodone')
  await page.getByRole('button', { name: 'Find add a medication' }).click()
  await expect(page.locator('#rooming-med-match')).toBeVisible({ timeout: 30_000 })
  await meds.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(meds.getByRole('listitem').filter({ hasText: /oxycodone/i })).toBeVisible()

  const md = await playwrightRequest.newContext({ baseURL: DOCTOR })
  try {
    // What the API recorded: the allergy coded in RxNorm (read as the doctor).
    const chart = await ok<{ items: { code: { codings?: { system: string }[] } }[] }>(await md.get(`/api/v1/patients/${visit.patientId}/allergies`))
    expect(chart.items.some((a) => a.code.codings?.some((c) => c.system.endsWith('/rxnorm')))).toBe(true)
    // The rule: the doctor's drafts get the allergy and the duplicate-medication alerts.
    expect(await alertsFor(md, visit, 'amoxicillin 500')).toContain('allergy')
    expect(await alertsFor(md, visit, 'roxicodone')).toContain('duplicate-medication')
  } finally {
    await md.dispose()
  }
})

test('a free-text allergy is kept, and the sheet says it raises no alert', async ({ page, request }) => {
  const visit = await checkedIn(request)
  await page.goto(`${ROOMING}/patients/outpatients?flow=rooming&appointment=${visit.appointmentId}`)
  const allergies = page.locator('#rooming-allergies')
  await page.locator('#rooming-allergy').fill('cat dander')
  await page.getByRole('button', { name: 'Find add an allergy' }).click()
  await expect(allergies).toContainText(/No match in the drug list|None of these/, { timeout: 30_000 })
  if (await page.locator('#rooming-allergy-match').count()) await page.locator('#rooming-allergy-match').selectOption('')
  await expect(allergies.locator('p.text-warning')).toContainText("doesn't trigger prescribing alerts")
  await allergies.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(allergies.getByRole('listitem').filter({ hasText: 'cat dander' })).toBeVisible()
})
