import { randomInt, randomUUID } from 'node:crypto'
import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test'

import { nextSlotToday } from './nextSlot'
import { doctorsPort } from '../playwright.config'

// Item 5 of the demo plan (D119): the consultation note's AI visit summary (createVisitSummary,
// decideVisitSummary, #406) and ICD-10-CM chips (createCodingSuggestion, decideSuggestedCode, #404)
// on the real API, with no stub: the front desk registers, books and checks in a synthetic patient,
// then the development physician (md) opens the note. Nothing is accepted by default; a rejected
// chip goes; an accepted summary lands at the top of the note. Skips while the API has no AI
// endpoints (a stack built before #404 and #406). With AI off for the clinic, the blocks say so
// in one plain line. Synthetic data only.

const DOCTORS = `http://localhost:${doctorsPort}`
const surname = () => `Testsum${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as T
}

/** True when the API serves the AI blocks: an empty body is refused as invalid (422), not unknown (404). */
async function aiBlocksServed(): Promise<boolean> {
  const doctor = await apiRequest.newContext({ baseURL: DOCTORS })
  try {
    const summaries = await doctor.post('/api/v1/ai/visit-summaries', { headers: { 'Idempotency-Key': randomUUID() }, data: {} })
    const codes = await doctor.post('/api/v1/ai/coding-suggestions', { headers: { 'Idempotency-Key': randomUUID() }, data: {} })
    return summaries.status() !== 404 && codes.status() !== 404
  } finally {
    await doctor.dispose()
  }
}

/** Register, book the next free slot today and check in, as the front desk: the visit and its patient. */
async function checkedInVisit(desk: APIRequestContext): Promise<{ encounterId: string; patientId: string }> {
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
    data: { patientId: patient.id, providerId: slot.providerId, facilityId: facility.id, appointmentTypeId, startAt: slot.startAt, ...(slot.overbook ? { overbook: true } : {}) },
  }), 201)
  const checkIn = await ok<{ encounterId: string }>(await desk.post(`/api/v1/appointments/${appointment.id}/check-in`,
    { headers: { 'Idempotency-Key': randomUUID() }, data: { selfPay: true } }))
  return { encounterId: checkIn.encounterId, patientId: patient.id }
}

test('the AI visit summary and ICD-10 chips: asked for, labelled, nothing applied until the doctor decides', async ({ page, request }) => {
  test.skip(!(await aiBlocksServed()), 'The API has no visit-summary or coding-suggestion endpoints yet (a stack built before PR 404 and PR 406)')
  test.setTimeout(120_000)
  const { encounterId } = await checkedInVisit(request)
  await page.goto(`${DOCTORS}/encounter/${encounterId}/note`)

  // The summary block, at the top of the note.
  await page.getByRole('button', { name: 'Summarize this visit' }).click()
  const off = page.getByText('AI suggestions are turned off')
  const failed = page.getByText("The AI summary couldn't be prepared. Try again.")
  const decision = page.getByRole('group', { name: 'Decision for the AI visit summary' })
  await expect(decision.or(off).or(failed).first()).toBeVisible({ timeout: 60_000 })
  test.skip(await off.isVisible(), 'AI is turned off for this clinic: the block shows one plain line, as it should')
  test.skip(await failed.isVisible(), 'The AI service could not prepare a summary on this stack')

  await expect(page.getByRole('region', { name: 'AI visit summary' })).toBeVisible()
  await expect(page.getByText(/^AI-generated · /).first()).toBeVisible()
  // Nothing is in the note until the doctor accepts: then the summary is at the top of the first section.
  const subjective = page.getByRole('textbox', { name: /Subjective/ })
  const before = await subjective.inputValue()
  await decision.getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByText('Accepted. The summary is at the top of the note.')).toBeVisible({ timeout: 30_000 })
  await expect(decision).toHaveCount(0)
  await expect.poll(async () => (await subjective.inputValue()).length).toBeGreaterThan(before.length)

  // The ICD-10 chips, under the Assessment: none accepted by default; a rejected chip goes.
  await page.getByRole('button', { name: 'Suggest ICD-10 codes' }).click()
  const chips = page.getByRole('list', { name: 'Suggested ICD-10-CM codes' })
  await expect(chips.or(page.getByText(/Not enough in this visit yet to suggest a code\./)).first()).toBeVisible({ timeout: 60_000 })
  test.skip(!(await chips.isVisible()), 'The AI suggested no code for this visit')
  await expect(page.getByText(/Accepted\. Added to the visit/)).toHaveCount(0)
  const count = await chips.getByRole('listitem').count()
  await chips.getByRole('listitem').first().getByRole('button', { name: 'Reject' }).click()
  await page.getByRole('button', { name: 'Record rejection' }).click()
  await expect(chips.getByRole('listitem')).toHaveCount(count - 1, { timeout: 30_000 })
})
