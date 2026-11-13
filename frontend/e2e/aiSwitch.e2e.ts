import { randomInt, randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import { frontOfficeAdminPort, frontOfficePort } from '../playwright.config'

// D118: the clinic's AI switch in the front office's user menu (the administrator's place, no admin
// app yet). Switched off, the AI answers "AI is switched off" (409 feature-disabled); switched on, it
// works again. The front desk doesn't see the switch. Real API; the AI call itself is only accepted
// (202), so no model runs here. Synthetic data only.

test.describe.configure({ mode: 'serial' })

const ADMIN = `http://localhost:${frontOfficeAdminPort}`
const DESK = `http://localhost:${frontOfficePort}`
const SUMMARY = 'Chart summary, assistant, morning brief, differentials'

async function askTheChart(doctor: APIRequestContext, patientId: string): Promise<{ status: number; code?: string }> {
  const res = await doctor.post('/api/v1/ai/chart-questions', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { question: 'Any allergies?', pageType: 'chart', patientId },
  })
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return { status: res.status(), code: body.code }
}

test('the administrator switches the AI off and on; the AI follows', async ({ page, request }) => {
  const patient = await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family: `Testaisw${randomInt(100000, 999999)}`, given: ['Harper'] }, birthDate: `19${randomInt(40, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}` },
  })
  expect(patient.status(), await patient.text()).toBe(201)
  const patientId = ((await patient.json()) as { id: string }).id
  const doctor = await playwrightRequest.newContext({
    baseURL: process.env.SHRI_API_URL ?? 'https://localhost:8443', ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Dev-User': 'md' },
  })

  await page.goto(`${ADMIN}/`)
  await page.getByRole('button', { name: /Signed in as/ }).click()
  const clinic = page.getByRole('switch', { name: 'AI on for the clinic' })
  const summary = page.getByRole('switch', { name: SUMMARY })
  await expect(clinic).toBeVisible()
  if (!(await clinic.isChecked())) await clinic.click()
  await expect(clinic).toBeChecked()
  await expect(summary).toBeEnabled()

  // Off: the AI answers "switched off".
  if (await summary.isChecked()) await summary.click()
  await expect(summary).not.toBeChecked()
  await expect.poll(async () => (await askTheChart(doctor, patientId)).code).toBe('feature-disabled')

  // On again: the question is accepted.
  await summary.click()
  await expect(summary).toBeChecked()
  await expect.poll(async () => (await askTheChart(doctor, patientId)).status).toBe(202)
  await doctor.dispose()
})

test('the front desk has no AI switch', async ({ page }) => {
  await page.goto(`${DESK}/`)
  await page.getByRole('button', { name: /Signed in as/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'AI on for the clinic' })).toHaveCount(0)
})
